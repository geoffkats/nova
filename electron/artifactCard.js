/**
 * Always-on-top card for Google links Nova just created or opened.
 * Floats over other apps. Does not inject into them.
 */

import { BrowserWindow, ipcMain, screen, shell } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedFileUrl } from './agent/fileActions.js';

/** @type {BrowserWindow | null} */
let cardWin = null;
let lastArtifact = null;
let wired = false;

function isGoogleOpenUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return (
      host === 'docs.google.com' ||
      host === 'drive.google.com' ||
      host === 'calendar.google.com' ||
      host === 'meet.google.com' ||
      (host === 'www.google.com' && u.pathname.startsWith('/calendar'))
    );
  } catch {
    return false;
  }
}

function isHttpUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isOpenableUrl(raw) {
  return isGoogleOpenUrl(raw) || isHttpUrl(raw) || isAllowedFileUrl(raw);
}

export function wireArtifactIpc() {
  if (wired) return;
  wired = true;
  ipcMain.handle('avatar:open-url', async (_event, url) => {
    if (isHttpUrl(url)) {
      await shell.openExternal(String(url));
      return { ok: true };
    }
    if (isAllowedFileUrl(url)) {
      const err = await shell.openPath(fileURLToPath(String(url)));
      return err ? { ok: false, error: err } : { ok: true };
    }
    return { ok: false, error: 'blocked url' };
  });
  ipcMain.on('avatar:dismiss-artifact', () => {
    if (cardWin && !cardWin.isDestroyed()) cardWin.hide();
  });
}

function positionCard(win) {
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({
    x: area.x + area.width - 428,
    y: area.y + 18,
    width: 400,
    height: 158,
  });
}

/**
 * @param {{ isDev: boolean, devServer: string, here: string, preload: string }} ctx
 * @param {{ kind: string, title: string, url: string, id?: string }} artifact
 */
export function showArtifactCard(ctx, artifact) {
  wireArtifactIpc();
  if (!artifact?.url || !isOpenableUrl(artifact.url)) return;
  lastArtifact = artifact;

  if (!cardWin || cardWin.isDestroyed()) {
    cardWin = new BrowserWindow({
      width: 400,
      height: 158,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: ctx.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    cardWin.setAlwaysOnTop(true, 'pop-up-menu');
    try {
      cardWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* windows */
    }
    positionCard(cardWin);
    if (ctx.isDev) {
      cardWin.loadURL(`${ctx.devServer.replace(/\/$/, '')}/?card=1`);
    } else {
      cardWin.loadFile(join(ctx.here, '../dist/index.html'), { query: { card: '1' } });
    }
    cardWin.on('closed', () => {
      cardWin = null;
    });
  } else {
    positionCard(cardWin);
  }

  const push = () => {
    try {
      cardWin?.webContents.send('avatar:artifact', lastArtifact);
      cardWin?.showInactive();
      cardWin?.moveTop();
    } catch {
      /* window gone */
    }
  };

  if (cardWin.webContents.isLoadingMainFrame()) {
    cardWin.webContents.once('did-finish-load', push);
  } else {
    push();
  }
}
