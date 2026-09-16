import { useRef, type MutableRefObject, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/** Behaviour modes. Driven externally — later by the voice loop, for now by keys. */
export type AvatarMode = 'idle' | 'listening' | 'thinking' | 'speaking';

export const AVATAR_MODES: readonly AvatarMode[] = ['idle', 'listening', 'thinking', 'speaking'];

/** Shared, mutable per-frame state. Lives in a ref — never in React state. */
export interface AvatarState {
  time: number;
  /** Startup channels, each 0 → 1 */
  appear: number;
  form: number;
  surface: number;
  eyes: number;
  rings: number;
  settle: number;
  /** Idle channels */
  breath: number;
  disperse: number;
  converge: number;
  blink: number;
  speech: number;
  /** Rare burst signal, 0.08 at rest and 1 during a glitch. */
  glitch: number;
  /** Behaviour mode weights, each 0 → 1. Crossfade on a mode change. */
  modes: Record<AvatarMode, number>;
  /** Incoming mic level, 0–1. Drives the listening visuals. */
  listen: number;
  /**
   * Energy-flow clock, in seconds but advancing at a mode-dependent rate.
   * Travelling bands and comet arcs read this instead of `time` so they can
   * change speed without the jump that scaling `time` would produce.
   */
  flow: number;
  /** Blended brightness multiplier shared by the surface, rings and particles. */
  glow: number;
}

export const createAvatarState = (): AvatarState => ({
  time: 0,
  appear: 0,
  form: 0,
  surface: 0,
  eyes: 0,
  rings: 0,
  settle: 0,
  breath: 0,
  disperse: 0,
  converge: 0,
  blink: 0,
  speech: 0,
  glitch: 0,
  modes: { idle: 1, listening: 0, thinking: 0, speaking: 0 },
  listen: 0,
  flow: 0,
  glow: 1,
});

const smooth = (e0: number, e1: number, x: number) => {
  const t = THREE.MathUtils.clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Timeline of the ~3 s materialisation sequence (seconds). */
const TIMELINE = {
  appear: [0.15, 0.7],
  form: [0.3, 2.1],
  surface: [1.05, 2.3],
  eyes: [1.85, 2.4],
  rings: [2.0, 3.0],
  settle: [2.3, 3.2],
} as const;

interface Options {
  headRef: RefObject<THREE.Group | null>;
  /** Optional external speech level (0–1). When provided, it replaces the simulated speech. */
  audioLevelRef?: MutableRefObject<number>;
  /** Optional mic level (0–1) for the listening visuals. */
  inputLevelRef?: MutableRefObject<number>;
  /** Target behaviour mode. Defaults to idle when not supplied. */
  modeRef?: MutableRefObject<AvatarMode>;
  reducedMotion?: boolean;
}

export function useAvatarAnimation({
  headRef,
  audioLevelRef,
  inputLevelRef,
  modeRef,
  reducedMotion = false,
}: Options) {
  const state = useRef<AvatarState>(createAvatarState());
  // Dev aid: `?t=4` starts the timeline 4 s in (skips the intro when tuning idle visuals).
  const offsetApplied = useRef(false);

  const rig = useRef({
    mouse: new THREE.Vector2(),
    tilt: 0,
    tiltTarget: 0,
    nextTilt: 5,
    nextPulse: 7,
    pulseStart: -100,
    speaking: false,
    nextSpeechToggle: 3.6,
    speechEnv: 0,
  });

  useFrame(({ pointer, camera }, rawDelta) => {
    const s = state.current;
    const r = rig.current;
    const dt = Math.min(rawDelta, 0.1); // avoid jumps after tab switches
    if (!offsetApplied.current) {
      offsetApplied.current = true;
      const q = Number(new URLSearchParams(window.location.search).get('t'));
      if (Number.isFinite(q) && q > 0) s.time = q;
      s.flow = s.time;
    }
    s.time += dt;
    const t = s.time;

    s.appear = smooth(TIMELINE.appear[0], TIMELINE.appear[1], t);
    s.form = THREE.MathUtils.clamp((t - TIMELINE.form[0]) / (TIMELINE.form[1] - TIMELINE.form[0]), 0, 1);
    s.surface = smooth(TIMELINE.surface[0], TIMELINE.surface[1], t);
    s.eyes = smooth(TIMELINE.eyes[0], TIMELINE.eyes[1], t);
    s.rings = smooth(TIMELINE.rings[0], TIMELINE.rings[1], t);
    s.settle = smooth(TIMELINE.settle[0], TIMELINE.settle[1], t);

    const motion = reducedMotion ? 0.25 : 1;

    // Rare, brief glitch bursts. Shared so surface and brows react on the same beat.
    const g = Math.sin(t * 0.73) * Math.sin(t * 1.91 + 2.0);
    s.glitch = g > 0.93 ? 1 : 0.08;

    // Modes crossfade rather than switch, so a transition reads as the same
    // character shifting attention instead of a different thing appearing.
    const target = modeRef?.current ?? 'idle';
    for (const m of AVATAR_MODES) {
      s.modes[m] = THREE.MathUtils.damp(s.modes[m], m === target ? 1 : 0, 6, dt);
    }
    const { listening, thinking, speaking } = s.modes;

    s.listen = inputLevelRef ? THREE.MathUtils.damp(s.listen, inputLevelRef.current, 18, dt) : 0;
    s.flow += dt * (1 + thinking * 1.6 + speaking * 0.5 + listening * 0.15) * motion;
    s.glow = 1 + listening * 0.22 + speaking * 0.3 + thinking * 0.08;

    // Breathing: ~5.2 s cycle, eased so exhale lingers.
    const phase = (t / 5.2) * Math.PI * 2;
    s.breath = Math.sin(phase) * 0.8 + Math.sin(phase * 2 + 0.6) * 0.2;

    // Occasional particle disperse → reconverge pulse.
    if (t > r.nextPulse) {
      r.pulseStart = t;
      r.nextPulse = t + 9 + Math.random() * 6;
    }
    const pulseT = (t - r.pulseStart) / 3.2;
    const pulse = pulseT >= 0 && pulseT <= 1 ? Math.sin(pulseT * Math.PI) : 0;
    s.disperse = pulse * 0.7 * s.settle;
    s.converge = 0.5 + 0.5 * Math.sin(t * 0.21 + 1.1);

    // Simulated speech: phrases of 1.5–3.5 s separated by pauses.
    // Kept ungated in `raw` so the mode weight scales the output rather than
    // feeding back into the damping above.
    let raw: number;
    if (audioLevelRef) {
      r.speechEnv = THREE.MathUtils.damp(r.speechEnv, audioLevelRef.current, 18, dt);
      raw = r.speechEnv;
    } else {
      if (t > r.nextSpeechToggle) {
        r.speaking = !r.speaking;
        r.nextSpeechToggle = t + (r.speaking ? 1.5 + Math.random() * 2 : 2.5 + Math.random() * 4);
      }
      r.speechEnv = THREE.MathUtils.damp(r.speechEnv, r.speaking ? 1 : 0, 6, dt);
      const syllables =
        Math.abs(Math.sin(t * 9.1)) * 0.55 +
        Math.abs(Math.sin(t * 13.7 + 1.3)) * 0.3 +
        Math.abs(Math.sin(t * 4.3 + 0.4)) * 0.15;
      raw = r.speechEnv * syllables * s.settle;
    }
    // He only moves his mouth when he is actually the one talking.
    s.speech = raw * speaking;

    // Occasional slight head tilt.
    if (t > r.nextTilt) {
      r.tiltTarget = (Math.random() - 0.5) * 0.07;
      r.nextTilt = t + 6 + Math.random() * 5;
    }
    r.tilt = THREE.MathUtils.damp(r.tilt, r.tiltTarget, 0.8, dt);

    // Smoothed pointer for parallax.
    r.mouse.x = THREE.MathUtils.damp(r.mouse.x, pointer.x, 2.2, dt);
    r.mouse.y = THREE.MathUtils.damp(r.mouse.y, pointer.y, 2.2, dt);

    const head = headRef.current;
    if (head) {
      const idle = s.settle * motion;
      head.rotation.y = (0.035 * Math.sin(t * 0.23) + 0.012 * Math.sin(t * 0.61 + 1.3)) * idle + r.mouse.x * 0.14;
      head.rotation.x =
        (0.018 * Math.sin(t * 0.19 + 0.7) + s.breath * 0.006) * idle - r.mouse.y * 0.08;
      head.rotation.z = r.tilt * idle + 0.004 * Math.sin(t * 0.43) * idle;
      head.position.y = 0.06 + (s.breath * 0.012 + 0.005 * Math.sin(t * 0.37)) * idle;
      // Settle from a tiny forward drift during formation.
      head.position.z = (1 - s.settle) * -0.15;
      const sc = 1 + s.breath * 0.004 * idle;
      head.scale.setScalar(sc);
    }

    // Camera parallax — very slight.
    camera.position.x = r.mouse.x * 0.12;
    camera.position.y = r.mouse.y * 0.07;
    camera.lookAt(0, 0.02, 0);
  }, -2);

  return state;
}
