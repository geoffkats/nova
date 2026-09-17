/**
 * Local Google Workspace MCP (CoPa) — the server you already use.
 * Uses normal Google APIs, not Google's remote gmailmcp.googleapis.com preview.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Irreversible mail/Drive wipes. Calendar delete and Sheets/Docs edits are allowed. */
export const GWS_BLOCKED = new Set([
  'gmail_trash',
  'gmail_delete_draft',
  'gmail_delete_label',
  'gmail_delete_filter',
  'drive_delete',
  'drive_trash',
  'docs_delete_range',
]);

export function isGwsToolAllowed(name) {
  return !GWS_BLOCKED.has(String(name || ''));
}

export function defaultGwsDir() {
  return (
    process.env.NOVA_GWS_MCP_DIR?.trim() ||
    join(homedir(), 'Desktop', 'CoPa', 'google-workspace-mcp-server')
  );
}

/**
 * Pick the newest existing path (by mtime). Avoids a stale CoPa token.json
 * winning over a fresh ~/.config token from `npm run gws:auth`.
 * @param {string[]} candidates
 */
function newestExisting(candidates) {
  /** @type {{ path: string, mtime: number } | null} */
  let best = null;
  for (const p of candidates) {
    if (!p || !existsSync(p)) continue;
    try {
      const mtime = statSync(p).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: p, mtime };
    } catch {
      /* ignore */
    }
  }
  return best?.path || candidates.find((p) => p && existsSync(p)) || candidates[0];
}

export function resolveGwsPaths() {
  const dir = defaultGwsDir();
  const homeDir = join(homedir(), '.config', 'google-workspace-mcp');
  const homeCred = join(homeDir, 'credentials.json');
  const homeToken = join(homeDir, 'token.json');
  const dirCred = join(dir, 'credentials.json');
  const dirToken = join(dir, 'token.json');

  const credentialsPath =
    process.env.GOOGLE_CREDENTIALS_PATH?.trim() ||
    newestExisting([dirCred, homeCred]);

  // Prefer the freshest token — gws:auth writes ~/.config; CoPa often keeps a dead copy.
  const tokenPath =
    process.env.GOOGLE_TOKEN_PATH?.trim() ||
    newestExisting([homeToken, dirToken]);

  return { dir, credentialsPath, tokenPath, homeToken, dirToken };
}

/** Load KEY=VAL pairs from CoPa .env (no override of already-set process.env). */
export function loadGwsDotEnv() {
  const envFile = join(defaultGwsDir(), '.env');
  /** @type {Record<string, string>} */
  const out = {};
  if (!existsSync(envFile)) return out;
  try {
    const text = readFileSync(envFile, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function hasGwsInstall() {
  const { dir } = resolveGwsPaths();
  return existsSync(dir) || existsSync(join(homedir(), '.config', 'google-workspace-mcp'));
}

export function hasGwsToken() {
  const { tokenPath } = resolveGwsPaths();
  return Boolean(tokenPath && existsSync(tokenPath));
}
