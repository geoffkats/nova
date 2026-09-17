/**
 * Local Kokoro-82M TTS — persistent child worker + streaming phrase synthesis.
 * The ONNX model stays resident; phrases are synthesized as they arrive.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSentenceBuffer } from './sentences.js';

const here = dirname(fileURLToPath(import.meta.url));
const childPath = join(here, 'kokoroChild.mjs');

/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
/** @type {Map<number, (msg: any) => void>} */
const handlers = new Map();
let nextId = 1;
let ready = false;
/** @type {Promise<void> | null} */
let boot = null;
let lastDevice = 'cpu';
/** Set to 'cpu' after a hung DirectML worker so the next spawn skips GPU. */
let forceDevice = '';

/** Short-phrase cache (greetings / repeats) — skip ONNX entirely. */
/** @type {Map<string, { pcm: Buffer, sampleRate: number }>} */
const phraseCache = new Map();
const PHRASE_CACHE_MAX = 48;

function cacheKey(text, voice, speed) {
  return `${voice}|${speed}|${text}`;
}

function send(msg) {
  if (!child?.stdin?.writable) throw new Error('Kokoro child not running');
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function ensureChild() {
  if (child && !child.killed) return;
  child = spawn(process.execPath, [childPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...(forceDevice ? { KOKORO_DEVICE: forceDevice } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stderr?.on('data', (buf) => {
    const line = String(buf).trim();
    if (line) console.log('[kokoro-child]', line.slice(0, 400));
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.ready) {
      ready = true;
      return;
    }
    const handler = handlers.get(msg.id);
    if (!handler) return;
    handler(msg);
  });

  child.on('exit', (code) => {
    console.warn('[kokoro-child] exited', code);
    for (const [, h] of handlers) {
      try {
        h({ ok: false, event: 'error', error: 'Kokoro child exited' });
      } catch {
        /* ignore */
      }
    }
    handlers.clear();
    child = null;
    ready = false;
    boot = null;
    if (code === 2 && forceDevice !== 'cpu') {
      forceDevice = 'cpu';
      lastDevice = 'cpu';
      console.warn('[TTS] GPU inference hung — restarting Kokoro on CPU');
      void ensureKokoro().catch((err) => {
        console.warn('[kokoro] CPU restart failed:', err instanceof Error ? err.message : err);
      });
    }
  });
}

/**
 * @param {(msg: string) => void} [onProgress]
 */
export async function ensureKokoro(onProgress) {
  if (!boot) {
    boot = (async () => {
      onProgress?.('Warming Kokoro voice (background)…');
      ensureChild();
      const start = Date.now();
      while (!ready && Date.now() - start < 15_000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const id = nextId++;
      const warm = await new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          handlers.delete(id);
          reject(new Error('Kokoro warm timed out'));
        }, 90_000);
        handlers.set(id, (msg) => {
          if (msg.event === 'warm' || msg.ok === false) {
            clearTimeout(t);
            handlers.delete(id);
            if (msg.ok) resolve(msg);
            else reject(new Error(msg.error || 'Kokoro warm failed'));
          }
        });
        try {
          send({ id, cmd: 'warm' });
        } catch (err) {
          clearTimeout(t);
          handlers.delete(id);
          reject(err);
        }
      });
      lastDevice = warm.device || lastDevice;
      console.log(
        `[TTS] model_ready device=${lastDevice} initMs=${warm.initMs ?? '?'} warmupMs=${warm.warmupMs ?? '?'}`,
      );
      onProgress?.('Kokoro ready');
    })().catch((err) => {
      boot = null;
      if (forceDevice !== 'cpu') {
        forceDevice = 'cpu';
        lastDevice = 'cpu';
        try {
          child?.kill();
        } catch {
          /* ignore */
        }
        child = null;
        ready = false;
        console.warn('[TTS] warm failed — restarting Kokoro on CPU:', err instanceof Error ? err.message : err);
        return ensureKokoro(onProgress);
      }
      throw err;
    });
  }
  return boot;
}

export function kokoroDevice() {
  return lastDevice;
}

/**
 * Open a streaming synthesis session. Push phrases; each becomes an audio chunk.
 *
 * @param {{
 *   voice?: string,
 *   speed?: number,
 *   onChunk?: (chunk: {
 *     index: number,
 *     sampleRate: number,
 *     pcm: Buffer,
 *     text: string,
 *     g2pMs: number,
 *     inferMs: number,
 *     encodeMs: number,
 *     ipcMs: number,
 *   }) => void,
 *   isCancelled?: () => boolean,
 * }} opts
 */
export async function openKokoroSession(opts = {}) {
  ensureChild();
  void ensureKokoro().catch(() => {});
  const waitReady = Date.now();
  while (!ready && Date.now() - waitReady < 15_000) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const id = nextId++;
  const voice = opts.voice || 'af_nova';
  const speed = opts.speed || 1.05;
  let opened = false;
  let settled = false;

  const done = new Promise((resolve, reject) => {
    handlers.set(id, (msg) => {
      if (opts.isCancelled?.()) {
        if (!settled) {
          settled = true;
          handlers.delete(id);
          resolve({ cancelled: true, chunks: 0 });
        }
        return;
      }
      if (msg.event === 'opened') {
        opened = true;
        lastDevice = msg.device || lastDevice;
        return;
      }
      if (msg.event === 'chunk' && msg.ok) {
        const ipcMs = typeof msg.emittedAt === 'number' ? Math.max(0, Date.now() - msg.emittedAt) : 0;
        const pcm = Buffer.from(String(msg.pcm || ''), 'base64');
        opts.onChunk?.({
          index: msg.index,
          sampleRate: msg.sampleRate || 24000,
          pcm,
          text: msg.text || '',
          g2pMs: msg.g2pMs || 0,
          inferMs: msg.inferMs || 0,
          encodeMs: msg.encodeMs || 0,
          ipcMs,
        });
        return;
      }
      if (msg.event === 'done' || msg.event === 'cancelled') {
        if (!settled) {
          settled = true;
          handlers.delete(id);
          resolve({ cancelled: msg.event === 'cancelled', chunks: msg.chunks || 0, totalMs: msg.totalMs });
        }
        return;
      }
      if (msg.ok === false) {
        if (!settled) {
          settled = true;
          handlers.delete(id);
          reject(new Error(msg.error || 'Kokoro session error'));
        }
      }
    });
  });

  send({ id, cmd: 'session-open', voice, speed });

  const openedAt = Date.now();
  while (!opened && !settled && Date.now() - openedAt < 15_000) {
    await new Promise((r) => setTimeout(r, 10));
  }

  return {
    /**
     * @param {string} text
     */
    push(text) {
      if (settled || opts.isCancelled?.()) return;
      const trimmed = String(text || '').trim();
      if (!trimmed) return;
      send({ id, cmd: 'session-push', text: trimmed });
    },
    async close() {
      if (settled) return done;
      try {
        send({ id, cmd: 'session-close' });
      } catch {
        if (!settled) {
          settled = true;
          handlers.delete(id);
        }
      }
      return done;
    },
    cancel() {
      if (settled) return;
      try {
        send({ id, cmd: 'cancel' });
      } catch {
        /* child gone */
      }
    },
    done,
  };
}

export function cancelKokoro() {
  if (!child?.stdin?.writable) return;
  try {
    send({ id: nextId++, cmd: 'cancel' });
  } catch {
    /* ignore */
  }
}

/**
 * Stream a full string (or token sequence) through sentence splitting + Kokoro.
 *
 * @param {{
 *   text?: string,
 *   voice?: string,
 *   speed?: number,
 *   onChunk?: Function,
 *   isCancelled?: () => boolean,
 * }} opts
 */
export function createSpeechPipeline(opts) {
  const voice = opts.voice || 'af_nova';
  const speed = opts.speed || 1.05;
  const buf = createSentenceBuffer();
  let tRequest = 0;
  let sessionPromise = null;
  let firstAudio = true;
  let chunkCount = 0;
  let opened = false;

  async function session() {
    if (!sessionPromise) {
      sessionPromise = openKokoroSession({
        voice,
        speed,
        isCancelled: opts.isCancelled,
        onChunk: (chunk) => {
          if (opts.isCancelled?.()) return;
          chunkCount += 1;
          if (firstAudio) {
            firstAudio = false;
            const ttfa = Date.now() - tRequest;
            console.log(
              `[TTS] first_audio ttfa=${ttfa}ms g2p=${chunk.g2pMs}ms infer=${chunk.inferMs}ms encode=${chunk.encodeMs}ms ipc=${chunk.ipcMs}ms chars=${chunk.text.length}`,
            );
          }
          console.log(
            `[TTS] chunk index=${chunk.index} infer=${chunk.inferMs}ms g2p=${chunk.g2pMs}ms samples=${chunk.pcm.length / 2}`,
          );
          if (chunk.text && chunk.text.length <= 96 && chunk.pcm?.length) {
            const key = cacheKey(chunk.text, voice, speed);
            if (phraseCache.size >= PHRASE_CACHE_MAX) {
              const first = phraseCache.keys().next().value;
              if (first != null) phraseCache.delete(first);
            }
            phraseCache.set(key, { pcm: Buffer.from(chunk.pcm), sampleRate: chunk.sampleRate });
          }
          opts.onChunk?.(chunk);
        },
      });
      opened = true;
    }
    return sessionPromise;
  }

  /**
   * @param {string} text
   */
    async function emitPhrase(text) {
    if (opts.isCancelled?.()) return;
    const phrase = String(text || '').trim();
    if (!phrase) return;
    if (!tRequest) {
      tRequest = Date.now();
      console.log(`[TTS] request voice=${voice} speed=${speed} chars=${phrase.length}`);
    }

    const key = cacheKey(phrase, voice, speed);
    const hit = !sessionPromise ? phraseCache.get(key) : null;
    if (hit) {
      console.log('[tts] kokoro cache hit', JSON.stringify(phrase).slice(0, 60));
      const chunk = {
        index: chunkCount,
        sampleRate: hit.sampleRate,
        pcm: Buffer.from(hit.pcm),
        text: phrase,
        g2pMs: 0,
        inferMs: 0,
        encodeMs: 0,
        ipcMs: 0,
      };
      chunkCount += 1;
      if (firstAudio) {
        firstAudio = false;
        console.log(`[TTS] first_audio ttfa=${Date.now() - tRequest}ms cache=1`);
      }
      opts.onChunk?.(chunk);
      return;
    }

    try {
      const sess = await session();
      sess.push(phrase);
    } catch (err) {
      console.warn('[TTS] emit failed:', err instanceof Error ? err.message : err);
    }
  }

  return {
    /**
     * Accept raw LLM tokens; emit complete phrases immediately.
     * @param {string} token
     */
    async push(token) {
      if (opts.isCancelled?.()) return;
      for (const sentence of buf.push(token)) {
        await emitPhrase(sentence);
      }
    },

    /**
     * Push a complete string (already a full reply or bridge line).
     * @param {string} text
     */
    async pushText(text) {
      if (opts.isCancelled?.()) return;
      for (const sentence of buf.push(text)) {
        await emitPhrase(sentence);
      }
    },

    async end() {
      try {
        if (opts.isCancelled?.()) {
          const sess = sessionPromise ? await sessionPromise.catch(() => null) : null;
          sess?.cancel();
          return { streamed: true, chunks: chunkCount, cancelled: true };
        }
        for (const sentence of buf.flush()) {
          await emitPhrase(sentence);
        }
        if (opened && sessionPromise) {
          const sess = await sessionPromise;
          const result = await sess.close();
          console.log(
            `[TTS] complete chunks=${chunkCount} totalMs=${tRequest ? Date.now() - tRequest : 0} cancelled=${Boolean(result?.cancelled)}`,
          );
          return { streamed: chunkCount > 0, chunks: chunkCount, cancelled: Boolean(result?.cancelled) };
        }
        console.log(`[TTS] complete chunks=${chunkCount} totalMs=${tRequest ? Date.now() - tRequest : 0}`);
        return { streamed: chunkCount > 0, chunks: chunkCount, cancelled: false };
      } catch (err) {
        console.warn('[TTS] end failed:', err instanceof Error ? err.message : err);
        return { streamed: chunkCount > 0, chunks: chunkCount, cancelled: false };
      }
    },

    cancel() {
      if (sessionPromise) {
        void sessionPromise.then((s) => s.cancel()).catch(() => {});
      }
    },

    remember(text, chunk) {
      if (String(text).length > 96) return;
      const key = cacheKey(text, voice, speed);
      if (phraseCache.size >= PHRASE_CACHE_MAX) {
        const first = phraseCache.keys().next().value;
        if (first != null) phraseCache.delete(first);
      }
      phraseCache.set(key, { pcm: Buffer.from(chunk.pcm), sampleRate: chunk.sampleRate });
    },
  };
}

/**
 * Back-compat: synthesize a complete utterance into one WAV-like PCM payload.
 * Prefer createSpeechPipeline for streaming playback.
 *
 * @param {{ text: string, voice?: string, speed?: number }} opts
 * @returns {Promise<{ audio: ArrayBuffer, mime: string }>}
 */
export async function synthesizeKokoro({ text, voice = 'af_nova', speed = 1.05 }) {
  const parts = [];
  let sampleRate = 24000;
  const pipe = createSpeechPipeline({
    voice,
    speed,
    onChunk: (chunk) => {
      sampleRate = chunk.sampleRate || sampleRate;
      parts.push(chunk.pcm);
    },
  });
  await pipe.pushText(text);
  await pipe.end();
  const pcm = Buffer.concat(parts);
  // Wrap int16 PCM in a WAV header so existing HTMLAudio playback still works.
  const { encodeWav } = await import('./wav.js');
  const f32 = new Float32Array(pcm.length / 2);
  for (let i = 0; i < f32.length; i++) f32[i] = pcm.readInt16LE(i * 2) / 32768;
  const wav = encodeWav(f32, sampleRate);
  return { audio: wav, mime: 'audio/wav' };
}

export function kokoroReady() {
  return ready && Boolean(boot);
}
