#!/usr/bin/env node
/**
 * Persistent Kokoro TTS worker.
 * Loads the ONNX model once, then synthesizes phrase chunks on demand.
 *
 * Protocol (newline-delimited JSON on stdin/stdout):
 *   → { id, cmd: "warm" }
 *   → { id, cmd: "session-open", voice?, speed? }
 *   → { id, cmd: "session-push", text }
 *   → { id, cmd: "session-close" }
 *   → { id, cmd: "cancel" }
 *   ← { id, ok, event, ... }  chunk events carry base64 int16 PCM (no disk)
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = process.env.KOKORO_VOICE?.trim() || 'af_nova';

/** @type {import('kokoro-js').KokoroTTS | null} */
let tts = null;
/** @type {Promise<import('kokoro-js').KokoroTTS> | null} */
let loadPromise = null;
let loadedDevice = 'cpu';
let initMs = 0;
let warmupMs = 0;

/** @type {PhraseSession | null} */
let active = null;

function log(...args) {
  process.stderr.write(`${args.join(' ')}\n`);
}

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function floatToInt16Base64(pcm) {
  const buf = Buffer.allocUnsafe(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2);
  }
  return buf.toString('base64');
}

function deviceCandidates() {
  const envDev = process.env.KOKORO_DEVICE?.trim();
  if (envDev) return envDev === 'cpu' ? ['cpu'] : [envDev, 'cpu'];
  // DirectML loads on this machine but inference does not complete.
  // Default to CPU (the backend that already spoke). Opt in with KOKORO_DEVICE=dml.
  return ['cpu'];
}

function attachInferTimer(model) {
  const orig = model.generate_from_ids.bind(model);
  model.generate_from_ids = async function generateFromIdsTimed(...args) {
    const t = Date.now();
    try {
      return await orig(...args);
    } finally {
      model._lastInferMs = Date.now() - t;
    }
  };
}

async function loadModelOnce() {
  const tInit = Date.now();
  const { KokoroTTS } = await import('kokoro-js');
  const { env: hfEnv } = await import('@huggingface/transformers');
  hfEnv.cacheDir = join(here, '../../.cache/huggingface');
  hfEnv.allowLocalModels = true;

  const devices = deviceCandidates();
  const attempts = [];
  for (const device of devices) {
    attempts.push({ device, dtype: 'q8' });
    if (device !== 'cpu') attempts.push({ device, dtype: 'fp32' });
  }

  let lastErr = null;
  for (const { device, dtype } of attempts) {
    try {
      log(`[TTS] loading device=${device} dtype=${dtype}`);
      const model = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype,
        device,
      });
      attachInferTimer(model);
      tts = model;
      loadedDevice = device;
      initMs = Date.now() - tInit;
      log(`[TTS] model_ready device=${device} dtype=${dtype} initMs=${initMs}`);
      return tts;
    } catch (err) {
      lastErr = err;
      log(
        `[TTS] device=${device} dtype=${dtype} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  throw lastErr || new Error('Kokoro failed to load');
}

function loadModel() {
  if (tts) return Promise.resolve(tts);
  if (!loadPromise) {
    loadPromise = loadModelOnce().catch((err) => {
      loadPromise = null;
      throw err;
    });
  }
  return loadPromise;
}

function ensure() {
  return loadModel();
}

class PhraseSession {
  /**
   * @param {{ id: number, voice: string, speed: number }} opts
   */
  constructor({ id, voice, speed }) {
    this.id = id;
    this.voice = voice;
    this.speed = speed;
    this.queue = [];
    this.closed = false;
    this.cancelled = false;
    this.index = 0;
    this._wake = null;
    this.started = Date.now();
    this.finished = this.loop();
  }

  push(text) {
    if (this.closed || this.cancelled) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    this.queue.push(trimmed);
    this._wake?.();
  }

  close() {
    this.closed = true;
    this._wake?.();
  }

  cancel() {
    this.cancelled = true;
    this.queue.length = 0;
    this.closed = true;
    this._wake?.();
  }

  async _nextPhrase() {
    for (;;) {
      if (this.cancelled) return null;
      if (this.queue.length) return this.queue.shift();
      if (this.closed) return null;
      await new Promise((r) => {
        this._wake = r;
      });
      this._wake = null;
    }
  }

  async loop() {
    const model = await ensure();
    try {
      for (;;) {
        const phrase = await this._nextPhrase();
        if (phrase == null) break;
        if (this.cancelled) break;

        const tSynth = Date.now();
        model._lastInferMs = 0;
        try {
          // generate() per phrase — model.stream(string) never closes its
          // TextSplitterStream, so a sentence ending in .!? waits forever.
          const raw = await model.generate(phrase, {
            voice: this.voice,
            speed: this.speed,
          });
          if (this.cancelled) break;
          const inferMs = Number(model._lastInferMs) || Date.now() - tSynth;
          const synthMs = Date.now() - tSynth;
          const g2pMs = Math.max(0, synthMs - inferMs);

          const pcm = raw?.audio ?? raw?.data;
          const rate = raw?.sampling_rate ?? 24000;
          if (!pcm?.length) continue;

          const tEnc = Date.now();
          const b64 = floatToInt16Base64(
            pcm instanceof Float32Array ? pcm : new Float32Array(pcm),
          );
          const encodeMs = Date.now() - tEnc;
          const index = this.index++;
          if (index === 0) {
            log(
              `[TTS] first_audio session=${this.id} g2pMs=${g2pMs} inferMs=${inferMs} encodeMs=${encodeMs} chars=${phrase.length}`,
            );
          }
          log(
            `[TTS] chunk session=${this.id} index=${index} inferMs=${inferMs} g2pMs=${g2pMs} encodeMs=${encodeMs} samples=${pcm.length}`,
          );
          write({
            id: this.id,
            ok: true,
            event: 'chunk',
            index,
            sampleRate: rate,
            pcm: b64,
            text: phrase,
            phonemes: '',
            g2pMs,
            inferMs,
            encodeMs,
            emittedAt: Date.now(),
          });
        } catch (err) {
          if (this.cancelled) break;
          const message = err instanceof Error ? err.message : String(err);
          log('[TTS] generate failed:', message);
          write({
            id: this.id,
            ok: false,
            event: 'error',
            error: message,
          });
          break;
        }
      }
    } finally {
      if (active === this) active = null;
      if (this.cancelled) {
        write({ id: this.id, ok: true, event: 'cancelled' });
      } else {
        log(
          `[TTS] complete session=${this.id} chunks=${this.index} totalMs=${Date.now() - this.started}`,
        );
        write({
          id: this.id,
          ok: true,
          event: 'done',
          chunks: this.index,
          totalMs: Date.now() - this.started,
          device: loadedDevice,
        });
      }
    }
  }
}

async function handle(msg) {
  const { id, cmd } = msg;
  if (cmd === 'warm') {
    // Load weights only — a dummy DirectML compile here blocked every speak.
    await loadModel();
    write({
      id,
      ok: true,
      event: 'warm',
      device: loadedDevice,
      initMs,
      warmupMs,
    });
    return;
  }

  if (cmd === 'session-open') {
    if (active && !active.cancelled) active.cancel();
    active = new PhraseSession({
      id,
      voice: msg.voice || DEFAULT_VOICE,
      speed: Number(msg.speed) || 1.05,
    });
    write({ id, ok: true, event: 'opened', device: loadedDevice });
    return;
  }

  if (cmd === 'session-push') {
    if (!active || active.id !== id) {
      write({ id, ok: false, error: 'no active TTS session' });
      return;
    }
    active.push(msg.text);
    return;
  }

  if (cmd === 'session-close') {
    if (!active || active.id !== id) {
      write({ id, ok: true, event: 'done', chunks: 0, totalMs: 0 });
      return;
    }
    active.close();
    return;
  }

  if (cmd === 'cancel') {
    if (active) {
      active.cancel();
    } else {
      write({ id, ok: true, event: 'cancelled' });
    }
    return;
  }

  write({ id, ok: false, error: `unknown cmd ${cmd}` });
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let warmChain = Promise.resolve();

function fail(msg, err) {
  write({
    id: msg?.id ?? 0,
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  });
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const realtime =
    msg.cmd === 'session-open' ||
    msg.cmd === 'session-push' ||
    msg.cmd === 'session-close' ||
    msg.cmd === 'cancel';
  if (realtime) {
    Promise.resolve()
      .then(() => handle(msg))
      .catch((err) => fail(msg, err));
    return;
  }
  warmChain = warmChain.then(() => handle(msg)).catch((err) => fail(msg, err));
});

write({ id: 0, ok: true, ready: true });
