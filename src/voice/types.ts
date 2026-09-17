/**
 * Shared contracts for the voice layer.
 *
 * The values below are not arbitrary: 16 kHz mono in 512-sample frames is what
 * Silero VAD v5 and Smart Turn both consume, so capture, detection and the turn
 * model all speak the same units and no resampling is needed between them.
 */

export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 512;
export const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATE) * 1000; // 32 ms

/** One frame of 16 kHz mono audio, samples in -1..1. */
export type AudioFrame = Float32Array;

/**
 * Per-frame speech detector. The energy detector implements this now; dropping
 * in Silero VAD later means providing this interface and nothing else.
 */
export interface SpeechDetector {
  /** Probability in 0–1 that the frame contains speech. */
  probability(frame: AudioFrame): number;
  reset(): void;
}

/**
 * Judges whether a finished utterance was a complete thought rather than a
 * mid-sentence pause. Smart Turn will implement this. Until then the turn
 * detector falls back to silence duration alone, which is why this is optional.
 */
export interface TurnModel {
  /** Probability in 0–1 that the utterance is complete. */
  completion(utterance: Float32Array): Promise<number>;
}

export type TurnPhase = 'silent' | 'speaking' | 'settling';
