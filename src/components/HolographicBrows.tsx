import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { facePoint } from '../utils/faceField';
import type { AvatarState } from '../hooks/useAvatarAnimation';
import { HOLO_CYAN, HOLO_WHITE } from './palette';

interface Props {
  stateRef: MutableRefObject<AvatarState>;
}

const BROW_W = 0.4;
const BROW_H = 0.18;

const browVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const browFrag = /* glsl */ `
uniform float uTime;
uniform float uRaise;
uniform float uFurrow;
uniform float uActive;
uniform float uSide;
uniform vec3 uColor;
uniform vec3 uHighlight;
varying vec2 vUv;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float xo = p.x * uSide;   // > 0 toward the temple, < 0 toward the nose

  // Shallow arch peaking just outboard of centre, tail settling at the temple.
  float arch = (0.3 * (1.0 - xo * xo) + 0.1 * xo) * 0.5;
  // Furrow drags only the inner third down, so the pair reads as a V.
  float inner = smoothstep(0.55, -1.0, xo);
  float y0 = arch + uRaise * 0.45 - uFurrow * 0.5 * inner;

  // Heavier at the inner head, tapering to a fine tail.
  float thick = mix(21.0, 50.0, smoothstep(-0.7, 1.0, xo));
  float core = exp(-pow((p.y - y0) * thick, 2.0));

  // Hair-stroke striations riding along the arc.
  float strokes = 0.72 + 0.28 * sin(xo * 26.0 - uTime * 0.5);

  // Faint ridge contour tracking below the brow.
  float ridge = exp(-pow((p.y - y0 + 0.3) * 13.0, 2.0)) * 0.16;

  float fade = smoothstep(1.0, 0.7, abs(p.x)) * mix(1.0, 0.75, smoothstep(0.4, 1.0, xo));

  // Kept brighter and whiter than the surface contours so the brow reads as a
  // feature rather than another topographic line across the forehead.
  float light = core * strokes * 0.95 + ridge;
  float hot = clamp(uFurrow * 0.5 + uRaise * 0.35, 0.0, 1.0);
  vec3 col = mix(uColor, uHighlight, core * (0.35 + hot * 0.5)) * light;
  gl_FragColor = vec4(col, clamp(light * fade, 0.0, 1.0) * uActive);
}
`;

function makeBrowMaterial(side: number) {
  return new THREE.ShaderMaterial({
    vertexShader: browVert,
    fragmentShader: browFrag,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uRaise: { value: 0 },
      uFurrow: { value: 0 },
      uActive: { value: 0 },
      uSide: { value: side },
      uColor: { value: HOLO_CYAN.clone() },
      uHighlight: { value: HOLO_WHITE.clone() },
    },
  });
}

export function HolographicBrows({ stateRef }: Props) {
  const geo = useMemo(() => new THREE.PlaneGeometry(BROW_W, BROW_H), []);
  const left = useMemo(() => makeBrowMaterial(-1), []);
  const right = useMemo(() => makeBrowMaterial(1), []);
  const placement = useMemo(() => {
    const l = facePoint(-0.34, 0.295);
    const r = facePoint(0.36, 0.305);
    l.z += 0.042;
    r.z += 0.04;
    return { l, r };
  }, []);

  const rig = useRef({
    speechEnv: 0,
    furrow: 0,
    punctStart: -10,
    nextPunct: 4.5,
    cock: 0,
    cockTarget: 0,
    cockHold: 0,
    nextCock: 9,
  });

  useEffect(
    () => () => {
      geo.dispose();
      left.dispose();
      right.dispose();
    },
    [geo, left, right],
  );

  useFrame((_, delta) => {
    const s = stateRef.current;
    const r = rig.current;
    const dt = Math.min(delta, 0.1);

    // Speech envelope: snaps up on phrase onset, releases slowly, so the brows
    // ride the phrase rather than flickering with every syllable.
    r.speechEnv = THREE.MathUtils.damp(r.speechEnv, s.speech, s.speech > r.speechEnv ? 12 : 2.5, dt);

    // Conversational lift, independent of speech.
    if (s.time > r.nextPunct) {
      r.punctStart = s.time;
      r.nextPunct = s.time + 5 + Math.random() * 7;
    }
    const pt = (s.time - r.punctStart) / 0.7;
    const punct = pt >= 0 && pt <= 1 ? Math.sin(pt * Math.PI) : 0;

    // Occasional single-brow cock, held for a beat then released.
    if (s.time > r.nextCock) {
      r.cockTarget = (Math.random() < 0.5 ? -1 : 1) * (0.1 + Math.random() * 0.16);
      r.cockHold = s.time + 1.6 + Math.random() * 1.4;
      r.nextCock = s.time + 8 + Math.random() * 9;
    }
    if (s.time > r.cockHold) r.cockTarget = 0;
    r.cock = THREE.MathUtils.damp(r.cock, r.cockTarget, 4, dt);

    r.furrow = THREE.MathUtils.damp(r.furrow, s.glitch > 0.5 ? 1 : 0, 9, dt);

    // Lids pull the brow down a touch as they close. Listening reads as an
    // attentive lift, thinking as a sustained furrow of concentration.
    const raise =
      r.speechEnv * 0.5 + punct * 0.3 - s.blink * 0.08 + s.modes.listening * 0.3;
    const furrow = Math.min(r.furrow * 0.9 + s.modes.thinking * 0.5, 1);
    const active = THREE.MathUtils.smoothstep(s.eyes, 0.15, 1.0) * 0.9;

    for (const [m, sign] of [
      [left, -1],
      [right, 1],
    ] as const) {
      const u = m.uniforms;
      u.uTime.value = s.time;
      u.uRaise.value = THREE.MathUtils.clamp(raise + r.cock * sign, -0.35, 1.0);
      u.uFurrow.value = furrow;
      u.uActive.value = active;
    }
  });

  return (
    <group>
      <mesh geometry={geo} material={left} position={placement.l} rotation={[0, -0.22, 0]} renderOrder={6} />
      <mesh geometry={geo} material={right} position={placement.r} rotation={[0, 0.22, 0]} renderOrder={6} />
    </group>
  );
}
