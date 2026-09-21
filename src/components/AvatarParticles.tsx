import { useEffect, useMemo, type MutableRefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { featureWeight, headNormal, headPoint, U_RANGE, V_RANGE } from '../utils/faceField';
import type { AvatarState } from '../hooks/useAvatarAnimation';
import { HOLO_CYAN, HOLO_WHITE } from './palette';
import type { Quality } from '../quality';

interface Props {
  stateRef: MutableRefObject<AvatarState>;
  quality: Quality;
}

/* ------------------------------------------------------------------ */
/* Face particles: sampled on the head surface, fly in on startup,     */
/* drift, shed from the edges and breathe with the avatar.             */
/* ------------------------------------------------------------------ */

const faceVert = /* glsl */ `
uniform float uTime;
uniform float uForm;
uniform float uAppear;
uniform float uDisperse;
uniform float uListen;
uniform float uSize;
uniform float uPixelRatio;
attribute vec3 aStart;
attribute vec3 aNormal;
attribute vec4 aRandom;
attribute float aShed;
varying float vAlpha;
varying float vHot;

vec3 rotY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

void main() {
  float delay = aRandom.x * 0.42;
  float p = clamp((uForm - delay) / 0.58, 0.0, 1.0);
  float e = p < 0.5 ? 4.0 * p * p * p : 1.0 - pow(-2.0 * p + 2.0, 3.0) * 0.5;

  vec3 target = position;

  // Shedding: some particles continuously lift off along the normal and fade.
  float shedT = fract(uTime * (0.035 + aRandom.y * 0.07) + aRandom.z);
  target += aNormal * aShed * shedT * (0.12 + aRandom.w * 0.4);
  target.y += aShed * shedT * 0.08;

  // Idle drift (tiny).
  vec3 ph = aRandom.xyz * 40.0;
  target += vec3(sin(uTime * 0.6 + ph.x), cos(uTime * 0.5 + ph.y), sin(uTime * 0.45 + ph.z)) * 0.005;

  // Occasional breath-out dispersion.
  target += aNormal * uDisperse * (0.03 + aRandom.w * 0.12);

  // Your voice lifts the skin particles off the surface in time with it.
  target += aNormal * uListen * (0.012 + aRandom.w * 0.03);

  // Swirl in from the start cloud.
  vec3 pos = mix(aStart, target, e);
  pos = rotY(pos, (1.0 - e) * (aRandom.y - 0.5) * 5.0);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float depth = 0.3 + 0.7 * smoothstep(-0.8, 0.55, position.z);
  float shedFade = 1.0 - shedT * aShed;
  vAlpha = uAppear * depth * shedFade * mix(0.35, 1.0, smoothstep(0.0, 0.25, p));
  vHot = step(0.965, aRandom.w);

  float size = uSize * (0.55 + aRandom.w * 0.9) * (1.0 + vHot * 0.8);
  gl_PointSize = size * uPixelRatio * (1.0 / -mv.z);
}
`;

const pointFrag = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uHighlight;
uniform float uIntensity;
varying float vAlpha;
varying float vHot;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float soft = smoothstep(0.5, 0.0, d);
  float core = smoothstep(0.2, 0.0, d);
  float a = (soft * 0.35 + core * 0.55) * vAlpha;
  if (a < 0.003) discard;
  vec3 c = mix(uColor, uHighlight, core * 0.5 + vHot * 0.4) * uIntensity;
  gl_FragColor = vec4(c, a);
}
`;

/* ------------------------------------------------------------------ */
/* Halo particles: orbit the head in a loose shell and periodically    */
/* converge toward it.                                                  */
/* ------------------------------------------------------------------ */

const haloVert = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uAppear;
uniform float uConverge;
uniform float uSize;
uniform float uPixelRatio;
attribute vec4 aOrbit;   // radius, angle, height, speed
attribute vec4 aRandom;
varying float vAlpha;
varying float vHot;
void main() {
  float r = aOrbit.x * mix(1.0, 0.8, uConverge * aRandom.x);
  float ang = aOrbit.y + uFlow * aOrbit.w / r;
  float y = aOrbit.z + sin(uTime * 0.3 + aRandom.y * 20.0) * 0.05;
  vec3 pos = vec3(cos(ang) * r, y, sin(ang) * r * 0.85);
  // enter from further out during startup
  pos *= mix(2.2, 1.0, uAppear);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  float front = 0.45 + 0.55 * smoothstep(-1.5, 1.0, pos.z);
  float fadeY = 1.0 - smoothstep(0.9, 1.6, abs(y));
  float twinkle = 0.6 + 0.4 * sin(uTime * (0.8 + aRandom.z * 2.0) + aRandom.w * 30.0);
  vAlpha = uAppear * front * fadeY * twinkle * 0.5;
  vHot = step(0.985, aRandom.w);
  gl_PointSize = uSize * (0.5 + aRandom.z) * uPixelRatio * (1.0 / -mv.z);
}
`;

/* Atmospheric dust far behind the head. */
const dustVert = /* glsl */ `
uniform float uTime;
uniform float uAppear;
uniform float uSize;
uniform float uPixelRatio;
attribute vec4 aRandom;
varying float vAlpha;
varying float vHot;
void main() {
  vec3 pos = position;
  pos.y += mod(uTime * (0.01 + aRandom.x * 0.02) + aRandom.y * 6.0, 6.0) - 3.0;
  pos.x += sin(uTime * 0.1 + aRandom.z * 10.0) * 0.1;
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  vAlpha = uAppear * (0.12 + aRandom.w * 0.18) * (1.0 - smoothstep(2.2, 3.0, abs(pos.y)));
  vHot = 0.0;
  gl_PointSize = uSize * (0.4 + aRandom.w) * uPixelRatio * (1.0 / -mv.z);
}
`;

function pointsMaterial(vertexShader: string, size: number, intensity = 1) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader: pointFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uForm: { value: 0 },
      uAppear: { value: 0 },
      uDisperse: { value: 0 },
      uListen: { value: 0 },
      uConverge: { value: 0 },
      uSize: { value: size },
      uPixelRatio: { value: 1 },
      uIntensity: { value: intensity },
      uColor: { value: HOLO_CYAN.clone() },
      uHighlight: { value: HOLO_WHITE.clone() },
    },
  });
}

function buildFaceParticles(count: number) {
  const pos = new Float32Array(count * 3);
  const start = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const rnd = new Float32Array(count * 4);
  const shed = new Float32Array(count);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const dir = new THREE.Vector3();

  let i = 0;
  let guard = 0;
  while (i < count && guard < count * 40) {
    guard++;
    const u = THREE.MathUtils.lerp(U_RANGE[0], U_RANGE[1], Math.random());
    // area-uniform latitude
    const v = Math.asin(THREE.MathUtils.lerp(Math.sin(V_RANGE[0]), Math.sin(V_RANGE[1]), Math.random()));
    // Stronger feature gate: cheeks / crown reject more often.
    if (Math.random() * 1.35 > featureWeight(u, v)) continue;

    headPoint(u, v, p);
    headNormal(u, v, n);

    // Loose layering: most sit on the skin, a few float just above it.
    const lift = Math.random() < 0.85 ? (Math.random() - 0.5) * 0.012 : Math.random() * 0.06;
    p.addScaledVector(n, lift);

    pos.set([p.x, p.y, p.z], i * 3);
    nor.set([n.x, n.y, n.z], i * 3);

    dir.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const radius = 2.5 + Math.random() * 3.5;
    start.set([dir.x * radius, dir.y * radius * 0.8, dir.z * radius - 1.0], i * 3);

    rnd.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);

    // Edges of the hologram shed more than the face centre.
    const edge =
      THREE.MathUtils.smoothstep(Math.abs(u), 1.6, 2.4) + THREE.MathUtils.smoothstep(-v, 0.9, 1.3);
    shed[i] = Math.random() < 0.12 + edge * 0.6 ? 0.5 + Math.random() * 0.5 : 0;
    i++;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, i * 3), 3));
  geo.setAttribute('aStart', new THREE.BufferAttribute(start.subarray(0, i * 3), 3));
  geo.setAttribute('aNormal', new THREE.BufferAttribute(nor.subarray(0, i * 3), 3));
  geo.setAttribute('aRandom', new THREE.BufferAttribute(rnd.subarray(0, i * 4), 4));
  geo.setAttribute('aShed', new THREE.BufferAttribute(shed.subarray(0, i), 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 7);
  return geo;
}

function buildHalo(count: number) {
  const orbit = new Float32Array(count * 4);
  const rnd = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const r = 1.05 + Math.pow(Math.random(), 1.6) * 1.2;
    const y = (Math.random() - 0.5) * 2.4 * Math.pow(Math.random(), 0.7);
    const speed = (0.03 + Math.random() * 0.08) * (Math.random() < 0.8 ? 1 : -1);
    orbit.set([r, Math.random() * Math.PI * 2, y, speed], i * 4);
    rnd.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aOrbit', new THREE.BufferAttribute(orbit, 4));
  geo.setAttribute('aRandom', new THREE.BufferAttribute(rnd, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 7);
  return geo;
}

function buildDust(count: number) {
  const pos = new Float32Array(count * 3);
  const rnd = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    pos.set([(Math.random() - 0.5) * 12, (Math.random() - 0.5) * 6, -2 - Math.random() * 6], i * 3);
    rnd.set([Math.random(), Math.random(), Math.random(), Math.random()], i * 4);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aRandom', new THREE.BufferAttribute(rnd, 4));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -5), 12);
  return geo;
}

export function AvatarParticles({ stateRef, quality }: Props) {
  const dpr = useThree((s) => s.viewport.dpr);

  const faceGeo = useMemo(() => buildFaceParticles(quality.faceParticles), [quality.faceParticles]);
  const haloGeo = useMemo(() => buildHalo(quality.haloParticles), [quality.haloParticles]);
  const faceMat = useMemo(() => pointsMaterial(faceVert, 14.5, 0.95), []);
  const haloMat = useMemo(() => pointsMaterial(haloVert, 11, 0.78), []);

  useEffect(() => () => faceGeo.dispose(), [faceGeo]);
  useEffect(() => () => haloGeo.dispose(), [haloGeo]);
  useEffect(
    () => () => {
      faceMat.dispose();
      haloMat.dispose();
    },
    [faceMat, haloMat],
  );

  useFrame(() => {
    const s = stateRef.current;
    const f = faceMat.uniforms;
    f.uTime.value = s.time;
    f.uFlow.value = s.flow;
    f.uForm.value = s.form;
    f.uAppear.value = s.appear;
    f.uDisperse.value = s.disperse;
    f.uListen.value = s.modes.listening * s.listen;
    f.uPixelRatio.value = dpr;
    // Particles hand over part of the brightness to the surface once it exists.
    f.uIntensity.value = (1.1 - s.surface * 0.35) * s.glow;

    const h = haloMat.uniforms;
    h.uTime.value = s.time;
    h.uFlow.value = s.flow;
    h.uAppear.value = THREE.MathUtils.smoothstep(s.time, 1.2, 3.0);
    // Thinking draws the shell inward as well as speeding it up.
    h.uConverge.value = Math.min(s.converge + s.modes.thinking * 0.45, 1);
    h.uPixelRatio.value = dpr;
  });

  return (
    <group>
      <points geometry={faceGeo} material={faceMat} renderOrder={3} frustumCulled={false} />
      <points geometry={haloGeo} material={haloMat} renderOrder={4} frustumCulled={false} />
    </group>
  );
}

/** Background atmosphere — kept outside the head group so it does not follow head motion. */
export function AtmosphericDust({ stateRef, quality }: Props) {
  const dpr = useThree((s) => s.viewport.dpr);
  const geo = useMemo(() => buildDust(quality.dustParticles), [quality.dustParticles]);
  const mat = useMemo(() => pointsMaterial(dustVert, 22, 0.7), []);
  useEffect(() => () => geo.dispose(), [geo]);
  useEffect(() => () => mat.dispose(), [mat]);

  useFrame(() => {
    const s = stateRef.current;
    mat.uniforms.uTime.value = s.time;
    mat.uniforms.uAppear.value = s.appear;
    mat.uniforms.uPixelRatio.value = dpr;
  });

  return <points geometry={geo} material={mat} renderOrder={0} frustumCulled={false} />;
}
