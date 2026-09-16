import { useEffect, useMemo, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AvatarState } from '../hooks/useAvatarAnimation';
import { HOLO_CYAN, HOLO_WHITE } from './palette';

interface Props {
  stateRef: MutableRefObject<AvatarState>;
}

const ringVert = /* glsl */ `
attribute float aT;
varying float vT;
varying float vDepth;
void main() {
  vT = aT;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vDepth = world.z;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const ringFrag = /* glsl */ `
uniform float uFlow;
uniform float uSpeed;
uniform float uPhase;
uniform float uReveal;
uniform float uStrength;
uniform float uBoost;
uniform float uDashes;
uniform vec3 uColor;
uniform vec3 uHighlight;
varying float vT;
varying float vDepth;
void main() {
  float t = fract(vT - uFlow * uSpeed + uPhase);
  // Two comet arcs travelling around the ring.
  float arc = pow(t, 9.0) + pow(fract(t + 0.5), 18.0) * 0.4;
  float dash = uDashes > 0.0 ? step(0.45, fract(vT * uDashes)) : 1.0;
  float base = 0.03 * dash;
  // Draw-in during startup.
  float reveal = smoothstep(vT - 0.05, vT, uReveal * 1.05);
  float depth = 0.35 + 0.65 * smoothstep(-1.8, 1.2, vDepth);
  float a = (base + arc * 0.7) * reveal * depth * uStrength * uBoost;
  vec3 c = mix(uColor, uHighlight, pow(t, 20.0));
  gl_FragColor = vec4(c, a);
}
`;

interface RingSpec {
  radius: number;
  rotation: [number, number, number];
  position: [number, number, number];
  speed: number;
  spin: number;
  strength: number;
  dashes: number;
  squash: number;
}

const RINGS: RingSpec[] = [
  { radius: 1.3, rotation: [Math.PI / 2 - 0.12, 0, 0.06], position: [0, 0.78, -0.1], speed: 0.05, spin: 0.018, strength: 0.7, dashes: 0, squash: 0.92 },
  { radius: 1.5, rotation: [Math.PI / 2 + 0.22, 0.1, -0.1], position: [0, -0.95, 0], speed: -0.032, spin: -0.012, strength: 0.45, dashes: 140, squash: 0.9 },
  { radius: 1.62, rotation: [0, 0, 0], position: [0, 0.04, -0.9], speed: 0.022, spin: 0.006, strength: 0.4, dashes: 0, squash: 1.0 },
  { radius: 2.05, rotation: [Math.PI / 2 - 0.3, -0.15, 0.2], position: [0, -0.1, -0.2], speed: 0.015, spin: 0.009, strength: 0.22, dashes: 220, squash: 0.95 },
];

function ringGeometry(radius: number, squash: number, segments = 384) {
  const pos = new Float32Array(segments * 3);
  const t = new Float32Array(segments);
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pos.set([Math.cos(a) * radius, Math.sin(a) * radius * squash, 0], i * 3);
    t[i] = i / segments;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  return geo;
}

export function EnergyRings({ stateRef }: Props) {
  const rings = useMemo(
    () =>
      RINGS.map((spec) => {
        const mat = new THREE.ShaderMaterial({
          vertexShader: ringVert,
          fragmentShader: ringFrag,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          uniforms: {
            uFlow: { value: 0 },
            uSpeed: { value: spec.speed },
            uPhase: { value: Math.random() },
            uReveal: { value: 0 },
            uStrength: { value: spec.strength },
            uBoost: { value: 1 },
            uDashes: { value: spec.dashes },
            uColor: { value: HOLO_CYAN.clone() },
            uHighlight: { value: HOLO_WHITE.clone() },
          },
        });
        const line = new THREE.LineLoop(ringGeometry(spec.radius, spec.squash), mat);
        line.rotation.set(...spec.rotation);
        line.position.set(...spec.position);
        line.renderOrder = 7;
        line.frustumCulled = false;
        return { spec, line, mat };
      }),
    [],
  );

  useEffect(
    () => () =>
      rings.forEach(({ line, mat }) => {
        line.geometry.dispose();
        mat.dispose();
      }),
    [rings],
  );

  useFrame((_, delta) => {
    const s = stateRef.current;
    // Listening lifts the rings and lets them flicker with your voice; speaking
    // rides his own output instead.
    const boost =
      s.glow + s.modes.listening * s.listen * 0.9 + s.modes.speaking * s.speech * 0.5;
    rings.forEach(({ spec, line, mat }, i) => {
      mat.uniforms.uFlow.value = s.flow;
      mat.uniforms.uBoost.value = boost;
      mat.uniforms.uReveal.value = THREE.MathUtils.clamp(s.rings * 1.25 - i * 0.08, 0, 1);
      // Thinking spins the shell up noticeably.
      line.rotateZ(spec.spin * delta * (1 + s.modes.thinking * 2.2));
    });
  });

  return (
    <group>
      {rings.map(({ line }, i) => (
        <primitive key={i} object={line} />
      ))}
    </group>
  );
}
