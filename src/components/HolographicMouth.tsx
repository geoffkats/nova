import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { facePoint, headNormal } from '../utils/faceField';
import type { AvatarState } from '../hooks/useAvatarAnimation';
import { HOLO_CYAN, HOLO_WHITE } from './palette';

interface Props {
  stateRef: MutableRefObject<AvatarState>;
}

/**
 * Procedural lips driven by jaw / aperture / width (not a single open slider).
 * Lower lip drops more than upper rises; corners stay nearly fixed — human bias.
 * Position tracks the face field so speech jaw pulls the mouth with the chin.
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
uniform float uRound;
uniform float uSmile;
uniform float uActive;
uniform float uBreath;
uniform vec3 uColor;
uniform vec3 uHighlight;
varying vec2 vUv;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float round = clamp(uRound, 0.0, 1.0);
  p.x /= max(uWidth, 0.45) * mix(1.0, 0.78, round);

  float x = abs(p.x);
  float widthMask = 1.0 - smoothstep(0.76, 0.92, x);
  float shape = sqrt(max(1.0 - pow(x / 0.9, 2.0), 0.0));
  float jaw = clamp(uJaw, 0.0, 1.0);
  float open = clamp(jaw * 0.82 + uAperture * 0.96, 0.0, 1.0);
  // Lift the corners into a small smile while keeping the centre relaxed.
  float seam = -0.035 + uBreath * 0.01 + clamp(uSmile, 0.0, 1.0) * 0.055 * smoothstep(0.04, 0.82, x);

  // A soft cupid's bow and a fuller, lower lip give the mouth a real silhouette.
  float cupid = 0.026 * exp(-pow((x - 0.23) * 8.0, 2.0)) - 0.014 * exp(-pow(x * 14.0, 2.0));
  float upperOuter = seam + shape * (0.105 + cupid);
  float lowerOuter = seam - shape * (0.105 + open * 0.13 + jaw * 0.025);
  float upperInner = seam + open * shape * 0.15;
  float lowerInner = seam - (open * 0.78 + jaw * 0.12) * shape;

  float aa = max(fwidth(p.y) * 1.8, 0.008);
  float openingGate = smoothstep(0.045, 0.19, open);
  float cavityTop = 1.0 - smoothstep(upperInner - aa, upperInner + aa, p.y);
  float cavityBottom = smoothstep(lowerInner - aa, lowerInner + aa, p.y);
  float cavity = cavityTop * cavityBottom * widthMask * openingGate;

  float upperLip = exp(-pow((p.y - upperOuter) * 26.0, 2.0)) * widthMask;
  float lowerLip = exp(-pow((p.y - lowerOuter) * 23.0, 2.0)) * widthMask;
  float seamLine = exp(-pow((p.y - seam) * 42.0, 2.0)) * widthMask * (1.0 - smoothstep(0.04, 0.16, open));
  float lipVolume = exp(-pow((p.y - (seam - shape * 0.035)) * 9.0, 2.0)) * lowerLip;

  // A narrow upper tooth plane and a soft tongue arc appear only on open vowels.
  float toothY = mix(upperInner, lowerInner, 0.19);
  float toothBand = exp(-pow((p.y - toothY) * 34.0, 2.0)) * cavity;
  float toothCell = fract((p.x + 0.82) * 5.8);
  float toothGaps = 1.0 - smoothstep(0.025, 0.07, min(toothCell, 1.0 - toothCell));
  float teeth = toothBand * (1.0 - toothGaps * 0.65) * smoothstep(0.13, 0.32, open);
  float tongueY = lowerInner + open * 0.12 * shape;
  float tongue = exp(-pow((p.y - tongueY) * 30.0, 2.0)) * cavity * smoothstep(0.38, 0.7, open) * 0.34;

  float lipGlow = upperLip * 0.62 + lowerLip * (0.48 + lipVolume * 0.2) + seamLine * 0.46;
  vec3 lipColor = mix(uColor, uHighlight, clamp(upperLip * 0.32 + lowerLip * 0.18, 0.0, 0.7));
  vec3 mouthColor = lipColor * lipGlow + uHighlight * (teeth * 0.88 + tongue * 0.2);
  vec3 cavityColor = vec3(0.003, 0.012, 0.022);
  vec3 color = mix(mouthColor, cavityColor, cavity * 0.96);
  float alpha = max(lipGlow, cavity * 0.94);
  alpha = max(alpha, teeth * 0.92) * uActive;
  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
`;

const _pos = new THREE.Vector3();
const _nor = new THREE.Vector3();

export function HolographicMouth({ stateRef }: Props) {
  const meshRef = useRef<THREE.Mesh>(null);
  const geo = useMemo(() => new THREE.PlaneGeometry(0.38, 0.26), []);
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: mouthVert,
        fragmentShader: mouthFrag,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.NormalBlending,
        uniforms: {
          uTime: { value: 0 },
          uJaw: { value: 0 },
          uAperture: { value: 0 },
          uWidth: { value: 1 },
          uRound: { value: 0 },
          uSmile: { value: 0 },
          uActive: { value: 0 },
          uBreath: { value: 0 },
          uColor: { value: HOLO_CYAN.clone() },
          uHighlight: { value: HOLO_WHITE.clone() },
        },
      }),
    [],
  );

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
    u.uRound.value = s.mouthRoundness;
    u.uSmile.value = s.mouthSmile;
    u.uBreath.value = s.breath;
    u.uActive.value = THREE.MathUtils.smoothstep(s.surface, 0.55, 1.0) * 0.92;

    const mesh = meshRef.current;
    if (!mesh) return;
    // Track face field; jaw pulls mouth down with the chin. Mild x asymmetry.
    const fy = -0.463 - s.mouthJaw * 0.14;
    facePoint(0.015, fy, _pos);
    // Approximate normal via neighbor samples for slight plane tilt.
    headNormal(Math.asin(THREE.MathUtils.clamp(0.015 / Math.cos(Math.asin(THREE.MathUtils.clamp(fy, -0.999, 0.999))), -0.999, 0.999)), Math.asin(THREE.MathUtils.clamp(fy, -0.999, 0.999)), _nor);
    _pos.addScaledVector(_nor, 0.028);
    mesh.position.copy(_pos);
    mesh.rotation.x = -0.08 - s.mouthJaw * 0.18;
    mesh.rotation.y = 0.04;
  });

  return <mesh ref={meshRef} geometry={geo} material={mat} renderOrder={5} />;
}
