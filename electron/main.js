import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { config as loadEnv } from 'dotenv';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { converse, resetConversation } from './brain/converse.js';
import { ollamaReady } from './brain/ollama.js';
import { cancelKokoro, ensureKokoro, kokoroDevice, kokoroReady } from './brain/kokoro.js';
import {
  createQwenSession,
  qwenConfigured,
  qwenEnabled,
  qwenModel,
  qwenVoice,
  qwenWanted,
} from './brain/qwenRealtime.js';
import { isNovaLocalTool, novaLocalTools, runNovaLocalTool } from './brain/novaMind.js';
import { isWorkspaceTool, runKnownAction, extractWorkspaceArtifact } from './agent/workspaceActions.js';
import { showArtifactCard, wireArtifactIpc } from './artifactCard.js';
import { getMcpHub } from './agent/mcpHub.js';
import { hasGmailCredentials, hasGmailTokens } from './agent/gmailOAuth.js';
import { hasGwsToken } from './agent/gwsPaths.js';

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(here, '../.env') });

const isDev = process.argv.includes('--dev');
const devServer = process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173';

// Windows: a leftover Electron from Ctrl+C still holds AppData GPUCache.
// Chromium then dies with "Unable to move the cache: Access is denied."
if (isDev) {
  const devUserData = join(tmpdir(), `holo-avatar-electron-${process.pid}`);
  mkdirSync(devUserData, { recursive: true });
  app.setPath('userData', devUserData);
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
}

/** @type {BrowserWindow | null} */
let win = null;
let shutdownQwen = () => {};

function isOwnContent(url = '') {
  if (url.startsWith('file://')) return true;
  if (!isDev) return false;
  try {
    const u = new URL(url);
    const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    if (!loopback) return false;
    // Allow the configured Vite port, plus nearby ports if Vite had to hop
    // (should be rare now that strictPort is on).
    const port = u.port || '5173';
    const expected = new URL(devServer).port || '5173';
    const n = Number(port);
    return port === expected || (n >= 5173 && n <= 5199);
  } catch {
    return false;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 900,
    minWidth: 420,
    minHeight: 420,
    backgroundColor: '#000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    win.loadURL(devServer);
  } else {
    win.loadFile(join(here, '../dist/index.html'));
  }
}

function lockDownPermissions() {
  const allowed = new Set(['media', 'audioCapture', 'videoCapture']);

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowed.has(permission) && isOwnContent(details?.requestingUrl ?? contents.getURL()));
  });
  // Chromium also asks a separate "check" — deny that and getUserMedia fails
  // even when the request handler would have allowed it.
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (!allowed.has(permission)) return false;
    return isOwnContent(requestingOrigin);
  });
}

function brainConfig() {
  const openaiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  const groqKey = process.env.GROQ_API_KEY?.trim() ?? '';
  const elevenKey = process.env.ELEVENLABS_API_KEY?.trim() ?? '';
  // Prefer Groq end-to-end when a key exists — fast cloud ears + brain.
  const brainProvider = (
    process.env.BRAIN_PROVIDER?.trim() || (groqKey ? 'groq' : 'ollama')
  ).toLowerCase();
  const sttProvider = (
    process.env.STT_PROVIDER?.trim() || (groqKey ? 'groq' : openaiKey ? 'openai' : 'browser')
  ).toLowerCase();
  const ttsProvider = (
    process.env.TTS_PROVIDER?.trim() || 'local'
  ).toLowerCase();

  return {
    openaiKey,
    groqKey,
    elevenKey,
    voiceId: process.env.ELEVENLABS_VOICE_ID?.trim() || '21m00Tcm4TlvDq8ikWAM',
    chatModel: process.env.OPENAI_CHAT_MODEL?.trim() || 'gpt-4o-mini',
    sttModel: process.env.OPENAI_STT_MODEL?.trim() || 'whisper-1',
    ttsModel: process.env.ELEVENLABS_MODEL_ID?.trim() || 'eleven_flash_v2_5',
    brainProvider,
    sttProvider,
    ttsProvider,
    ollamaUrl: process.env.OLLAMA_URL?.trim() || 'http://127.0.0.1:11434',
    ollamaModel: process.env.OLLAMA_MODEL?.trim() || 'glm-5:cloud',
    groqSttModel: process.env.GROQ_STT_MODEL?.trim() || 'whisper-large-v3-turbo',
    groqChatModel: process.env.GROQ_CHAT_MODEL?.trim() || 'openai/gpt-oss-20b',
    // Fast path for small talk (no tools / no reasoning model).
    groqFastModel: process.env.GROQ_FAST_MODEL?.trim() || 'openai/gpt-oss-20b',
    // af_nova matches the avatar name; af_heart / af_bella are higher-grade options.
    kokoroVoice: process.env.KOKORO_VOICE?.trim() || 'af_nova',
    kokoroSpeed: Number(process.env.KOKORO_SPEED) || 1.12,
  };
}

async function statusPayload() {
  const cfg = brainConfig();
  const ollama = cfg.brainProvider !== 'ollama' ? true : await ollamaReady(cfg.ollamaUrl);
  const hasStt = cfg.sttProvider === 'browser' || Boolean(cfg.groqKey) || Boolean(cfg.openaiKey);
  const hasBrainKeys =
    cfg.brainProvider === 'ollama'
      ? true
      : cfg.brainProvider === 'groq'
        ? Boolean(cfg.groqKey)
        : Boolean(cfg.openaiKey);
  let mcpTools = 0;
  /** @type {'gmail'|'demo'|'none'} */
  let emailBackend = 'none';
  try {
    const hub = await getMcpHub();
    mcpTools = hub.internalToolCount?.() ?? hub.listOpenAiTools().length;
    emailBackend = hub.emailBackend;
  } catch {
    mcpTools = 0;
  }
  const qwenOn = qwenEnabled();
  return {
    ready: qwenOn ? true : hasBrainKeys && hasStt,
    brain: qwenOn ? 'qwen' : cfg.brainProvider,
    stt: qwenOn ? 'qwen' : cfg.sttProvider,
    tts: qwenOn ? 'qwen' : cfg.ttsProvider,
    voiceRuntime: qwenOn ? 'qwen' : 'converse',
    qwenWanted: qwenWanted(),
    qwenConfigured: qwenConfigured(),
    qwenModel: qwenModel(),
    qwenVoice: qwenVoice(),
    ollama,
    ollamaModel: cfg.ollamaModel,
    groqChatModel: cfg.groqChatModel,
    hasGroq: Boolean(cfg.groqKey),
    hasOpenAI: Boolean(cfg.openaiKey),
    hasElevenLabs: Boolean(cfg.elevenKey),
    kokoro: kokoroReady(),
    kokoroVoice: cfg.kokoroVoice,
    kokoroDevice: kokoroDevice(),
    mcpTools,
    emailBackend,
    gmailConfigured: hasGmailCredentials(),
    gmailAuthed: hasGmailTokens(),
    gwsAuthed: hasGwsToken(),
  };
}

app.whenReady().then(() => {
  lockDownPermissions();
  wireArtifactIpc();
  createWindow();
  // Only warm Kokoro when it's the active voice — on this CPU it is ~10–25s/phrase.
  const tts = (process.env.TTS_PROVIDER?.trim() || 'local').toLowerCase();
  if (qwenEnabled()) {
    console.log(`[qwen] voice runtime on · model=${qwenModel()} · voice=${qwenVoice()}`);
  } else if (qwenWanted() && !qwenConfigured()) {
    console.warn('[qwen] VOICE_RUNTIME=qwen but DASHSCOPE_API_KEY is missing — using Groq/Kokoro fallback');
  }
  if (!qwenEnabled() && (tts === 'kokoro' || tts === 'auto')) {
    void ensureKokoro().catch((err) => {
      console.warn('[kokoro] warmup failed:', err instanceof Error ? err.message : err);
    });
  } else if (!qwenEnabled()) {
    console.log(`[TTS] provider=${tts} — skipping Kokoro warmup (system voice)`);
  }
  // Spin up Email MCP (and future servers) so the first "check my email" is fast.
  void getMcpHub().catch((err) => {
    console.warn('[mcp-hub] warmup failed:', err instanceof Error ? err.message : err);
  });

  /** Bumps whenever playback/synthesis must die (new turn or barge-in). */
  let ttsEpoch = 0;

  function sendToRenderer(channel, payload) {
    try {
      win?.webContents.send(channel, payload);
    } catch {
      /* window gone */
    }
  }

  const overlayCtx = {
    isDev,
    devServer,
    here,
    preload: join(here, 'preload.cjs'),
  };

  function presentArtifact(action, args, text) {
    const art = extractWorkspaceArtifact(String(action || ''), args, text);
    if (!art) return;
    sendToRenderer('avatar:artifact', art);
    showArtifactCard(overlayCtx, art);
  }

  const qwen = createQwenSession({
    listTools: async () => {
      const hub = await getMcpHub();
      return [...novaLocalTools(), ...hub.listOpenAiTools()];
    },
    executeTool: async (name, args) => {
      if (isNovaLocalTool(name)) return runNovaLocalTool(name, args);
      const hub = await getMcpHub();
      if (isWorkspaceTool(name)) {
        const text = await runKnownAction(hub, args);
        presentArtifact(args.action, args, text);
        return text;
      }
      const result = await hub.callTool(name, args);
      return result.text || JSON.stringify(result);
    },
    onEvent: (ev) => {
      sendToRenderer('avatar:qwen-event', ev);
      if (ev.kind === 'tool' || ev.kind === 'thinking') {
        sendToRenderer('avatar:progress', { phase: ev.kind, text: ev.text, tool: ev.tool });
      }
    },
    onAudioBegin: () => {
      ttsEpoch += 1;
      sendToRenderer('avatar:tts-begin', { epoch: ttsEpoch });
    },
    onAudioChunk: (chunk) => {
      sendToRenderer('avatar:tts-chunk', {
        epoch: ttsEpoch,
        kind: 'qwen',
        index: chunk.index,
        sampleRate: chunk.sampleRate,
        text: chunk.text,
        pcm: chunk.pcm,
      });
    },
    onAudioEnd: () => {
      sendToRenderer('avatar:tts-end', { epoch: ttsEpoch });
    },
  });
  shutdownQwen = () => qwen.stop();

  function interruptTts() {
    ttsEpoch += 1;
    cancelKokoro();
    qwen.bargeIn();
    return ttsEpoch;
  }

  ipcMain.on('avatar:cancel-tts', () => {
    interruptTts();
  });

  ipcMain.handle('avatar:qwen-start', async () => {
    if (!qwenEnabled()) {
      if (qwenWanted() && !qwenConfigured()) {
        return { ok: false, error: 'Add DASHSCOPE_API_KEY to .env to use Qwen voice' };
      }
      return { ok: false, error: 'Qwen voice runtime is off' };
    }
    await getMcpHub().catch(() => {});
    return qwen.start();
  });

  ipcMain.on('avatar:qwen-stop', () => {
    qwen.stop();
  });

  ipcMain.on('avatar:qwen-pcm', (_event, pcm, sampleRate) => {
    if (!pcm) return;
    const buf = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
    qwen.appendPcm(buf, Number(sampleRate) || 16000);
  });

  ipcMain.on('avatar:qwen-barge', () => {
    interruptTts();
  });

  ipcMain.on('avatar:qwen-text', (_event, text) => {
    qwen.sendText(text);
  });

  ipcMain.on('avatar:tts-playback-start', (_event, info) => {
    const ttfa = info?.ttfa;
    console.log(
      `[TTS] playback_start` +
        (ttfa != null ? ` ttfa=${ttfa}ms` : '') +
        (info?.epoch != null ? ` epoch=${info.epoch}` : ''),
    );
  });

  ipcMain.handle('avatar:platform', async () => ({
    platform: process.platform,
    electron: process.versions.electron,
    dev: isDev,
    brainReady: (await statusPayload()).ready,
  }));

  ipcMain.handle('avatar:brain-status', () => statusPayload());

  ipcMain.handle('avatar:reset-chat', async () => {
    resetConversation();
    if (qwen.isOpen()) {
      qwen.stop();
      await qwen.start();
    }
    return { ok: true };
  });

  ipcMain.handle('avatar:warmup-tts', async () => {
    if (qwenEnabled()) {
      return { ok: true, kokoro: false, skipped: true, tts: 'qwen', model: qwenModel() };
    }
    const tts = (process.env.TTS_PROVIDER?.trim() || 'local').toLowerCase();
    if (tts === 'local') {
      return { ok: true, kokoro: false, skipped: true, tts: 'local' };
    }
    try {
      await ensureKokoro();
      return { ok: true, kokoro: kokoroReady(), device: kokoroDevice() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('avatar:gmail-auth', async () => {
    try {
      const hub = await getMcpHub();
      const result = await hub.authenticateGmail();
      return { ok: true, ...result, emailBackend: hub.emailBackend };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('avatar:converse', async (event, payload) => {
    const cfg = brainConfig();
    const epoch = interruptTts();
    try {
      event.sender.send('avatar:tts-begin', { epoch });
    } catch {
      /* window gone */
    }
    try {
      const samples = payload?.samples;
      const sampleRate = Number(payload?.sampleRate) || 16000;
      const userText = typeof payload?.userText === 'string' ? payload.userText : '';
      const pcm =
        samples == null
          ? null
          : samples instanceof Float32Array
            ? samples
            : new Float32Array(samples);

      const result = await converse({
        pcm,
        sampleRate,
        userText,
        ...cfg,
        isCancelled: () => epoch !== ttsEpoch,
        onTtsChunk: (chunk) => {
          if (epoch !== ttsEpoch) return;
          try {
            event.sender.send('avatar:tts-chunk', {
              epoch,
              kind: chunk.kind,
              index: chunk.index,
              sampleRate: chunk.sampleRate,
              text: chunk.text,
              pcm: chunk.pcm,
            });
          } catch {
            /* window gone */
          }
        },
        onTtsEnd: () => {
          if (epoch !== ttsEpoch) return;
          try {
            event.sender.send('avatar:tts-end', { epoch });
          } catch {
            /* window gone */
          }
        },
        onProgress: (info) => {
          try {
            event.sender.send('avatar:progress', info);
          } catch {
            /* window gone */
          }
        },
        onArtifact: (art) => {
          sendToRenderer('avatar:artifact', art);
          showArtifactCard(overlayCtx, art);
        },
        onBridge: async (bridge) => {
          try {
            event.sender.send('avatar:bridge', {
              text: bridge.text,
              mime: bridge.mime,
              tts: bridge.tts,
              // Pass binary as Buffer — NEVER Array.from(whole wav); that freezes IPC.
              audio: bridge.audio ? Buffer.from(bridge.audio) : null,
            });
            await new Promise((r) => setImmediate(r));
          } catch {
            /* window gone */
          }
        },
        onSpeak: async (spoken) => {
          try {
            event.sender.send('avatar:speak', {
              text: spoken.text,
              mime: spoken.mime,
              tts: spoken.tts,
              audio: spoken.audio ? Buffer.from(spoken.audio) : null,
            });
            await new Promise((r) => setImmediate(r));
          } catch {
            /* window gone */
          }
        },
      });

      if (result.ok && result.audio) {
        return {
          ...result,
          audio: Buffer.from(result.audio),
        };
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[converse] pipeline-error:', message);
      return { ok: false, reason: 'pipeline-error', error: message };
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  shutdownQwen();
  if (process.platform !== 'darwin') app.quit();
});
