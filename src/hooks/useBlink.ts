import { useRef, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type { AvatarState } from './useAvatarAnimation';

const CLOSE = 0.07;
const HOLD = 0.035;
const OPEN = 0.13;

/** Procedural blinking with randomised timing and occasional double blinks. Writes state.blink. */
export function useBlink(stateRef: MutableRefObject<AvatarState>) {
  const b = useRef({ next: 3.2, start: -10, queued: 0 });

  useFrame(() => {
    const s = stateRef.current;
    const t = s.time;
    const r = b.current;

    if (s.eyes < 1) {
      s.blink = 0;
      return;
    }

    if (t >= r.next) {
      r.start = t;
      if (r.queued > 0) {
        r.queued--;
        r.next = t + 2.2 + Math.random() * 4.5;
      } else {
        r.queued = Math.random() < 0.18 ? 1 : 0;
        r.next = t + (r.queued ? CLOSE + HOLD + OPEN + 0.12 : 2.2 + Math.random() * 4.5);
      }
    }

    const e = t - r.start;
    let v = 0;
    if (e < CLOSE) v = e / CLOSE;
    else if (e < CLOSE + HOLD) v = 1;
    else if (e < CLOSE + HOLD + OPEN) v = 1 - (e - CLOSE - HOLD) / OPEN;
    // Ease for a natural lid curve.
    s.blink = v * v * (3 - 2 * v);
  }, -1);
}
