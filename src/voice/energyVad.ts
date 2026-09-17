import type { AudioFrame, SpeechDetector } from './types';

/**
 * Speech detection from frame loudness against an adaptive noise floor.
 *
 * Everything here is in dBFS rather than raw amplitude. That matters: real mic
 * speech sits around -41 dBFS (RMS ~0.009), and comparing linear amplitudes
 * against fixed constants makes the detector either deaf to normal talking or
 * triggered by room tone, depending on which end you tune for. Decibels give a
 * consistent margin above whatever the noise floor happens to be.
 *
 * Its job is to hold the `SpeechDetector` contract so the turn state machine can
 * be built and tuned before pulling in a neural VAD. It handles steady room tone
 * well and will misfire on sudden non-speech noise — a door, a keyboard — which
 * is precisely what Silero fixes.
 */

export const FLOOR_START_DB = -55;
/** Stops the floor chasing digital silence into nonsense. */
const FLOOR_MIN_DB = -72;
/** Fast enough to settle in well under a second. */
const ADAPT = 0.06;
/** Margin above the floor where speech begins, and where it is certain. */
const SPEECH_OVER_DB = 5;
const SPEECH_FULL_DB = 12;
/** Only frames this quiet are allowed to move the floor. */
const FLOOR_UPDATE_BELOW = 0.25;

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

export interface EnergyVad extends SpeechDetector {
  /** Current noise floor in dBFS — the number to look at when tuning. */
  floorDb(): number;
}

export function createEnergyVad(): EnergyVad {
  let floor = FLOOR_START_DB;

  return {
    probability(frame: AudioFrame) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      const db = 20 * Math.log10(rms || 1e-9);

      const p = smoothstep(floor + SPEECH_OVER_DB, floor + SPEECH_FULL_DB, db);

      // Only let quiet frames move the floor, otherwise a long sentence would
      // train the detector into treating your voice as background.
      if (p < FLOOR_UPDATE_BELOW) {
        floor += (db - floor) * ADAPT;
        floor = Math.max(floor, FLOOR_MIN_DB);
      }

      return p;
    },

    floorDb() {
      return floor;
    },

    reset() {
      floor = FLOOR_START_DB;
    },
  };
}
