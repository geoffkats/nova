import { useEffect, useMemo, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { facePoint } from '../utils/faceField';
import type { AvatarState } from '../hooks/useAvatarAnimation';
import { HOLO_CYAN, HOLO_WHITE } from './palette';

interface Props {
  stateRef: MutableRefObject<AvatarState>;
}

/**
 * Procedural lips driven by jaw / aperture / width (not a single open slider).
 * Lower lip drops more than upper rises; corners stay nearly fixed — human bias.
 */
const mouthVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const mouthFrag = /* glsl */ `
uniform float uTime;
uniform float uJaw;
uniform float uAperture;
uniform float uWidth;
uniform float uActive;
uniform float uBreath;
uniform vec3 uColor;
uniform vec3 uHighlight;
varying vec2 vUv;

void main() {
  // Aspect: mouth is wider than tall; width uniform scales the X of the lip curve.
  vec2 p = (vUv - 0.5) * 2.0;
  p.x /= max(uWidth, 0.45);

  // Soft ellipse support — mouth width ~ half the plane.
  float rx = 0.92;
  float insideEllipse = 1.0 - (p.x * p.x) / (rx * rx);
  float w = max(insideEllipse, 0.0);
  // Corners stay put: high power keeps gap in the center.
  float wGap = pow(w, 1.65);

  float seamY = -0.04 + uBreath * 0.012;
  // Jaw opens the whole mouth; aperture is the faster lip gap.
  float open = clamp(uJaw * 0.55 + uAperture * 0.75, 0.0, 1.15);
  // Human bias: lower lip travels farther than upper.
  float upperY = seamY + open * 0.22 * wGap;
  float lowerY = seamY - open * 0.58 * wGap - uJaw * 0.06 * wGap;

  float fadeX = smoothstep(1.05, 0.42, abs(p.x));

  // Lip thickness as Gaussians on the curves.
  float upper = exp(-pow((p.y - upperY) * 30.0, 2.0));
  float lower = exp(-pow((p.y - lowerY) * 26.0, 2.0));

  // Cupid's bow on the upper outer contour.
  float bow =
    0.30 * w
    - 0.09 * exp(-p.x * p.x * 70.0)
    + open * 0.14 * wGap;
  float outerTop = exp(-pow((p.y - seamY - bow) * 22.0, 2.0)) * 0.28;

  float lowerCurve = 0.42 * w + open * 0.38 * wGap + uJaw * 0.05;
  float outerBot = exp(-pow((p.y - seamY + lowerCurve) * 18.0, 2.0)) * 0.2;

  // Darker interior only when meaningfully open.
  float inside = smoothstep(lowerY - 0.02, lowerY + 0.04, p.y)
               * smoothstep(upperY + 0.02, upperY - 0.04, p.y);
  float wave = 0.5 + 0.5 * sin(p.x * 18.0 + uTime * 8.0) * sin(p.x * 6.0 - uTime * 2.6);
  float waveLine = exp(-pow((p.y - mix(lowerY, upperY, 0.45) - (wave - 0.5) * open * 0.22 * w) * 36.0, 2.0));
  float interior = inside * (0.1 + waveLine * 0.45) * smoothstep(0.04, 0.18, open);

  // Closed seam when nearly shut — thin human rest line.
  float restSeam = exp(-pow((p.y - seamY) * 48.0, 2.0)) * (1.0 - smoothstep(0.02, 0.12, open)) * 0.55;

  float light = (upper + lower) * (0.55 + 0.45 * open)
              + outerTop + outerBot + interior + restSeam;
  vec3 col = mix(uColor, uHighlight, upper * 0.35 + lower * 0.25 + waveLine * inside * 0.35) * light;
  float a = light * fadeX * uActive;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

export function HolographicMouth({ stateRef }: Props) {
  // Slightly smaller plane — closer to ~⅓–½ inter-eye mouth width on the head.
  const geo = useMemo(() => new THREE.PlaneGeometry(0.34, 0.18), []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: mouthVert,
        fragmentShader: mouthFrag,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uTime: { value: 0 },
          uJaw: { value: 0 },
          uAperture: { value: 0 },
          uWidth: { value: 1 },
          uActive: { value: 0 },
          uBreath: { value: 0 },
          uColor: { value: HOLO_CYAN.clone() },
          uHighlight: { value: HOLO_WHITE.clone() },
        },
      }),
    [],
  );
  const position = useMemo(() => {
    const p = facePoint(0, -0.463);
    p.z += 0.045;
    return p;
  }, []);

  useEffect(
    () => () => {
      geo.dispose();
      mat.dispose();
    },
    [geo, mat],
  );

  useFrame(() => {
    const s = stateRef.current;
    const u = mat.uniforms;
    u.uTime.value = s.time;
    u.uJaw.value = s.mouthJaw;
    u.uAperture.value = s.mouthAperture;
    u.uWidth.value = s.mouthWidth;
    u.uBreath.value = s.breath;
    u.uActive.value = THREE.MathUtils.smoothstep(s.surface, 0.55, 1.0) * 0.92;
  });

  return <mesh geometry={geo} material={mat} position={position} renderOrder={5} />;
}
