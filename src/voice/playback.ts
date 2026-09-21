/**
 * Play an ArrayBuffer of audio (mp3 from ElevenLabs, etc.) and resolve when done.
 * Falls back to browser speechSynthesis when no buffer is provided.
 *
 * Kokoro streams int16 PCM chunks into a gapless Web Audio queue so playback
 * can start on the first phrase instead of waiting for the full utterance.
 */

import { cancelSpeech as cancelBrowserSpeech, speakReply as browserSpeak } from './speak';

let current: HTMLAudioElement | null = null;
let pcmCtx: AudioContext | null = null;
let nextTime = 0;
let playGen = 0;
const sources = new Set<AudioBufferSourceNode>();
let drainWaiters: Array<() => void> = [];
let firstChunk = true;

function notifyDrain() {
  if (sources.size === 0) {
    const waiters = drainWaiters.splice(0);
    for (const fn of waiters) fn();
  }
}

export function cancelSpeech() {
  cancelBrowserSpeech();
  if (current) {
    current.pause();
    current.src = '';
    current = null;
  }
  playGen += 1;
  for (const src of sources) {
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  sources.clear();
  nextTime = 0;
  firstChunk = true;
  notifyDrain();
}

function toInt16(pcm: ArrayBuffer | Uint8Array | Int16Array | number[]): Int16Array {
  if (pcm instanceof Int16Array) return pcm;
  if (pcm instanceof Uint8Array) {
    if (pcm.byteOffset % 2 === 0) {
      return new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    }
    const copy = Uint8Array.from(pcm);
    return new Int16Array(copy.buffer);
  }
  if (pcm instanceof ArrayBuffer) return new Int16Array(pcm);
  return new Int16Array(new Uint8Array(pcm).buffer);
}

/**
 * Queue a 16-bit mono PCM chunk for gapless playback. Starts on the first chunk.
 */
export function enqueuePcmChunk(
  pcm: ArrayBuffer | Uint8Array | Int16Array | number[],
  sampleRate = 24000,
  onFirstStart?: () => void,
): void {
  const samples = toInt16(pcm);
  if (!samples.length) return;
  const myGen = playGen;

  const ctx = pcmCtx ?? (pcmCtx = new AudioContext({ sampleRate }));
  if (ctx.state === 'suspended') void ctx.resume();

  const f32 = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) f32[i] = samples[i] / 32768;

  const buf = ctx.createBuffer(1, f32.length, sampleRate);
  buf.getChannelData(0).set(f32);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);

  const now = ctx.currentTime;
  if (nextTime < now) nextTime = now;
  const startAt = nextTime;
  nextTime += buf.duration;

  src.onended = () => {
    sources.delete(src);
    notifyDrain();
  };
  sources.add(src);
  src.start(startAt);

  if (firstChunk && myGen === playGen) {
    firstChunk = false;
    onFirstStart?.();
  }
}

export function waitForPlayback(): Promise<void> {
  if (sources.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    drainWaiters.push(resolve);
  });
}

export async function playAudioBuffer(audio: ArrayBuffer, mime = 'audio/mpeg'): Promise<void> {
  cancelSpeech();
  const blob = new Blob([audio], { type: mime });
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  current = el;

  try {
    await new Promise<void>((resolve, reject) => {
      el.onended = () => resolve();
      el.onerror = () => reject(new Error('Audio playback failed'));
      void el.play().catch(reject);
    });
  } finally {
    URL.revokeObjectURL(url);
    if (current === el) current = null;
  }
}

/** Prefer ElevenLabs when keyed; else cleanest system neural voice. */
export async function speakFallback(text?: string): Promise<void> {
  const line = String(text ?? '').trim();
  if (line && window.avatarHost?.speakLine) {
    try {
      const result = await window.avatarHost.speakLine(line);
      if (result?.ok && result.audio) {
        const buf =
          result.audio instanceof ArrayBuffer
            ? result.audio
            : ArrayBuffer.isView(result.audio)
              ? result.audio.buffer.slice(
                  result.audio.byteOffset,
                  result.audio.byteOffset + result.audio.byteLength,
                )
              : new Uint8Array(result.audio as number[]).buffer;
        await playAudioBuffer(buf as ArrayBuffer, result.mime || 'audio/mpeg');
        return;
      }
    } catch (err) {
      console.warn('[tts] speakLine failed, using system voice', err);
    }
  }
  await browserSpeak(text);
}

export type ConverseResult =
  | {
      ok: true;
      userText: string;
      reply: string;
      mime: string | null;
      audio: ArrayBuffer | number[] | null;
      bridge?: string;
      tts?: 'local' | 'elevenlabs' | 'kokoro';
      ttsNote?: string;
      toolCalls?: number;
      spokeEarly?: boolean;
      streamed?: boolean;
      skipSpeak?: boolean;
    }
  | {
      ok: false;
      reason?: string;
      error?: string;
      userText?: string;
      reply?: string;
      audio?: null;
      skipSpeak?: boolean;
    };

export interface TtsChunk {
  epoch: number;
  kind?: string;
  index: number;
  sampleRate: number;
  text?: string;
  pcm: ArrayBuffer | Uint8Array | number[];
}

export interface BrainStatus {
  ready: boolean;
  brain?: string;
  stt?: string;
  tts?: string;
  ollama?: boolean;
  ollamaModel?: string;
  groqChatModel?: string;
  hasGroq?: boolean;
  hasOpenAI?: boolean;
  hasElevenLabs?: boolean;
  kokoro?: boolean;
  kokoroVoice?: string;
  kokoroDevice?: string;
  mcpTools?: number;
  emailBackend?: string;
  gwsAuthed?: boolean;
  voiceRuntime?: 'qwen' | 'converse';
  qwenWanted?: boolean;
  qwenConfigured?: boolean;
  qwenModel?: string;
  qwenVoice?: string;
}

export interface AvatarHost {
  getPlatform: () => Promise<{ platform: string; electron: string; dev: boolean; brainReady?: boolean }>;
  brainStatus: () => Promise<BrainStatus>;
  resetChat: () => Promise<{ ok: boolean }>;
  warmupTts?: () => Promise<{ ok: boolean; kokoro?: boolean; error?: string; skipped?: boolean; tts?: string; model?: string }>;
  gmailAuth?: () => Promise<{ ok: boolean; error?: string }>;
  converse: (utterance: {
    samples?: Float32Array | number[];
    sampleRate?: number;
    userText?: string;
  }) => Promise<ConverseResult>;
  transcribe?: (utterance: {
    samples?: Float32Array | number[];
    sampleRate?: number;
  }) => Promise<{ ok: boolean; text?: string; error?: string; reason?: string }>;
  qwenStart?: () => Promise<{ ok: boolean; error?: string; model?: string; voice?: string }>;
  qwenStop?: () => void;
  qwenPcm?: (pcm: ArrayBuffer, sampleRate: number) => void;
  qwenBargeIn?: () => void;
  qwenText?: (text: string) => void;
  cancelTts?: () => void;
  ttsPlaybackStart?: (info: { epoch: number; ttfa: number }) => void;
  onBridge?: (
    cb: (data: {
      text: string;
      mime?: string | null;
      tts?: string;
      audio?: ArrayBuffer | number[] | null;
    }) => void,
  ) => () => void;
  onSpeak?: (
    cb: (data: {
      text: string;
      mime?: string | null;
      tts?: string;
      audio?: ArrayBuffer | number[] | null;
    }) => void,
  ) => () => void;
  onTtsBegin?: (cb: (data: { epoch: number }) => void) => () => void;
  onTtsChunk?: (cb: (data: TtsChunk) => void) => () => void;
  onTtsEnd?: (cb: (data: { epoch: number }) => void) => () => void;
  onProgress?: (cb: (data: { phase?: string; text?: string; tool?: string }) => void) => () => void;
  onQwenEvent?: (cb: (data: { kind: string; text?: string; tool?: string }) => void) => () => void;
  onArtifact?: (cb: (data: { kind: string; title: string; url: string; id?: string }) => void) => () => void;
  onBoard?: (cb: (data: { cards: Array<Record<string, unknown>> }) => void) => () => void;
  boardGet?: () => Promise<{ cards: Array<Record<string, unknown>> }>;
  boardAct?: (args: Record<string, unknown>) => Promise<{ cards: Array<Record<string, unknown>> }>;
  hideBoard?: () => void;
  showBoard?: () => Promise<{ ok: boolean }>;
  openUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  dismissArtifact?: () => void;
  /** Short line TTS (ElevenLabs when keyed, else renderer falls back to system). */
  speakLine?: (text: string) => Promise<{
    ok: boolean;
    tts?: string;
    mime?: string;
    audio?: ArrayBuffer | Uint8Array | number[] | null;
    error?: string;
  }>;
  listReminders?: () => Promise<{ ok: boolean; reminders: Array<Record<string, unknown>> }>;
  addReminder?: (args: {
    text: string;
    when?: string;
    inMinutes?: number;
  }) => Promise<{ ok: boolean; error?: string; spokenHint?: string; when?: string }>;
  onNudge?: (
    cb: (data: { id: string; text: string; spoken: string; at: number }) => void,
  ) => () => void;
}

declare global {
  interface Window {
    avatarHost?: AvatarHost;
    SpeechRecognition?: typeof SpeechRecognition;
    webkitSpeechRecognition?: typeof SpeechRecognition;
  }
}
