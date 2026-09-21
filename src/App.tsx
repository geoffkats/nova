import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Canvas } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { Bloom, EffectComposer, Noise, Vignette } from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { HolographicAvatar } from './components/HolographicAvatar';
import { useAvatarMode } from './hooks/useAvatarMode';
import { useVoiceCapture, type MicStatus } from './hooks/useVoiceCapture';
import { createBrowserStt } from './voice/browserStt';
import { cancelSpeech, enqueuePcmChunk, playAudioBuffer, speakFallback, waitForPlayback, type BrainStatus } from './voice/playback';
import { createQwenPcmPump } from './voice/qwenPcm';
import { isNudgeAck, isNudgeContinue, isSleepPhrase, isWakeFiller, isWakePhrase, stripWake, wakeAudioWorthSending } from './voice/wakeWord';
import { ArtifactCard, type WorkspaceArtifact } from './artifact/ArtifactCard';
import { detectQuality, QUALITY, stepDown, type QualityTier } from './quality';

/** Electron IPC often delivers audio as Buffer / Uint8Array / number[]. */
function toArrayBuffer(audio: ArrayBuffer | number[] | Uint8Array | null | undefined): ArrayBuffer | null {
  if (!audio) return null;
  if (audio instanceof ArrayBuffer) return audio;
  if (ArrayBuffer.isView(audio)) {
    const v = audio as ArrayBufferView;
    return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(audio)) return new Uint8Array(audio).buffer;
  return null;
}

const MIC_LABEL: Record<MicStatus, string> = {
  off: 'Start microphone',
  starting: 'Starting…',
  on: 'Stop microphone',
  denied: 'Microphone blocked — allow access',
  unavailable: 'Mic busy or missing — close other apps',
};

function micButtonLabel(status: MicStatus, session: 'asleep' | 'awake', live: boolean) {
  if (status !== 'on' || !live) return MIC_LABEL[status];
  return session === 'awake' ? 'Sleep Nova' : 'Listening for Hey Nova';
}

function LevelReadout({
  levelRef,
  probeRef,
}: {
  levelRef: MutableRefObject<number>;
  probeRef: MutableRefObject<{ p: number; floorDb: number }>;
}) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (el.current) {
        const { p, floorDb } = probeRef.current;
        el.current.textContent = `lvl ${levelRef.current.toFixed(2)} · p ${p.toFixed(2)} · floor ${floorDb.toFixed(0)}dB`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef, probeRef]);
  return <span ref={el}>lvl 0.00</span>;
}

export default function App() {
  const [tier, setTier] = useState<QualityTier>(detectQuality);
  const { modeRef, mode, setMode, showHud } = useAvatarMode();
  const replyTimer = useRef<number>(0);
  const replyGen = useRef(0);
  const bridgePlay = useRef(Promise.resolve());
  /** Final answer already playing via avatar:speak — don't play twice. */
  const earlySpeak = useRef<Promise<void>>(Promise.resolve());
  const earlySpeakGen = useRef(0);
  const ttsEpochRef = useRef(-1);
  const ttsBeginMs = useRef(0);
  const ttsEndWait = useRef(Promise.resolve());
  const ttsEndResolve = useRef<(() => void) | null>(null);
  const ttsHadAudio = useRef(false);
  const sttRef = useRef(createBrowserStt());
  const brainRef = useRef<BrainStatus>({ ready: false });
  const qwenPump = useRef(createQwenPcmPump());
  const sessionRef = useRef<'asleep' | 'awake'>('asleep');
  const wakingRef = useRef(false);
  const earsAuto = useRef(false);
  const transcribingRef = useRef(false);
  /** After junk wake attempts, pause Groq briefly so the meter doesn't spin. */
  const wakeCooldownUntil = useRef(0);
  const wakeMissStreak = useRef(0);
  /** Reminder nudge: speak once, listen briefly, then sleep if no reply. */
  const nudgeActiveRef = useRef(false);
  const nudgeTimerRef = useRef(0);
  const [session, setSession] = useState<'asleep' | 'awake'>('asleep');
  const [lastEvent, setLastEvent] = useState('—');
  const [brain, setBrain] = useState<BrainStatus>({ ready: false });
  const [artifact, setArtifact] = useState<WorkspaceArtifact | null>(null);

  const isQwen = () => brainRef.current.voiceRuntime === 'qwen';

  const refreshBrain = async () => {
    if (!window.avatarHost) {
      const offline = { ready: false, brain: 'none', stt: 'none', tts: 'local' };
      brainRef.current = offline;
      setBrain(offline);
      return offline;
    }
    try {
      const status = await window.avatarHost.brainStatus();
      brainRef.current = status;
      setBrain(status);
      return status;
    } catch {
      const offline = { ready: false, brain: 'error', stt: 'error', tts: 'local' };
      brainRef.current = offline;
      setBrain(offline);
      return offline;
    }
  };

  const putToSleep = () => {
    if (sessionRef.current === 'asleep' && !wakingRef.current && !nudgeActiveRef.current) return;
    nudgeActiveRef.current = false;
    window.clearTimeout(nudgeTimerRef.current);
    sessionRef.current = 'asleep';
    wakingRef.current = false;
    setSession('asleep');
    replyGen.current += 1;
    cancelSpeech();
    window.avatarHost?.cancelTts?.();
    qwenPump.current.flush();
    window.avatarHost?.qwenStop?.();
    setMode('idle');
    setLastEvent('sleeping · say hey nova');
  };

  const clearNudge = (label = 'sleeping · say hey nova') => {
    nudgeActiveRef.current = false;
    window.clearTimeout(nudgeTimerRef.current);
    if (sessionRef.current === 'asleep') {
      setMode('idle');
      setLastEvent(label);
    }
  };

  const runNudge = async (nudge: { text?: string; spoken?: string }) => {
    const line = String(nudge.spoken || nudge.text || '').trim();
    if (!line) return;
    window.clearTimeout(nudgeTimerRef.current);
    nudgeActiveRef.current = true;
    // Don't open Qwen — just light up, speak, listen briefly.
    if (sessionRef.current === 'awake') {
      setLastEvent(`reminder: ${nudge.text || line}`);
      try {
        await speakFallback(line);
      } finally {
        nudgeActiveRef.current = false;
      }
      return;
    }
    setLastEvent(`reminder: ${nudge.text || line}`);
    setMode('speaking');
    try {
      await speakFallback(line);
    } catch {
      /* still open listen window */
    }
    if (!nudgeActiveRef.current) return;
    setMode('listening');
    setLastEvent('reminder · say something or I sleep');
    nudgeTimerRef.current = window.setTimeout(() => {
      if (!nudgeActiveRef.current) return;
      if (sessionRef.current !== 'asleep') return;
      clearNudge('sleeping · say hey nova');
    }, 22_000);
  };

  const wakeUp = async (rest = '') => {
    if (sessionRef.current === 'awake' || wakingRef.current) return;
    wakingRef.current = true;
    setLastEvent('waking…');
    setMode('listening');
    const status = brainRef.current.voiceRuntime ? brainRef.current : await refreshBrain();
    if (status.voiceRuntime === 'qwen') {
      const started = await window.avatarHost?.qwenStart?.();
      if (started && !started.ok) {
        wakingRef.current = false;
        sessionRef.current = 'asleep';
        setSession('asleep');
        setMode('idle');
        setLastEvent(started.error || 'qwen failed to connect');
        return;
      }
      sessionRef.current = 'awake';
      setSession('awake');
      setLastEvent(`nova is awake · ${started?.model || status.qwenModel || 'realtime'}`);
      const leftover = String(rest || '').trim();
      if (leftover) window.avatarHost?.qwenText?.(leftover);
    } else {
      sessionRef.current = 'awake';
      setSession('awake');
      setLastEvent('nova is awake');
    }
    wakingRef.current = false;
  };

  useEffect(() => {
    void refreshBrain().then(() => {
      // Prefetch Kokoro weights so the first reply is not a long silent wait.
      void window.avatarHost?.warmupTts?.().then((r) => {
        if (r?.tts === 'qwen') setLastEvent('say hey nova');
        else if (r?.skipped || r?.tts === 'local') setLastEvent('system voice ready · say hey nova');
        else if (r?.ok) setLastEvent('kokoro voice ready');
        else if (r?.error) setLastEvent(`kokoro warmup: ${r.error}`);
        if (brainRef.current.qwenWanted && !brainRef.current.qwenConfigured) {
          setLastEvent('Qwen needs DASHSCOPE_API_KEY — using Groq');
        }
        void refreshBrain();
      });
    });
  }, []);

  useEffect(() => {
    const stop = window.avatarHost?.onArtifact?.((next) => setArtifact(next));
    return () => stop?.();
  }, []);

  useEffect(() => {
    const stop = window.avatarHost?.onNudge?.((nudge) => {
      void runNudge(nudge);
    });
    return () => {
      stop?.();
      window.clearTimeout(nudgeTimerRef.current);
    };
  }, []);

  // Live bridge + progress while tools run (email search, etc.)
  useEffect(() => {
    const host = window.avatarHost;
    if (!host?.onBridge && !host?.onProgress && !host?.onSpeak && !host?.onTtsChunk) return;

    const offProgress = host.onProgress?.((info) => {
      if (!info?.text) return;
      // Full reply text arrives here before Kokoro finishes — show it immediately.
      if (info.phase === 'answering' && info.text.length > 2 && info.text !== 'answering…') {
        setLastEvent(`nova: ${info.text}`);
        return;
      }
      setLastEvent(String(info.text));
    });

    const offBridge = host.onBridge?.((bridge) => {
      const gen = replyGen.current;
      bridgePlay.current = (async () => {
        if (!bridge?.text) return;
        setLastEvent(`nova: ${bridge.text}`);
        const buf = toArrayBuffer(bridge.audio as ArrayBuffer | number[] | null);
        if (!buf || !bridge.mime) return;
        setMode('speaking');
        try {
          await playAudioBuffer(buf, bridge.mime);
        } catch {
          /* ignore playback blips */
        }
        if (gen !== replyGen.current) return;
        setMode('thinking');
        setLastEvent('still checking…');
      })();
    });

    const offSpeak = host.onSpeak?.((spoken) => {
      const gen = replyGen.current;
      earlySpeakGen.current = gen;
      earlySpeak.current = (async () => {
        if (!spoken?.text) return;
        await bridgePlay.current.catch(() => {});
        if (gen !== replyGen.current) return;
        setLastEvent(`nova: ${spoken.text}`);
        setMode('speaking');
        const buf = toArrayBuffer(spoken.audio as ArrayBuffer | number[] | null);
        try {
          if (buf && spoken.mime) await playAudioBuffer(buf, spoken.mime);
          else await speakFallback(spoken.text);
        } catch {
          /* ignore */
        }
      })();
    });

    const offBegin = host.onTtsBegin?.((info) => {
      ttsEpochRef.current = info.epoch;
      ttsBeginMs.current = performance.now();
      ttsHadAudio.current = false;
      ttsEndWait.current = new Promise<void>((resolve) => {
        ttsEndResolve.current = resolve;
      });
    });

    const offChunk = host.onTtsChunk?.((chunk) => {
      if (chunk.epoch !== ttsEpochRef.current) return;
      ttsHadAudio.current = true;
      if (chunk.text) setLastEvent(`nova: ${chunk.text}`);
      setMode('speaking');
      enqueuePcmChunk(chunk.pcm, chunk.sampleRate || 24000, () => {
        const ttfa = Math.round(performance.now() - ttsBeginMs.current);
        host.ttsPlaybackStart?.({ epoch: chunk.epoch, ttfa });
      });
    });

    const offEnd = host.onTtsEnd?.((info) => {
      if (info.epoch !== ttsEpochRef.current) return;
      if (ttsHadAudio.current) earlySpeakGen.current = replyGen.current;
      earlySpeak.current = waitForPlayback();
      ttsEndResolve.current?.();
    });

    const offQwen = host.onQwenEvent?.((ev) => {
      if (!ev?.kind) return;
      if (ev.kind === 'connected' && ev.text) {
        setLastEvent(ev.text);
        return;
      }
      if (ev.kind === 'speech_started') {
        replyGen.current += 1;
        ttsEpochRef.current = -1;
        ttsEndResolve.current?.();
        cancelSpeech();
        setMode('listening');
        setLastEvent(ev.text || 'heard you');
        return;
      }
      if (ev.kind === 'thinking') {
        setMode('thinking');
        setLastEvent(ev.text || 'thinking…');
        return;
      }
      if (ev.kind === 'user' && ev.text) {
        if (isSleepPhrase(ev.text)) {
          putToSleep();
          return;
        }
        setLastEvent(`you: ${ev.text}`);
        return;
      }
      if (ev.kind === 'nova' && ev.text) {
        setLastEvent(`nova: ${ev.text}`);
        return;
      }
      if (ev.kind === 'tool') {
        setMode('thinking');
        setLastEvent(ev.text ? `checking ${ev.text}…` : 'checking…');
        return;
      }
      if (ev.kind === 'done') {
        void waitForPlayback().then(() => {
          if (modeRef.current === 'speaking' || modeRef.current === 'thinking') {
            setMode('listening');
            setLastEvent('back to listening');
          }
        });
        return;
      }
      if (ev.kind === 'error' && ev.text) setLastEvent(ev.text);
    });

    return () => {
      offProgress?.();
      offBridge?.();
      offSpeak?.();
      offBegin?.();
      offChunk?.();
      offEnd?.();
      offQwen?.();
    };
  }, [setMode, modeRef]);

  const {
    levelRef,
    probeRef,
    sampleRateRef,
    status: micStatus,
    device: micDevice,
    phase,
    start: startMic,
    stop: stopMic,
  } = useVoiceCapture({
    onFrame: (frame, sampleRate) => {
      if (!isQwen() || sessionRef.current !== 'awake') return;
      qwenPump.current.push(frame, sampleRate);
    },
    onSpeechStart: () => {
      const m = modeRef.current;
      if (sessionRef.current === 'asleep') {
        setLastEvent('heard you');
        return;
      }
      // Qwen smart_turn owns barge-in. Local energy VAD hears the speakers
      // and was cancelling every reply ("Conversation has no active response").
      if (isQwen()) {
        if (m !== 'speaking' && m !== 'thinking') {
          setLastEvent('heard you');
          setMode('listening');
        }
        return;
      }
      if (m === 'speaking') {
        replyGen.current += 1;
        ttsEpochRef.current = -1;
        ttsEndResolve.current?.();
        cancelSpeech();
        window.avatarHost?.cancelTts?.();
        setMode('listening');
        setLastEvent('interrupted');
        return;
      }
      if (m === 'thinking') return;
      setLastEvent('heard you');
      setMode('listening');
    },
    onTurnEnd: (utterance, complete) => {
      if (!complete || transcribingRef.current) return;

      // While awake on Qwen, still listen locally for short "sleep nova" commands.
      if (sessionRef.current === 'awake' && isQwen()) {
        const seconds = utterance.length / Math.max(1, sampleRateRef.current);
        if (seconds < 0.45 || seconds > 3.2) return;
        if (!wakeAudioWorthSending(utterance, sampleRateRef.current)) return;
        transcribingRef.current = true;
        void (async () => {
          try {
            const host = window.avatarHost;
            if (!host?.transcribe) return;
            const result = await host.transcribe({
              samples: Array.from(utterance),
              sampleRate: sampleRateRef.current,
            });
            const text = String(result?.text || '').trim();
            if (isSleepPhrase(text)) {
              console.log('[sleep]', text);
              putToSleep();
            }
          } finally {
            transcribingRef.current = false;
          }
        })();
        return;
      }

      if (sessionRef.current === 'asleep') {
        if (nudgeActiveRef.current) {
          if (!wakeAudioWorthSending(utterance, sampleRateRef.current)) return;
          transcribingRef.current = true;
          void (async () => {
            try {
              const host = window.avatarHost;
              if (!host?.transcribe) return;
              const result = await host.transcribe({
                samples: Array.from(utterance),
                sampleRate: sampleRateRef.current,
              });
              const text = String(result?.text || '').trim();
              if (!text || isWakeFiller(text)) return;
              if (isNudgeAck(text)) {
                clearNudge('got it · sleeping');
                return;
              }
              if (isNudgeContinue(text) || isWakePhrase(text)) {
                clearNudge();
                await wakeUp(isWakePhrase(text) ? stripWake(text) : text);
                return;
              }
              clearNudge();
              await wakeUp(text);
            } finally {
              transcribingRef.current = false;
            }
          })();
          return;
        }

        if (Date.now() < wakeCooldownUntil.current) return;
        if (!wakeAudioWorthSending(utterance, sampleRateRef.current)) return;
        transcribingRef.current = true;
        void (async () => {
          try {
            const host = window.avatarHost;
            if (!host?.transcribe) return;
            const result = await host.transcribe({
              samples: Array.from(utterance),
              sampleRate: sampleRateRef.current,
            });
            const text = String(result?.text || '').trim();
            if (!text || isWakeFiller(text) || !isWakePhrase(text)) {
              wakeMissStreak.current += 1;
              const cool = Math.min(5000, 700 * wakeMissStreak.current);
              wakeCooldownUntil.current = Date.now() + cool;
              if (text && !isWakeFiller(text)) setLastEvent('waiting for hey nova');
              return;
            }
            wakeMissStreak.current = 0;
            wakeCooldownUntil.current = 0;
            await wakeUp(stripWake(text));
          } finally {
            transcribingRef.current = false;
          }
        })();
        return;
      }
      // Groq / converse path owns the duplex turn when Qwen is off.
      if (isQwen()) return;
      if (!complete) {
        setLastEvent('pause (still listening)');
        return;
      }
      if (modeRef.current === 'thinking' || modeRef.current === 'speaking') return;

      window.clearTimeout(replyTimer.current);
      cancelSpeech();
      window.avatarHost?.cancelTts?.();

      const gen = ++replyGen.current;
      const browserText = sttRef.current.take();
      setLastEvent('thinking…');
      setMode('thinking');

      void (async () => {
        // If the brain hangs (MCP/TTS), unlock listening so the mic isn't "dead".
        const unlock = window.setTimeout(() => {
          if (gen !== replyGen.current) return;
          if (modeRef.current === 'thinking' || modeRef.current === 'speaking') {
            setLastEvent('taking too long — listening again');
            setMode('listening');
          }
        }, 45_000);

        try {
          const host = window.avatarHost;
          // Always prefer the real brain when running inside Electron. The old
          // gate on brain.ready dropped into random "Got it" lines whenever the
          // boot-time Ollama ping hiccuped — which looked like Groq was ignored.
          if (host) {
            const status = brainRef.current.ready ? brainRef.current : await refreshBrain();
            setLastEvent(
              `stt ${status.stt ?? '?'} · brain ${status.brain ?? '?'} · whispering…`,
            );

            const samples = utterance.slice();
            const result = await host.converse({
              // Plain array clones cleanly over Electron IPC (TypedArrays can arrive mangled).
              samples: Array.from(samples),
              sampleRate: sampleRateRef.current,
              userText: status.stt === 'browser' ? browserText || undefined : undefined,
            });
            if (gen !== replyGen.current) return;

            if (!result.ok) {
              const err = result.error ?? result.reason ?? 'brain failed';
              setLastEvent(err);
              // Junk Whisper / too-short: stay quiet and keep listening — do not
              // burn a spoken apology (or filler) on every noise blip.
              if (result.skipSpeak || result.reason === 'whisper-hallucination' || result.reason === 'too-short' || result.reason === 'empty-transcript') {
                setMode('listening');
                return;
              }
              setMode('speaking');
              await speakFallback("Sorry, I hit a problem.");
              if (gen !== replyGen.current) return;
              setMode('listening');
              return;
            }

            setLastEvent(`you: ${result.userText}`);
            if (isSleepPhrase(String(result.userText || ''))) {
              putToSleep();
              return;
            }
            // Let the bridge line finish before the real answer.
            await bridgePlay.current.catch(() => {});
            if (gen !== replyGen.current) return;

            // Audio may already be playing via streamed PCM chunks or avatar:speak.
            const hasStreamedAudio = ttsHadAudio.current && (result.streamed || result.spokeEarly || earlySpeakGen.current === gen);
            if (hasStreamedAudio) {
              setMode('speaking');
              setLastEvent(
                result.ttsNote
                  ? `nova: ${result.reply} · ${result.ttsNote}`
                  : `nova: ${result.reply}`,
              );
              await ttsEndWait.current.catch(() => {});
              await waitForPlayback();
              await earlySpeak.current.catch(() => {});
              if (gen !== replyGen.current) return;
              setLastEvent('back to listening');
              setMode('listening');
              return;
            }

            setMode('speaking');
            setLastEvent(
              result.ttsNote
                ? `nova: ${result.reply} · ${result.ttsNote}`
                : `nova: ${result.reply}`,
            );
            const finalAudio = toArrayBuffer(result.audio as ArrayBuffer | number[] | null);
            if (finalAudio && result.mime) {
              await playAudioBuffer(finalAudio, result.mime);
            } else {
              await speakFallback(result.reply);
            }
            if (gen !== replyGen.current) return;
            setLastEvent('back to listening');
            setMode('listening');
            return;
          }

          setMode('speaking');
          setLastEvent('no Electron brain — local filler');
          await speakFallback();
          if (gen !== replyGen.current) return;
          setLastEvent('back to listening');
          setMode('listening');
        } catch (err) {
          if (gen !== replyGen.current) return;
          const msg = err instanceof Error ? err.message : 'reply failed';
          setLastEvent(msg);
          setMode('speaking');
          await speakFallback('Sorry, I hit a problem.');
          setMode('listening');
        } finally {
          window.clearTimeout(unlock);
        }
      })();
    },
  });
  const quality = QUALITY[tier];
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  const micLive = micStatus === 'on' || micStatus === 'starting';
  const toggleMic = async () => {
    if (micLive) {
      if (sessionRef.current === 'awake') {
        putToSleep();
        return;
      }
      replyGen.current += 1;
      window.clearTimeout(replyTimer.current);
      cancelSpeech();
      window.avatarHost?.cancelTts?.();
      qwenPump.current.flush();
      window.avatarHost?.qwenStop?.();
      sttRef.current.stop();
      stopMic();
      setMode('idle');
      setLastEvent('microphone off');
    } else if (await startMic()) {
      sessionRef.current = 'asleep';
      setSession('asleep');
      setLastEvent('listening for hey nova');
      setMode('idle');
    }
  };

  useEffect(() => {
    if (earsAuto.current || micStatus !== 'off') return;
    const t = window.setTimeout(() => {
      if (earsAuto.current || micStatus !== 'off') return;
      earsAuto.current = true;
      void startMic().then((ok) => {
        if (!ok) {
          earsAuto.current = false;
          return;
        }
        sessionRef.current = 'asleep';
        setSession('asleep');
        setLastEvent('listening for hey nova');
        setMode('idle');
      });
    }, 600);
    return () => window.clearTimeout(t);
  }, [micStatus, startMic, setMode]);

  return (
    <div className="stage">
      <Canvas
        dpr={quality.dpr}
        camera={{ fov: 35, near: 0.1, far: 50, position: [0, 0, 5.6] }}
        gl={{ antialias: false, alpha: false, powerPreference: 'high-performance' }}
        aria-label="Holographic AI face"
      >
        <PerformanceMonitor
          flipflops={2}
          onDecline={() => setTier((t) => stepDown(t))}
        />
        <HolographicAvatar
          quality={quality}
          modeRef={modeRef}
          inputLevelRef={levelRef}
          reducedMotion={reducedMotion}
        />
        <EffectComposer multisampling={quality.multisampling}>
          <Bloom mipmapBlur luminanceThreshold={0.18} luminanceSmoothing={0.35} intensity={0.85} radius={0.72} />
          <Noise premultiply blendFunction={BlendFunction.SCREEN} opacity={0.035} />
          <Vignette offset={0.28} darkness={0.85} />
        </EffectComposer>
      </Canvas>
      <div className="artifact-stage">
        <ArtifactCard
          artifact={artifact}
          onOpen={(url) => void window.avatarHost?.openUrl?.(url)}
          onDismiss={() => {
            setArtifact(null);
            window.avatarHost?.dismissArtifact?.();
          }}
        />
      </div>
      {showHud && (
        <div className="mode-hud">
          <span>mode {mode}</span>
          <span> · {session === 'awake' ? 'awake' : 'asleep'}</span>
          <span> · turn {phase}</span>
          <span>
            {' '}
            · brain {brain.ready ? (brain.brain ?? 'on') : 'off'}
            {brain.brain === 'qwen' && brain.qwenModel ? `/${brain.qwenModel}` : ''}
            {brain.brain === 'groq' && brain.groqChatModel ? `/${brain.groqChatModel}` : ''}
            {brain.brain === 'ollama' && brain.ollamaModel ? `/${brain.ollamaModel}` : ''}
            {brain.brain === 'ollama' && brain.ollama === false ? ' (ollama down)' : ''}
          </span>
          <span>
            {' '}
            · stt {brain.stt ?? '—'}
            {brain.hasGroq ? ' ✓' : ''}
          </span>
          <span>
            {' '}
            · tts {brain.tts ?? '—'}
            {brain.tts === 'qwen' && brain.qwenVoice ? `/${brain.qwenVoice}` : ''}
            {brain.kokoro ? ` · kokoro/${brain.kokoroVoice ?? 'af_nova'}${brain.kokoroDevice ? `@${brain.kokoroDevice}` : ''}` : ''}
          </span>
          <span> · mic {micStatus}</span>
          <span>
            {' '}
            · <LevelReadout levelRef={levelRef} probeRef={probeRef} />
          </span>
          <span className="mode-hud__device">{lastEvent}</span>
          {micDevice && <span className="mode-hud__device">{micDevice}</span>}
        </div>
      )}
      <button
        type="button"
        className="mic-toggle board-toggle"
        onClick={() => void window.avatarHost?.showBoard?.()}
      >
        Board
      </button>
      <button
        type="button"
        className="mic-toggle"
        data-live={micLive || undefined}
        data-awake={session === 'awake' || undefined}
        onClick={toggleMic}
        disabled={micStatus === 'starting'}
      >
        {micButtonLabel(micStatus, session, micLive)}
      </button>
    </div>
  );
}
