import { useCallback, useEffect, useRef, useState } from 'react';
import { createEnergyVad, FLOOR_START_DB } from '../voice/energyVad';
import { createTurnDetector, type TurnConfig } from '../voice/turnDetector';
import { SAMPLE_RATE, type TurnPhase } from '../voice/types';

/**
 * Loudness window in dBFS. Speech RMS spans a wide amplitude range, so a linear
 * reading sits near zero until you shout — mapping decibels instead makes normal
 * talking use most of the 0–1 range.
 */
const FLOOR_DB = -60;
const CEIL_DB = -18;

/** Damping rates: snap up on speech onset, fall away slowly so visuals don't strobe. */
const ATTACK = 22;
const RELEASE = 5;

const WORKLET_NAME = 'mic-frames';

export type MicStatus = 'off' | 'starting' | 'on' | 'denied' | 'unavailable';

interface Rig {
  ctx?: AudioContext;
  stream?: MediaStream;
  analyser?: AnalyserNode;
  /**
   * Held deliberately. A MediaStreamAudioSourceNode with no live reference can be
   * garbage-collected, which silently tears down the graph and leaves the
   * analyser reading permanent silence.
   */
  source?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  mute?: GainNode;
  // Explicitly ArrayBuffer-backed: the bare `Float32Array` alias widens to
  // ArrayBufferLike, which getFloatTimeDomainData rejects.
  buf?: Float32Array<ArrayBuffer>;
  raf?: number;
  last?: number;
  sampleRate?: number;
}

interface Options {
  /** Fired when speech onset is confirmed. */
  onSpeechStart?: () => void;
  /** Fired when the utterance is judged finished. */
  onTurnEnd?: (utterance: Float32Array, complete: boolean) => void;
  /** Every 32 ms mic frame, after the worklet copies it. */
  onFrame?: (frame: Float32Array, sampleRate: number) => void;
  turnConfig?: Partial<TurnConfig>;
}

/**
 * Microphone capture: a 0–1 level for the visuals, plus 16 kHz frames fed
 * through voice-activity and turn detection.
 *
 * The level lives in a ref and is updated from its own animation frame loop, so
 * driving the visuals never triggers a React render. The frames come off an
 * AudioWorklet instead, so detection never misses audio when the render loop
 * stutters.
 */
export function useVoiceCapture({ onSpeechStart, onTurnEnd, onFrame, turnConfig }: Options = {}) {
  const levelRef = useRef(0);
  /** Live VAD probability and noise floor, for the diagnostic readout. */
  const probeRef = useRef({ p: 0, floorDb: FLOOR_START_DB });
  const [status, setStatus] = useState<MicStatus>('off');
  const [device, setDevice] = useState('');
  const [phase, setPhase] = useState<TurnPhase>('silent');
  const sampleRateRef = useRef(SAMPLE_RATE);
  const rig = useRef<Rig>({});

  // Held in refs so changing a handler never forces the mic to restart.
  const handlers = useRef({ onSpeechStart, onTurnEnd, onFrame });
  handlers.current = { onSpeechStart, onTurnEnd, onFrame };

  const stop = useCallback(() => {
    const r = rig.current;
    if (r.raf !== undefined) cancelAnimationFrame(r.raf);
    r.worklet?.port.close();
    r.worklet?.disconnect();
    r.mute?.disconnect();
    r.source?.disconnect();
    r.stream?.getTracks().forEach((t) => t.stop());
    void r.ctx?.close();
    rig.current = {};
    levelRef.current = 0;
    setStatus('off');
    setDevice('');
    setPhase('silent');
  }, []);

  const start = useCallback(async () => {
    if (rig.current.ctx) return true;
    setStatus('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation keeps his own voice out of the mic once TTS lands,
          // which is what makes interruption detection possible later.
          echoCancellation: true,
          noiseSuppression: true,
          // Automatic gain would flatten the dynamics we are trying to show.
          autoGainControl: false,
        },
      });

      // Asking for 16 kHz lets the browser resample with a proper filter, which
      // is both simpler and better than decimating by hand in the worklet.
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
      await ctx.resume();
      // Browsers often ignore the requested rate — Whisper needs the real one.
      sampleRateRef.current = ctx.sampleRate;

      await ctx.audioWorklet.addModule(new URL('worklets/mic-frames.js', document.baseURI).href);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      const source = ctx.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(ctx, WORKLET_NAME);
      source.connect(analyser);
      source.connect(worklet);

      // An AudioWorkletNode only runs process() while its graph reaches a
      // destination, so the worklet must be connected or it emits nothing. The
      // gain is pinned to zero: we need the graph pulled, not the mic audible,
      // and routing the mic to the speakers would feed back.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      worklet.connect(mute);
      mute.connect(ctx.destination);

      // Wrapped so the readout can show what the detector is actually deciding.
      const vad = createEnergyVad();
      const detector = createTurnDetector({
        vad: {
          probability: (frame) => {
            const p = vad.probability(frame);
            probeRef.current = { p, floorDb: vad.floorDb() };
            return p;
          },
          reset: () => vad.reset(),
        },
        config: turnConfig,
        onSpeechStart: () => handlers.current.onSpeechStart?.(),
        onTurnEnd: (audio, complete) => handlers.current.onTurnEnd?.(audio, complete),
        onPhaseChange: setPhase,
      });
      worklet.port.onmessage = (e) => {
        const frame = e.data as Float32Array;
        handlers.current.onFrame?.(frame, sampleRateRef.current);
        detector.push(frame);
      };

      rig.current = {
        ctx,
        stream,
        analyser,
        source,
        worklet,
        mute,
        buf: new Float32Array(analyser.fftSize),
        sampleRate: ctx.sampleRate,
      };
      setDevice(stream.getAudioTracks()[0]?.label ?? 'unknown');
      setStatus('on');

      const tick = (now: number) => {
        const r = rig.current;
        if (!r.analyser || !r.buf) return;

        r.analyser.getFloatTimeDomainData(r.buf);
        let sum = 0;
        for (let i = 0; i < r.buf.length; i++) sum += r.buf[i] * r.buf[i];
        const rms = Math.sqrt(sum / r.buf.length);

        const db = 20 * Math.log10(rms || 1e-8);
        const norm = Math.min(Math.max((db - FLOOR_DB) / (CEIL_DB - FLOOR_DB), 0), 1);

        const dt = Math.min((now - (r.last ?? now)) / 1000, 0.1);
        r.last = now;
        const prev = levelRef.current;
        const rate = norm > prev ? ATTACK : RELEASE;
        levelRef.current = prev + (norm - prev) * (1 - Math.exp(-rate * dt));

        r.raf = requestAnimationFrame(tick);
      };
      rig.current.raf = requestAnimationFrame(tick);
      return true;
    } catch (err) {
      const name = (err as DOMException)?.name ?? 'Error';
      const message = err instanceof Error ? err.message : String(err);
      // Stop any tracks we may have opened before a later step failed.
      rig.current.stream?.getTracks().forEach((t) => t.stop());
      void rig.current.ctx?.close();
      rig.current = {};
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus('denied');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setStatus('unavailable');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        // Mic exists but another app (or a zombie Electron) is holding it.
        setStatus('unavailable');
        console.warn('[mic]', name, message, '— close other apps using the microphone and retry');
      } else {
        setStatus('unavailable');
        console.warn('[mic] start failed:', name, message);
      }
      return false;
    }
  }, [turnConfig]);

  useEffect(() => stop, [stop]);

  return { levelRef, probeRef, sampleRateRef, status, device, phase, start, stop };
}
