import { app, BrowserWindow, ipcMain, session, shell } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// `--dev` points the window at the Vite server; a flag keeps the npm scripts
// working on PowerShell and POSIX shells alike, with no cross-env shim.
const isDev = process.argv.includes('--dev');
const devServer = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173';

/** @type {BrowserWindow | null} */
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 900,
    minWidth: 420,
    minHeight: 420,
    backgroundColor: '#000000',
    // The scene is pure black to the edges, so the stock chrome would frame it in grey.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Voice work later needs SharedArrayBuffer for ONNX Runtime's threaded WASM.
      // Electron grants it without the COOP/COEP headers a plain browser would demand.
      backgroundThrottling: false,
    },
  });

  // Avoid the white flash before the first WebGL frame lands.
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });

  // Keep external links in the user's browser rather than inside the app shell.
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

// Mic and camera are granted to our own content only — the voice loop and, later,
// webcam eye contact need them. Every other permission is refused outright.
function lockDownPermissions() {
  const allowed = new Set(['media', 'audioCapture', 'videoCapture']);
  const isOwnContent = (url = '') => url.startsWith('file://') || (isDev && url.startsWith(devServer));

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowed.has(permission) && isOwnContent(details?.requestingUrl ?? contents.getURL()));
  });
}

app.whenReady().then(() => {
  lockDownPermissions();
  createWindow();

  ipcMain.handle('avatar:platform', () => ({
    platform: process.platform,
    electron: process.versions.electron,
    dev: isDev,
  }));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
