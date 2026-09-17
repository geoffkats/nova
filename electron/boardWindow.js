/**
 * Always-on-top holographic board. Same family as the artifact card.
 */

import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { loadBoard, runBoardAction } from './agent/boardActions.js';

/** @type {BrowserWindow | null} */
let boardWin = null;
let lastBoard = null;
let wired = false;

export function wireBoardIpc() {
  if (wired) return;
  wired = true;
  ipcMain.handle('avatar:board-get', () => loadBoard());
  ipcMain.handle('avatar:board-act', (_event, args) => {
    const out = runBoardAction(args || {});
    lastBoard = out.board;
    if (out.show === false) {
      hideNovaBoard();
      return out.board;
    }
    pushBoard();
    return out.board;
  });
  ipcMain.on('avatar:board-hide', () => {
    hideNovaBoard();
  });
}

export function hideNovaBoard() {
  if (boardWin && !boardWin.isDestroyed()) boardWin.hide();
}

function positionBoard(win) {
  const area = screen.getPrimaryDisplay().workArea;
  win.setBounds({
    x: area.x + area.width - 760,
    y: area.y + 18,
    width: 740,
    height: 520,
  });
}

function pushBoard() {
  try {
    boardWin?.webContents.send('avatar:board', lastBoard || loadBoard());
    boardWin?.showInactive();
    boardWin?.moveTop();
  } catch {
    /* window gone */
  }
}

/**
 * @param {{ isDev: boolean, devServer: string, here: string, preload: string }} ctx
 * @param {{ cards?: object[] } | null} [board]
 */
export function showNovaBoard(ctx, board) {
  wireBoardIpc();
  lastBoard = board || loadBoard();

  if (!boardWin || boardWin.isDestroyed()) {
    boardWin = new BrowserWindow({
      width: 740,
      height: 520,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: true,
      movable: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: ctx.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    boardWin.setAlwaysOnTop(true, 'pop-up-menu');
    try {
      boardWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* windows */
    }
    positionBoard(boardWin);
    if (ctx.isDev) {
      boardWin.loadURL(`${ctx.devServer.replace(/\/$/, '')}/?board=1`);
    } else {
      boardWin.loadFile(join(ctx.here, '../dist/index.html'), { query: { board: '1' } });
    }
    boardWin.on('closed', () => {
      boardWin = null;
    });
  }

  if (boardWin.webContents.isLoadingMainFrame()) {
    boardWin.webContents.once('did-finish-load', pushBoard);
  } else {
    pushBoard();
  }
}
