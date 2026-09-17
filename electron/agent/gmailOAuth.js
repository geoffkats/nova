/**
 * File-backed OAuth provider for Google Workspace remote MCP (Gmail).
 * Tokens live under .nova/ (gitignored) — never in the renderer.
 */

import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const storeDir = join(root, '.nova');
const tokenPath = join(storeDir, 'gmail-oauth.json');

export const GMAIL_MCP_URL = 'https://gmailmcp.googleapis.com/mcp/v1';
export const GMAIL_CALLBACK_PORT = Number(process.env.GOOGLE_OAUTH_CALLBACK_PORT) || 17890;
export const GMAIL_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI ||
  `http://127.0.0.1:${GMAIL_CALLBACK_PORT}/oauth/callback`;

/** Scopes Google documents for the Gmail MCP server. */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

/**
 * Tools Nova may call without asking. Write/label tools stay blocked for now.
 */
export const GMAIL_READONLY_TOOLS = new Set([
  'search_threads',
  'get_thread',
  'get_message',
  'list_labels',
  'list_drafts',
]);

function ensureStore() {
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
}

/**
 * @returns {{
 *   tokens?: import('@modelcontextprotocol/sdk/shared/auth.js').OAuthTokens,
 *   codeVerifier?: string,
 *   clientInformation?: import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientInformationMixed,
 * }}
 */
export function loadOAuthStore() {
  try {
    if (!existsSync(tokenPath)) return {};
    return JSON.parse(readFileSync(tokenPath, 'utf8'));
  } catch {
    return {};
  }
}

/** @param {Record<string, unknown>} patch */
export function saveOAuthStore(patch) {
  ensureStore();
  const next = { ...loadOAuthStore(), ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(tokenPath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export function clearOAuthStore() {
  ensureStore();
  if (existsSync(tokenPath)) writeFileSync(tokenPath, '{}\n', 'utf8');
}

export function hasGmailCredentials() {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim(),
  );
}

export function hasGmailTokens() {
  const store = loadOAuthStore();
  return Boolean(store.tokens?.access_token || store.tokens?.refresh_token);
}

function openUrl(url) {
  const platform = process.platform;
  if (platform === 'win32') {
    // CRITICAL: quote the URL. Unquoted, cmd.exe treats & as a command separator
    // and strips query params (including scope) → Google "Missing required parameter: scope".
    spawn('cmd', ['/c', 'start', '""', `"${url}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
  } else if (platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

/**
 * Wait for the browser OAuth redirect on localhost.
 * @param {number} [port]
 * @param {number} [timeoutMs]
 * @returns {Promise<string> & { cancel: () => void }}
 */
export function waitForOAuthCallback(port = GMAIL_CALLBACK_PORT, timeoutMs = 5 * 60_000) {
  /** @type {import('node:http').Server | null} */
  let server = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  /** @type {Promise<string> & { cancel: () => void }} */
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      server?.close();
      reject(new Error('Gmail OAuth timed out — no callback received.'));
    }, timeoutMs);

    server = createServer((req, res) => {
      if (!req.url || req.url.startsWith('/favicon')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/oauth/callback' && url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body style="font-family:system-ui;background:#0a0a0a;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
          <div><h1>Nova ↔ Gmail connected</h1><p>You can close this window.</p></div>
          <script>setTimeout(()=>window.close(),1500)</script>
        </body></html>`);
        if (timer) clearTimeout(timer);
        setTimeout(() => server?.close(), 500);
        resolve(code);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body><h1>Authorization failed</h1><p>${error || 'missing code'}</p></body></html>`);
      if (timer) clearTimeout(timer);
      server?.close();
      reject(new Error(`Gmail OAuth failed: ${error || 'missing code'}`));
    });

    server.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[gmail-oauth] listening on ${GMAIL_REDIRECT_URI}`);
    });
  });

  promise.cancel = () => {
    if (timer) clearTimeout(timer);
    server?.close();
  };

  return promise;
}

/**
 * MCP OAuthClientProvider backed by .nova/gmail-oauth.json
 * @param {{ openBrowser?: (url: string) => void }} [opts]
 */
export function createGmailOAuthProvider(opts = {}) {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() || '';
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() || '';
  if (!clientId || !clientSecret) {
    throw new Error(
      'Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET in .env',
    );
  }

  const openBrowser = opts.openBrowser || openUrl;

  /** @type {import('@modelcontextprotocol/sdk/client/auth.js').OAuthClientProvider} */
  const provider = {
    get redirectUrl() {
      return GMAIL_REDIRECT_URI;
    },

    get clientMetadata() {
      return {
        client_name: 'Nova Holographic Avatar',
        redirect_uris: [GMAIL_REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_post',
        scope: GMAIL_SCOPES.join(' '),
      };
    },

    clientInformation() {
      const stored = loadOAuthStore().clientInformation;
      return (
        stored || {
          client_id: clientId,
          client_secret: clientSecret,
        }
      );
    },

    saveClientInformation(info) {
      saveOAuthStore({ clientInformation: info });
    },

    tokens() {
      return loadOAuthStore().tokens;
    },

    saveTokens(tokens) {
      saveOAuthStore({ tokens });
    },

    redirectToAuthorization(authorizationUrl) {
      const url = new URL(authorizationUrl.toString());
      // Google always requires scope; belt-and-suspenders if discovery omitted it.
      if (!url.searchParams.get('scope')) {
        url.searchParams.set('scope', GMAIL_SCOPES.join(' '));
      }
      // Need a refresh token for long-lived Nova sessions.
      if (!url.searchParams.get('access_type')) {
        url.searchParams.set('access_type', 'offline');
      }
      if (!url.searchParams.get('prompt')) {
        url.searchParams.set('prompt', 'consent');
      }
      console.log(
        '[gmail-oauth] opening browser…',
        url.origin + url.pathname + '?…&scope=' + (url.searchParams.get('scope') || '(missing)'),
      );
      openBrowser(url.toString());
    },

    saveCodeVerifier(codeVerifier) {
      saveOAuthStore({ codeVerifier });
    },

    codeVerifier() {
      const v = loadOAuthStore().codeVerifier;
      if (!v) throw new Error('No OAuth code verifier saved');
      return v;
    },
  };

  return provider;
}
