/**
 * Nova's holographic board — notes, links, and tasks she pins for you.
 * Three columns. Survives restarts. Not a second Google Doc.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BOARD_TOOL_NAME = 'nova_board';

const COLUMNS = ['now', 'later', 'done'];
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const boardPath = join(root, '.nova', 'board.json');

function str(v) {
  return String(v ?? '').trim();
}

function newId() {
  return `card_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function emptyBoard() {
  return {
    cards: [],
  };
}

export function loadBoard() {
  try {
    if (!existsSync(boardPath)) return emptyBoard();
    const data = JSON.parse(readFileSync(boardPath, 'utf8'));
    const cards = Array.isArray(data?.cards) ? data.cards : [];
    return {
      cards: cards
        .map((c) => ({
          id: str(c.id) || newId(),
          title: str(c.title).slice(0, 120) || 'Note',
          body: str(c.body).slice(0, 800),
          url: str(c.url).slice(0, 500),
          column: COLUMNS.includes(c.column) ? c.column : 'now',
          created: Number(c.created) || Date.now(),
        }))
        .slice(-80),
    };
  } catch {
    return emptyBoard();
  }
}

function saveBoard(board) {
  mkdirSync(dirname(boardPath), { recursive: true });
  writeFileSync(boardPath, JSON.stringify(board, null, 2), 'utf8');
  return board;
}

function asUrl(raw) {
  const s = str(raw);
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch {
    /* not a url */
  }
  return '';
}

function summarize(board) {
  const groups = { now: [], later: [], done: [] };
  for (const c of board.cards) groups[c.column]?.push(c);
  return {
    ok: true,
    on_screen: true,
    counts: {
      now: groups.now.length,
      later: groups.later.length,
      done: groups.done.length,
    },
    cards: board.cards.map((c) => ({
      id: c.id,
      column: c.column,
      title: c.title,
      url: c.url || undefined,
    })),
  };
}

export function boardActionTool() {
  return {
    type: 'function',
    function: {
      name: BOARD_TOOL_NAME,
      description: `Holographic kanban board on the user's screen. Pin notes and links. Columns: now, later, done.

pin — add a card. Need title. Optional body, url, column (now|later|done).
move — move a card. Need id and column.
done — mark done. Need id.
drop — remove a card. Need id.
list — read the board.
show — open the board overlay.
hide — close the board overlay. Same as close.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['pin', 'move', 'done', 'drop', 'list', 'show', 'hide', 'close'],
            description: 'The single known action.',
          },
          title: { type: 'string', description: 'Short card title for pin.' },
          body: { type: 'string', description: 'Optional note text.' },
          url: { type: 'string', description: 'Optional https link to keep on the card.' },
          column: { type: 'string', enum: COLUMNS, description: 'now, later, or done. Default now.' },
          id: { type: 'string', description: 'Card id from a previous list/pin.' },
        },
        required: ['action'],
      },
    },
  };
}

export function isBoardTool(name) {
  return name === BOARD_TOOL_NAME;
}

/**
 * @param {Record<string, unknown>} args
 * @returns {{ text: string, board: { cards: object[] }, show: boolean }}
 */
export function runBoardAction(args = {}) {
  const action = str(args.action) || 'pin';
  const board = loadBoard();

  if (action === 'hide' || action === 'close') {
    console.log('[board] hide');
    return {
      text: JSON.stringify({ ok: true, hidden: true }),
      board,
      show: false,
    };
  }

  if (action === 'list' || action === 'show') {
    return { text: JSON.stringify(summarize(board)), board, show: true };
  }

  if (action === 'pin') {
    const title = str(args.title) || str(args.body).slice(0, 80) || str(args.url);
    if (!title) {
      return { text: JSON.stringify({ error: 'Need title (or a link) to pin.' }), board, show: true };
    }
    const card = {
      id: newId(),
      title: title.slice(0, 120),
      body: str(args.body).slice(0, 800),
      url: asUrl(args.url) || asUrl(args.body),
      column: COLUMNS.includes(str(args.column)) ? str(args.column) : 'now',
      created: Date.now(),
    };
    board.cards.unshift(card);
    saveBoard(board);
    console.log('[board] pin', card.column, card.title);
    return {
      text: JSON.stringify({ ok: true, on_screen: true, id: card.id, column: card.column, title: card.title }),
      board,
      show: true,
    };
  }

  const id = str(args.id);
  const idx = board.cards.findIndex((c) => c.id === id || c.title.toLowerCase() === id.toLowerCase());
  if (idx < 0) {
    return {
      text: JSON.stringify({ error: 'Need id from list. Board is on screen.' }),
      board,
      show: true,
    };
  }

  if (action === 'drop') {
    const [removed] = board.cards.splice(idx, 1);
    saveBoard(board);
    console.log('[board] drop', removed.title);
    return { text: JSON.stringify({ ok: true, dropped: removed.title }), board, show: true };
  }

  const column = action === 'done' ? 'done' : str(args.column);
  if (!COLUMNS.includes(column)) {
    return { text: JSON.stringify({ error: 'Need column now, later, or done.' }), board, show: true };
  }
  board.cards[idx].column = column;
  saveBoard(board);
  console.log('[board] move', board.cards[idx].title, column);
  return {
    text: JSON.stringify({ ok: true, id: board.cards[idx].id, column, title: board.cards[idx].title, on_screen: true }),
    board,
    show: true,
  };
}
