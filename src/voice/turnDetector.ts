import { FRAME_MS, SAMPLE_RATE, type AudioFrame, type SpeechDetector, type TurnModel, type TurnPhase } from './types';

export interface TurnConfig {
  /** Speech probability above which a frame counts as speech. */
  threshold: number;
  /** Consecutive speech frames required before accepting that you started. */
  onsetFrames: number;
  /**
   * Silence held after speech before the utterance is considered over.
   * Short enough to feel responsive, long enough to survive the natural gaps
   * inside a sentence.
   */
  hangoverMs: number;
  /** Utterances shorter than this are treated as noise and discarded. */
  minUtteranceMs: number;
  /** Cap on retained audio. Smart Turn only looks at the last few seconds. */
  maxUtteranceMs: number;
  /**
   * Completion probability above which the turn is accepted as a finished
   * thought. Only consulted when a TurnModel is supplied.
   */
  completionThreshold: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  threshold: 0.5,
  onsetFrames: 3, // ~96 ms of speech, enough to ignore a click
  hangoverMs: 450,
  minUtteranceMs: 250,
  maxUtteranceMs: 8000,
  completionThreshold: 0.6,
};

export interface TurnEvents {
  onSpeechStart?: () => void;
  /**
   * Fired once the utterance is judged finished. `complete` is the turn model's
   * verdict, or true when no model is attached and silence alone decided it.
   */
  onTurnEnd?: (utterance: Float32Array, complete: boolean) => void;
  onPhaseChange?: (phase: TurnPhase) => void;
}

interface Options extends TurnEvents {
  vad: SpeechDetector;
  model?: TurnModel;
  config?: Partial<TurnConfig>;
}

/**
 * Turns a stream of audio frames into speech-start and turn-end events.
 *
 * The flow is: count speech frames until onset is confirmed, buffer the
 * utterance, then once silence has run for the hangover window, hand the audio
 * to the turn model to decide whether you were finished or merely pausing.
 */
export function createTurnDetector({ vad, model, config, ...events }: Options) {
  const cfg = { ...DEFAULT_TURN_CONFIG, ...config };
  const maxSamples = Math.ceil((cfg.maxUtteranceMs / 1000) * SAMPLE_RATE);

  let phase: TurnPhase = 'silent';
  let speechRun = 0;
  let silenceMs = 0;
  let utterance: Float32Array = new Float32Array(0);
  let pending = false;

  const setPhase = (next: TurnPhase) => {
    if (phase === next) return;
    phase = next;
    events.onPhaseChange?.(next);
  };

  const append = (frame: AudioFrame) => {
    const combined = new Float32Array(utterance.length + frame.length);
    combined.set(utterance);
    combined.set(frame, utterance.length);
    // Keep only the tail once past the cap.
    utterance = combined.length > maxSamples ? combined.subarray(combined.length - maxSamples) : combined;
  };

  /** Clears the in-progress utterance without touching the adaptive noise floor. */
  const clearUtterance = () => {
    speechRun = 0;
    silenceMs = 0;
    utterance = new Float32Array(0);
    setPhase('silent');
  };

  const reset = () => {
    clearUtterance();
    vad.reset();
  };

  const finish = async () => {
    const audio = utterance;
    const lengthMs = (audio.length / SAMPLE_RATE) * 1000;
    // Keep the learned noise floor across turns — only wipe utterance state.
    clearUtterance();

    if (lengthMs < cfg.minUtteranceMs) return;

    let complete = true;
    if (model) {
      // A guard here matters: if the model rejects the turn we keep listening,
      // so a wrong answer costs a missed reply rather than a crash.
      try {
        complete = (await model.completion(audio)) >= cfg.completionThreshold;
      } catch {
        complete = true;
      }
    }
    events.onTurnEnd?.(audio, complete);
  };

  return {
    push(frame: AudioFrame) {
      const speech = vad.probability(frame) >= cfg.threshold;

      if (phase === 'silent') {
        speechRun = speech ? speechRun + 1 : 0;
        if (speechRun >= cfg.onsetFrames) {
          // Include the frames that triggered onset so the utterance is not clipped.
          setPhase('speaking');
          silenceMs = 0;
          events.onSpeechStart?.();
        }
        // Buffer regardless, so onset audio is already captured.
        append(frame);
        if (phase === 'silent' && utterance.length > cfg.onsetFrames * frame.length) {
          utterance = utterance.subarray(frame.length);
        }
        return;
      }

      append(frame);

      if (speech) {
        silenceMs = 0;
        setPhase('speaking');
        return;
      }

      silenceMs += FRAME_MS;
      if (silenceMs >= cfg.hangoverMs) {
        if (!pending) {
          pending = true;
          void finish().finally(() => {
            pending = false;
          });
        }
      } else if (silenceMs > FRAME_MS * 2) {
        setPhase('settling');
      }
    },

    reset,
    get phase() {
      return phase;
    },
  };
}
