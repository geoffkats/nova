import { useEffect, useMemo, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { facePoint } from '../utils/faceField';
import type { AvatarState } from '../hooks/useAvatarAnimation';
import { HOLO_CYAN, HOLO_WHITE } from './palette';

interface Props {
  stateRef: MutableRefObject<AvatarState>;
}

const mouthVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const mouthFrag = /* glsl */ `
uniform float uTime;
uniform float uOpen;
uniform float uActive;
uniform float uBreath;
uniform vec3 uColor;
uniform vec3 uHighlight;
varying vec2 vUv;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float w = max(1.0 - p.x * p.x, 0.0);
  float wOpen = pow(w, 1.4);

  float seamY = -0.02 + uBreath * 0.01;
  float upperY = seamY + uOpen * 0.28 * wOpen;
  float lowerY = seamY - uOpen * 0.5 * wOpen;

  float fadeX = smoothstep(1.0, 0.55, abs(p.x));
  float upper = exp(-pow((p.y - upperY) * 26.0, 2.0));
  float lower = exp(-pow((p.y - lowerY) * 26.0, 2.0));

  // Outer lip contours — faint, with a gentle cupid's bow.
  float bow = 0.36 * w - 0.07 * exp(-p.x * p.x * 60.0) + uOpen * 0.2 * wOpen;
  float outerTop = exp(-pow((p.y - seamY - bow) * 20.0, 2.0)) * 0.22;
  float outerBot = exp(-pow((p.y - seamY + 0.5 * w + uOpen * 0.45 * wOpen) * 18.0, 2.0)) * 0.16;

  // Inside of the mouth: a quiet waveform that only appears while open.
  float inside = smoothstep(lowerY - 0.01, lowerY + 0.05, p.y) * smoothstep(upperY + 0.01, upperY - 0.05, p.y);
  float wave = 0.5 + 0.5 * sin(p.x * 22.0 + uTime * 9.0) * sin(p.x * 7.0 - uTime * 3.0);
  float waveLine = exp(-pow((p.y - seamY - (wave - 0.5) * uOpen * 0.35 * w) * 40.0, 2.0));
  float interior = inside * (0.08 + waveLine * 0.5) * smoothstep(0.02, 0.15, uOpen);

  float light = (upper + lower) * (0.65 + 0.35 * uOpen) + outerTop + outerBot + interior;
  vec3 col = mix(uColor, uHighlight, upper * lower * 0.8 + waveLine * inside * 0.4) * light;
  float a = light * fadeX * uActive;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}
`;

export function HolographicMouth({ stateRef }: Props) {
  const geo = useMemo(() => new THREE.PlaneGeometry(0.4, 0.2), []);
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
          uOpen: { value: 0 },
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
    // Resting lips part very slightly on the inhale.
    u.uOpen.value = s.speech * 0.55 + Math.max(s.breath, 0) * 0.025;
    u.uBreath.value = s.breath;
    u.uActive.value = THREE.MathUtils.smoothstep(s.surface, 0.55, 1.0) * 0.9;
  });

  return <mesh geometry={geo} material={mat} position={position} renderOrder={5} />;
}
