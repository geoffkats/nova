/**
 * Qwen Audio 3.0 Realtime (DashScope) — Nova stays the face.
 *
 * Full-duplex: 16 kHz PCM in, 24 kHz PCM out over one WebSocket.
 * Groq + Kokoro remain the fallback when this runtime is off or unkeyed.
 *
 * Protocol: https://www.alibabacloud.com/help/en/model-studio/qwen-audio-realtime-user-guides
 */

import { randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNovaInstructions } from './novaMind.js';

const INPUT_RATE = 16000;
const OUTPUT_RATE = 24000;
const DEFAULT_MODEL = 'qwen-audio-3.0-realtime-plus';
const FLASH_MODEL = 'qwen-audio-3.0-realtime-flash';
const DEFAULT_VOICE = 'longanqian';
/** Omni preset voices (Qwen-Audio `long*` names are rejected). */
const OMNI_DEFAULT_VOICE = 'Ethan';
const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../.env');
const CN_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
const INTL_URL = 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime';

/** Qwen-Audio realtime voices use the `long…` family; Omni uses Ethan/Cherry/Tina/… */
function isAudioOnlyVoice(voice) {
  return /^long/i.test(String(voice || ''));
}

function isOmniModel(model = qwenModel()) {
  return /omni/i.test(String(model || ''));
}

function isAudioRealtimeModel(model = qwenModel()) {
  return /qwen-audio.*realtime/i.test(String(model || ''));
}

/** Pick up .env edits without a full Electron restart (Vite HMR does not reload main). */
function refreshEnv() {
  loadEnv({ path: ENV_PATH, override: true });
}

function omniFallbackVoice(model = qwenModel()) {
  const m = String(model || '').toLowerCase();
  if (m.includes('3.5')) return 'Tina';
  if (m.includes('turbo')) return 'Chelsie';
  if (m.includes('flash')) return 'Cherry';
  return OMNI_DEFAULT_VOICE;
}

export function qwenKey() {
  return (
    process.env.QWEN_AUDIO_REALTIME_API_KEY?.trim() ||
    process.env.DASHSCOPE_API_KEY?.trim() ||
    ''
  );
}

export function qwenWanted() {
  const v = (process.env.VOICE_RUNTIME?.trim() || '').toLowerCase();
  return v === 'qwen' || v === 'qwen-audio' || v === 'dashscope';
}

export function qwenConfigured() {
  return Boolean(qwenKey());
}

export function qwenEnabled() {
  return qwenWanted() && qwenConfigured();
}

export function qwenModel() {
  return process.env.QWEN_AUDIO_REALTIME_MODEL?.trim() || DEFAULT_MODEL;
}

export function qwenVoice() {
  const omni = isOmniModel();
  const override = process.env.QWEN_AUDIO_REALTIME_VOICE?.trim();
  const fallback = omni ? omniFallbackVoice() : DEFAULT_VOICE;
  const voice = override || fallback;
  // Stale .env / Audio defaults must never be sent to Omni models.
  if (omni && isAudioOnlyVoice(voice)) {
    console.warn(`[qwen] voice "${voice}" is Qwen-Audio only — using ${fallback} for Omni`);
    return fallback;
  }
  return voice;
}

export function qwenBaseUrl() {
  const override = process.env.QWEN_AUDIO_REALTIME_BASE_URL?.trim() || process.env.QWEN_AUDIO_REALTIME_URL?.trim();
  if (override) return override.replace(/\?+$/, '');
  const workspace = process.env.DASHSCOPE_WORKSPACE_ID?.trim();
  const region = (process.env.DASHSCOPE_REGION?.trim() || 'cn').toLowerCase();
  if (workspace) {
    const host =
      region === 'intl' || region === 'international' || region === 'sg'
        ? `${workspace}.ap-southeast-1.maas.aliyuncs.com`
        : `${workspace}.cn-beijing.maas.aliyuncs.com`;
    return `wss://${host}/api-ws/v1/realtime`;
  }
  if (region === 'intl' || region === 'international' || region === 'sg') return INTL_URL;
  return CN_URL;
}

function realtimeUrl(model = qwenModel()) {
  const base = qwenBaseUrl();
  const encoded = encodeURIComponent(model);
  return base.includes('?') ? `${base}&model=${encoded}` : `${base}?model=${encoded}`;
}

function isQuotaExhausted(text) {
  return /free tier of the model has been exhausted|quota is used up|quota.*exhaust|Arrearage|insufficient.*balance/i.test(
    String(text || ''),
  );
}

function friendlyClose(reason, code) {
  const text = String(reason || '').replace(/\u0000/g, '').trim();
  if (isQuotaExhausted(text)) {
    return 'Qwen free quota is used up. Enable billing in Model Studio, or set QWEN_AUDIO_REALTIME_MODEL=qwen-audio-3.0-realtime-flash';
  }
  if (text) return text;
  if (code === 1006) return 'Qwen socket closed (1006)';
  if (code != null) return `Qwen socket closed (${code})`;
  return 'Qwen disconnected';
}

/** DashScope close reasons often exceed RFC 6455's 125-byte control-frame limit. */
function captureOversizedClose(socket) {
  let last = '';
  let raw = null;
  const onData = (chunk) => {
    if (!Buffer.isBuffer(chunk) || chunk.length < 8) return;
    if ((chunk[0] & 0x0f) !== 8) return;
    if ((chunk[1] & 0x7f) !== 126) return;
    const payloadLen = chunk.readUInt16BE(2);
    const payload = chunk.subarray(4, Math.min(chunk.length, 4 + payloadLen));
    if (payload.length >= 2) {
      last = payload.subarray(2).toString('utf8').replace(/\u0000/g, '').trim();
    }
  };
  const attach = (sock) => {
    if (!sock || sock === raw || typeof sock.prependListener !== 'function') return;
    raw = sock;
    sock.prependListener('data', onData);
  };
  attach(socket?._socket);
  if (typeof socket?.once === 'function') {
    socket.once('upgrade', (res) => attach(res?.socket || socket._socket));
    socket.once('open', () => attach(socket._socket));
  }
  return {
    read: () => last,
    forget() {
      raw?.removeListener('data', onData);
    },
  };
}

function eventId() {
  return `event_${randomUUID().replaceAll('-', '')}`;
}

function toRealtimeTools(openaiTools) {
  const out = [];
  for (const tool of openaiTools ?? []) {
    const fn = tool?.function ?? tool;
    const name = String(fn?.name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    if (!name) continue;
    const parameters = sanitizeSchema(fn?.parameters ?? { type: 'object', properties: {} });
    out.push({
      type: 'function',
      function: {
        name,
        description: String(fn?.description || name).slice(0, 1024),
        parameters,
      },
    });
  }
  return out;
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const rest = { ...schema };
  delete rest.$schema;
  delete rest.$defs;
  delete rest.definitions;
  return rest.type ? rest : { type: 'object', properties: rest.properties ?? {} };
}

function listen(socket, type, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(type, handler);
    return;
  }
  if (type === 'message') {
    socket.on('message', (data) => handler({ data }));
    return;
  }
  if (type === 'close') {
    socket.on('close', (code, reason) => handler({ code, reason }));
    return;
  }
  socket.on(type, handler);
}

function asPcmBuffer(pcm) {
  if (Buffer.isBuffer(pcm)) return pcm;
  if (pcm instanceof ArrayBuffer) return Buffer.from(pcm);
  if (ArrayBuffer.isView(pcm)) return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return Buffer.from(pcm);
}

function decodePcm(b64) {
  return Buffer.from(b64 || '', 'base64');
}

function resampleInt16(pcm, fromRate, toRate) {
  if (!fromRate || fromRate === toRate) return pcm;
  const src = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const ratio = fromRate / toRate;
  const n = Math.max(1, Math.floor(src.length / ratio));
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const t = x - i0;
    out[i] = Math.round(src[i0] * (1 - t) + src[i1] * t);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

async function openSocket(url, headers) {
  try {
    const mod = await import('ws');
    const WS = mod.default || mod.WebSocket;
    if (WS) return new WS(url, { headers, perMessageDeflate: false });
  } catch {
    /* optional dependency */
  }
  try {
    const { WebSocket: UndiciWS } = await import('undici');
    if (UndiciWS) return new UndiciWS(url, { headers });
  } catch {
    /* Electron / Node global WebSocket */
  }
  return new WebSocket(url, { headers });
}

/**
 * @param {{
 *   executeTool?: (name: string, args: Record<string, unknown>) => Promise<string>,
 *   listTools?: () => Promise<unknown[]>,
 *   onEvent?: (ev: { kind: string, text?: string, tool?: string }) => void,
 *   onAudioBegin?: (info: { epoch: number }) => void,
 *   onAudioChunk?: (chunk: { epoch: number, index: number, sampleRate: number, text?: string, pcm: Buffer }) => void,
 *   onAudioEnd?: (info: { epoch: number }) => void,
 * }} hooks
 */
export function createQwenSession(hooks = {}) {
  /** @type {WebSocket | null} */
  let ws = null;
  let ready = false;
  let closing = false;
  let epoch = 0;
  let chunkIndex = 0;
  let audioOpen = false;
  let responseActive = false;
  let ignoreAudio = false;
  let transcript = '';
  /** @type {Array<{ call_id: string, name: string, arguments: string }>} */
  let pendingCalls = [];
  let toolsBusy = false;
  /** @type {Buffer[]} */
  let pcmQueue = [];
  let connectPromise = null;
  let activeModel = qwenModel();
  /** @type {{ resolve: () => void, reject: (err: Error) => void } | null} */
  let handshake = null;

  function emit(kind, extra = {}) {
    try {
      hooks.onEvent?.({ kind, ...extra });
    } catch {
      /* renderer gone */
    }
  }

  function send(payload) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify({ event_id: eventId(), ...payload }));
      return true;
    } catch (err) {
      console.warn('[qwen] send failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  function beginAudio() {
    if (audioOpen) return;
    audioOpen = true;
    chunkIndex = 0;
    epoch += 1;
    hooks.onAudioBegin?.({ epoch });
  }

  function endAudio() {
    if (!audioOpen) return;
    audioOpen = false;
    hooks.onAudioEnd?.({ epoch });
  }

  /** DashScope errors if we cancel when nothing is generating. */
  function cancelActiveResponse() {
    ignoreAudio = true;
    endAudio();
    if (!responseActive) return;
    responseActive = false;
    send({ type: 'response.cancel' });
  }

  function flushPcmQueue() {
    if (!ready) return;
    for (const buf of pcmQueue.splice(0)) {
      send({
        type: 'input_audio_buffer.append',
        audio: buf.toString('base64'),
      });
    }
  }

  async function applySession() {
    let tools = [];
    try {
      tools = toRealtimeTools((await hooks.listTools?.()) ?? []);
    } catch (err) {
      console.warn('[qwen] tools list failed:', err instanceof Error ? err.message : err);
    }
    const omni = isOmniModel(activeModel);
    const session = {
      modalities: ['text', 'audio'],
      instructions: buildNovaInstructions(),
      voice: qwenVoice(),
      input_audio_format: 'pcm',
      output_audio_format: 'pcm',
      // Qwen-Audio: smart_turn. Qwen-Omni: server_vad / semantic_vad only.
      turn_detection: omni
        ? { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 }
        : { type: 'smart_turn' },
    };
    if (!omni) session.max_history_turns = 30;
    if (tools.length) session.tools = tools;
    send({ type: 'session.update', session });
    console.log(
      `[qwen] session.update model=${activeModel} voice=${qwenVoice()} vad=${session.turn_detection.type} tools=${tools.length}`,
    );
  }

  async function runPendingTools() {
    const calls = pendingCalls.splice(0);
    if (!calls.length) return;
    toolsBusy = true;
    emit('thinking', { text: 'checking…' });
    for (const call of calls) {
      const name = call.name || 'tool';
      emit('tool', { text: name, tool: name });
      let output = '';
      try {
        const args = JSON.parse(call.arguments || '{}');
        output = (await hooks.executeTool?.(name, args)) ?? '';
      } catch (err) {
        output = JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
      }
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.call_id,
          output: typeof output === 'string' ? output : JSON.stringify(output),
        },
      });
    }
    toolsBusy = false;
    send({
      type: 'response.create',
      response: { modalities: ['audio', 'text'] },
    });
  }

  function handleEvent(event) {
    const type = event?.type;
    if (!type) return;

    switch (type) {
      case 'session.created':
        console.log(`[qwen] event session.created model=${activeModel}`);
        void applySession();
        break;
      case 'session.updated':
        ready = true;
        flushPcmQueue();
        emit('connected', { text: `qwen ${activeModel}` });
        handshake?.resolve();
        handshake = null;
        break;
      case 'input_audio_buffer.speech_started':
        // Audio smart_turn / Omni server_vad both drop the assistant turn.
        // Extra response.cancel produced "Conversation has no active response".
        ignoreAudio = true;
        endAudio();
        responseActive = false;
        emit('speech_started', { text: 'heard you' });
        break;
      case 'input_audio_buffer.speech_stopped':
        emit('thinking', { text: 'thinking…' });
        break;
      case 'conversation.item.input_audio_transcription.completed': {
        const userText = String(event.transcript || '').trim();
        if (userText) emit('user', { text: userText });
        break;
      }
      case 'response.created':
        transcript = '';
        responseActive = true;
        ignoreAudio = false;
        break;
      case 'response.cancelled':
        responseActive = false;
        ignoreAudio = true;
        endAudio();
        break;
      case 'response.audio.delta': {
        if (ignoreAudio) break;
        const b64 = event.delta || event.audio;
        if (!b64) break;
        beginAudio();
        const pcm = decodePcm(b64);
        chunkIndex += 1;
        hooks.onAudioChunk?.({
          epoch,
          index: chunkIndex,
          sampleRate: OUTPUT_RATE,
          text: transcript || undefined,
          pcm,
        });
        break;
      }
      case 'response.audio_transcript.delta':
      case 'response.text.delta': {
        const piece = event.delta || event.text || '';
        if (piece) {
          transcript += piece;
          emit('nova', { text: transcript });
        }
        break;
      }
      case 'response.audio_transcript.done':
      case 'response.text.done': {
        const done = String(event.transcript || event.text || transcript).trim();
        if (done) {
          transcript = done;
          emit('nova', { text: done });
        }
        break;
      }
      case 'response.function_call_arguments.done':
        pendingCalls.push({
          call_id: event.call_id,
          name: event.name,
          arguments: event.arguments || '{}',
        });
        break;
      case 'response.done':
        responseActive = false;
        endAudio();
        if (pendingCalls.length) {
          void runPendingTools();
        } else if (!toolsBusy) {
          emit('done', { text: 'back to listening' });
        }
        break;
      case 'error': {
        const message = event.error?.message || event.message || 'qwen error';
        if (/no active response/i.test(message)) return;
        console.warn('[qwen] error:', message);
        emit('error', { text: message });
        break;
      }
      default:
        break;
    }
  }

  async function connectOnce(model) {
    refreshEnv();
    const key = qwenKey();
    const url = realtimeUrl(model);
    activeModel = model;
    ready = false;
    console.log(`[qwen] connecting ${url.replace(/\?.*/, '')} model=${model}`);
    const socket = await openSocket(url, {
      Authorization: `Bearer ${key}`,
      'x-dashscope-dataInspection': 'disable',
    });
    ws = socket;
    const capture = captureOversizedClose(socket);

    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Qwen realtime connect timed out')), 12_000);
      listen(socket, 'open', () => {
        clearTimeout(timer);
        resolve();
      });
      listen(socket, 'error', (err) => {
        const msg = err?.message || err?.error?.message || '';
        if (/invalid payload length/i.test(String(msg))) return;
        clearTimeout(timer);
        reject(new Error(capture.read() || 'Qwen realtime socket error'));
      });
    });

    const updated = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Qwen session timed out')), 15_000);
      handshake = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
    });

    // Keep a handler on both from t0 — if close rejects `updated` while we only
    // awaited `opened`, Node treats it as an unhandled rejection.
    opened.catch(() => {});
    updated.catch(() => {});
    const readySession = Promise.all([opened, updated]);

    listen(socket, 'message', (msg) => {
      const raw = typeof msg.data === 'string' ? msg.data : Buffer.from(msg.data).toString('utf8');
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      handleEvent(event);
    });

    listen(socket, 'close', (ev) => {
      const code = ev?.code;
      const reason =
        capture.read() ||
        (typeof ev?.reason === 'string' ? ev.reason : Buffer.isBuffer(ev?.reason) ? ev.reason.toString('utf8') : '');
      const message = friendlyClose(reason, code);
      console.warn(`[qwen] socket closed${code != null ? ` code=${code}` : ''}${reason ? ` ${reason}` : ''}`);
      capture.forget();
      ready = false;
      if (ws === socket) ws = null;
      endAudio();
      const pending = handshake;
      handshake = null;
      if (pending) {
        pending.reject(new Error(message));
      } else if (!closing) {
        emit('error', { text: message });
      }
    });

    await readySession;
    capture.forget();
    return { ok: true, model, voice: qwenVoice() };
  }

  async function start() {
    refreshEnv();
    if (ready && ws && ws.readyState === 1) return { ok: true, reused: true, model: activeModel, voice: qwenVoice() };
    if (connectPromise) return connectPromise;

    const key = qwenKey();
    if (!key) {
      return { ok: false, error: 'DASHSCOPE_API_KEY is missing — Qwen voice is off' };
    }

    closing = false;
    ready = false;
    pcmQueue = [];
    pendingCalls = [];
    toolsBusy = false;
    responseActive = false;
    ignoreAudio = false;

    connectPromise = (async () => {
      const wanted = qwenModel();
      try {
        return await connectOnce(wanted);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        ws = null;
        ready = false;
        // Only fall back inside the Qwen-Audio family — Omni is a different product.
        if (isQuotaExhausted(message) && isAudioRealtimeModel(wanted) && wanted !== FLASH_MODEL) {
          console.warn(`[qwen] ${wanted} quota exhausted — trying ${FLASH_MODEL}`);
          return await connectOnce(FLASH_MODEL);
        }
        throw err;
      }
    })()
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[qwen] start failed:', message);
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        ws = null;
        ready = false;
        emit('error', { text: message });
        return { ok: false, error: message };
      })
      .finally(() => {
        connectPromise = null;
      });

    return connectPromise;
  }

  function stop() {
    closing = true;
    ready = false;
    pcmQueue = [];
    pendingCalls = [];
    endAudio();
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  /**
   * @param {Buffer | Uint8Array | Int16Array} pcm
   * @param {number} [sampleRate]
   */
  function appendPcm(pcm, sampleRate = INPUT_RATE) {
    if (closing) return;
    let buf = asPcmBuffer(pcm);
    if (sampleRate && sampleRate !== INPUT_RATE) {
      buf = Buffer.from(resampleInt16(buf, sampleRate, INPUT_RATE));
    }
    if (!buf.length) return;
    if (!ready) {
      if (pcmQueue.length < 40) pcmQueue.push(buf);
      return;
    }
    send({
      type: 'input_audio_buffer.append',
      audio: buf.toString('base64'),
    });
  }

  function bargeIn() {
    cancelActiveResponse();
  }

  function sendText(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: trimmed }],
      },
    });
    send({ type: 'response.create', response: { modalities: ['audio', 'text'] } });
  }

  return {
    start,
    stop,
    appendPcm,
    bargeIn,
    sendText,
    isOpen: () => Boolean(ws && ws.readyState === 1),
    isReady: () => ready,
  };
}
