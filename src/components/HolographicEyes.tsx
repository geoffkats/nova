import { useEffect, useMemo, useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { facePoint } from '../utils/faceField';
import type { AvatarState } from '../hooks/useAvatarAnimation';
import { useBlink } from '../hooks/useBlink';
import { HOLO_CYAN, HOLO_WHITE } from './palette';

interface Props {
  stateRef: MutableRefObject<AvatarState>;
}

const EYE_W = 0.34;
const EYE_H = 0.17;

/** Scratch for the blended gaze direction — avoids a per-frame allocation. */
const look = new THREE.Vector2();

const eyeVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const eyeFrag = /* glsl */ `
uniform float uTime;
uniform float uBlink;
uniform float uActive;
uniform float uGlow;
uniform float uSide;
uniform vec2 uLook;
uniform vec3 uColor;
uniform vec3 uHighlight;
varying vec2 vUv;

void main() {
  vec2 p = (vUv - 0.5) * 2.0;             // -1..1 across the plane
  vec2 q = vec2(p.x, p.y * 0.5);          // isotropic (plane is 2:1)

  // Almond aperture; slightly lifted outer corner.
  float open = 1.0 - uBlink;
  float xs = p.x * uSide;
  float shape = max(1.0 - p.x * p.x, 0.0);
  float yOff = xs * 0.06;
  float hTop = (0.48 * open + 0.004) * shape * (1.0 + 0.1 * xs);
  float hBot = (0.34 * open + 0.004) * shape;
  float py = p.y - yOff;
  float aperture = smoothstep(0.0, 0.06, hTop - py) * smoothstep(0.0, 0.06, py + hBot);

  // Lid contours remain visible as fine lines (the closed eye is a single glowing seam).
  float lidTop = exp(-pow((py - hTop) * 30.0, 2.0));
  float lidBot = exp(-pow((py + hBot) * 34.0, 2.0)) * 0.45;
  float corners = smoothstep(1.0, 0.75, abs(p.x));
  float lids = (lidTop * 0.8 + lidBot * 0.9) * corners;

  // Iris with fine radial structure and a slow rotating segment.
  vec2 iq = q - uLook * vec2(0.18, 0.08);
  float r = length(iq);
  float ang = atan(iq.y, iq.x);
  float ring = exp(-pow((r - 0.2) * 40.0, 2.0));
  float innerRing = exp(-pow((r - 0.14) * 60.0, 2.0)) * 0.5;
  float fibres = (0.5 + 0.5 * sin(ang * 36.0 + uTime * 0.4)) * smoothstep(0.21, 0.1, r) * smoothstep(0.05, 0.09, r);
  float segment = smoothstep(0.7, 1.0, sin(ang * 3.0 - uTime * 0.7)) * exp(-pow((r - 0.285) * 40.0, 2.0)) * 0.6;
  float fill = smoothstep(0.26, 0.0, r) * 0.22;
  float pupil = smoothstep(0.05, 0.012, r);
  float glint = smoothstep(0.035, 0.0, length(iq - vec2(-0.06, 0.05)));

  float irisLight = ring * 0.7 + innerRing * 0.6 + fibres * 0.3 + fill + segment * 0.5;
  vec3 col = uColor * irisLight * uGlow + uHighlight * (pupil * 0.9 + glint * 0.6) * uGlow;
  float a = (irisLight * 0.9 + pupil + glint) * aperture;

  col += uColor * lids * 1.15;
  a += lids;

  // Socket ambience — darker well so the iris sits in a recess, not on the skin.
  float ambient = aperture * 0.045;
  col += uColor * ambient;
  a += ambient;

  // Soft orbital rim (socket edge) — reads depth without solid mesh.
  float rim = exp(-pow((length(q) - 0.55) * 14.0, 2.0)) * 0.22 * corners * (0.55 + 0.45 * open);
  col += uColor * rim;
  a += rim;

  // Soft halo around the eye, hidden when blinking.
  float halo = exp(-length(q) * 5.0) * 0.09 * open * corners;
  col += uColor * halo;
  a += halo;

  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0) * uActive);
}
`;

function makeEyeMaterial(side: number) {
  return new THREE.ShaderMaterial({
    vertexShader: eyeVert,
    fragmentShader: eyeFrag,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uBlink: { value: 0 },
      uActive: { value: 0 },
      uGlow: { value: 1 },
      uSide: { value: side },
      uLook: { value: new THREE.Vector2() },
      uColor: { value: HOLO_CYAN.clone() },
      uHighlight: { value: HOLO_WHITE.clone() },
    },
  });
}

export function HolographicEyes({ stateRef }: Props) {
  useBlink(stateRef);

  const geo = useMemo(() => new THREE.PlaneGeometry(EYE_W, EYE_H), []);
  const left = useMemo(() => makeEyeMaterial(-1), []);
  const right = useMemo(() => makeEyeMaterial(1), []);
  const placement = useMemo(() => {
    // Seat deeper in the sockets; slight asymmetry so the face isn't a mirror.
    const l = facePoint(-0.34, 0.135);
    const r = facePoint(0.355, 0.142);
    l.z += 0.038;
    r.z += 0.036;
    return { l, r };
  }, []);

  const saccade = useRef({ target: new THREE.Vector2(), current: new THREE.Vector2(), next: 2.5 });

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
    const sc = saccade.current;
    if (s.time > sc.next) {
      // Mostly hold near centre, with small, quick glances.
      sc.target.set((Math.random() - 0.5) * 0.9, (Math.random() - 0.5) * 0.6);
      if (Math.random() < 0.45) sc.target.set(0, 0);
      sc.next = s.time + 1.8 + Math.random() * 3.2;
    }
    sc.current.x = THREE.MathUtils.damp(sc.current.x, sc.target.x, 14, delta);
    sc.current.y = THREE.MathUtils.damp(sc.current.y, sc.target.y, 14, delta);

    // Listening pins the gaze forward; thinking lets it wander up and off-axis.
    // Both suppress the idle saccades rather than fighting them.
    const { listening, thinking } = s.modes;
    const wander = 1 - Math.min(listening + thinking, 1);
    const awayX = Math.sin(s.time * 0.31) * 0.5 - 0.35;
    const awayY = 0.42 + Math.sin(s.time * 0.23 + 1.1) * 0.12;
    look.set(sc.current.x * wander + awayX * thinking, sc.current.y * wander + awayY * thinking);

    // Glow breathes slowly and flares briefly while "speaking".
    const glow =
      (0.85 + 0.12 * Math.sin(s.time * 0.9) + 0.08 * Math.sin(s.time * 2.3 + 1.0) + s.speech * 0.12) *
      s.glow;
    // Eye activation: brief over-bright ignition, then settle.
    const ignite = s.eyes * (1 + 0.6 * Math.sin(Math.min(s.eyes, 1) * Math.PI));

    for (const m of [left, right]) {
      m.uniforms.uTime.value = s.time;
      m.uniforms.uBlink.value = s.eyes < 1 ? 1 - s.eyes : s.blink;
      m.uniforms.uActive.value = ignite;
      m.uniforms.uGlow.value = glow;
      (m.uniforms.uLook.value as THREE.Vector2).copy(look);
    }
  });

  return (
    <group>
      <mesh geometry={geo} material={left} position={placement.l} rotation={[0, -0.22, 0]} renderOrder={6} />
      <mesh geometry={geo} material={right} position={placement.r} rotation={[0, 0.22, 0]} renderOrder={6} />
    </group>
  );
}
