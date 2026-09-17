const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('avatarHost', {
  getPlatform: () => ipcRenderer.invoke('avatar:platform'),
  brainStatus: () => ipcRenderer.invoke('avatar:brain-status'),
  resetChat: () => ipcRenderer.invoke('avatar:reset-chat'),
  warmupTts: () => ipcRenderer.invoke('avatar:warmup-tts'),
  gmailAuth: () => ipcRenderer.invoke('avatar:gmail-auth'),
  /**
   * @param {{ samples?: Float32Array | number[], sampleRate?: number, userText?: string }} utterance
   */
  converse: (utterance) => ipcRenderer.invoke('avatar:converse', utterance),
  transcribe: (utterance) => ipcRenderer.invoke('avatar:transcribe', utterance),
  qwenStart: () => ipcRenderer.invoke('avatar:qwen-start'),
  qwenStop: () => ipcRenderer.send('avatar:qwen-stop'),
  qwenPcm: (pcm, sampleRate) => ipcRenderer.send('avatar:qwen-pcm', pcm, sampleRate),
  qwenBargeIn: () => ipcRenderer.send('avatar:qwen-barge'),
  qwenText: (text) => ipcRenderer.send('avatar:qwen-text', text),
  cancelTts: () => ipcRenderer.send('avatar:cancel-tts'),
  ttsPlaybackStart: (info) => ipcRenderer.send('avatar:tts-playback-start', info),
  /** Mid-turn spoken bridge while tools run */
  onBridge: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('avatar:bridge', handler);
    return () => ipcRenderer.removeListener('avatar:bridge', handler);
  },
  /** Final answer audio as soon as TTS finishes (before converse IPC returns) */
  onSpeak: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('avatar:speak', handler);
    return () => ipcRenderer.removeListener('avatar:speak', handler);
  },
  onTtsBegin: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('avatar:tts-begin', handler);
    return () => ipcRenderer.removeListener('avatar:tts-begin', handler);
  },
  onTtsChunk: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('avatar:tts-chunk', handler);
    return () => ipcRenderer.removeListener('avatar:tts-chunk', handler);
  },
  onTtsEnd: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('avatar:tts-end', handler);
    return () => ipcRenderer.removeListener('avatar:tts-end', handler);
  },
  /** HUD status while tools run */
  onProgress: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('avatar:progress', handler);
    return () => ipcRenderer.removeListener('avatar:progress', handler);
  },
  onQwenEvent: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('avatar:qwen-event', handler);
    return () => ipcRenderer.removeListener('avatar:qwen-event', handler);
  },
  onArtifact: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('avatar:artifact', handler);
    return () => ipcRenderer.removeListener('avatar:artifact', handler);
  },
  onBoard: (cb) => {
    const handler = (_event, data) => cb(data);
    ipcRenderer.on('avatar:board', handler);
    return () => ipcRenderer.removeListener('avatar:board', handler);
  },
  boardGet: () => ipcRenderer.invoke('avatar:board-get'),
  boardAct: (args) => ipcRenderer.invoke('avatar:board-act', args),
  hideBoard: () => ipcRenderer.send('avatar:board-hide'),
  showBoard: () => ipcRenderer.invoke('avatar:board-show'),
  openUrl: (url) => ipcRenderer.invoke('avatar:open-url', url),
  dismissArtifact: () => ipcRenderer.send('avatar:dismiss-artifact'),
});
