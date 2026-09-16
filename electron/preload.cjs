const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the renderer and Node. Keep it a narrow, explicit
 * surface — later voice work will add calls here so API keys stay in the main
 * process and never reach the page.
 */
contextBridge.exposeInMainWorld('avatarHost', {
  getPlatform: () => ipcRenderer.invoke('avatar:platform'),
});
