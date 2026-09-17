import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GMAIL_MCP_URL,
  GMAIL_READONLY_TOOLS,
  createGmailOAuthProvider,
  hasGmailCredentials,
  hasGmailTokens,
  waitForOAuthCallback,
} from './gmailOAuth.js';
import {
  hasGwsInstall,
  hasGwsToken,
  isGwsToolAllowed,
  loadGwsDotEnv,
  resolveGwsPaths,
} from './gwsPaths.js';
import { workspaceActionTool } from './workspaceActions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * MCP hub: prefers local CoPa google-workspace-mcp, then optional remote Gmail MCP, then demo.
 */
export class McpHub {
  constructor() {
    /** @type {Map<string, { client: Client, transport: any }>} */
    this.servers = new Map();
    /** @type {Map<string, { server: string, tool: any }>} */
    this.toolIndex = new Map();
    /** @type {'gws'|'gmail'|'demo'|'none'} */
    this.emailBackend = 'none';
  }

  /**
   * @param {string} name
   * @param {Client} client
   * @param {any} transport
   * @param {{ allowTool?: (toolName: string) => boolean }} [opts]
   */
  async registerClient(name, client, transport, opts = {}) {
    this.detachServer(name, { close: false });
    this.servers.set(name, { client, transport });

    // CoPa Workspace MCP cold-starts Google auth before tools/list responds.
    const listed = await client.listTools(undefined, {
      timeout: opts.requestTimeout ?? 60_000,
    });
    let count = 0;
    for (const tool of listed.tools ?? []) {
      if (opts.allowTool && !opts.allowTool(tool.name)) continue;
      this.toolIndex.set(`${name}__${tool.name}`, { server: name, tool });
      count += 1;
    }

    console.log(`[mcp-hub] connected ${name} (${count} tools exposed)`);
    return count;
  }

  /**
   * @param {{
   *   name: string,
   *   command: string,
   *   args?: string[],
   *   env?: Record<string,string>,
   *   cwd?: string,
   *   allowTool?: (n: string) => boolean,
   *   requestTimeout?: number,
   * }} spec
   */
  async connectStdio(spec) {
    if (this.servers.has(spec.name)) return;

    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      cwd: spec.cwd,
      env: { ...getDefaultEnvironment(), ...(spec.env ?? {}) },
      stderr: 'pipe',
    });

    transport.stderr?.on('data', (buf) => {
      const line = String(buf).trim();
      if (line) console.log(`[mcp:${spec.name}]`, line);
    });

    const client = new Client({ name: `nova-${spec.name}`, version: '0.1.0' });
    // Per-request timeout (SDK default is 60s). Workspace Python + Google auth often exceeds that.
    const requestTimeout = spec.requestTimeout ?? 60_000;
    await client.connect(transport, { timeout: requestTimeout });
    await this.registerClient(spec.name, client, transport, {
      allowTool: spec.allowTool,
      requestTimeout,
    });
  }

  /**
   * Local CoPa google-workspace-mcp (installed as `google-workspace-mcp` CLI).
   */
  async connectWorkspace() {
    if (!hasGwsInstall()) {
      throw new Error('google-workspace-mcp not found. Set NOVA_GWS_MCP_DIR.');
    }
    if (!hasGwsToken()) {
      throw new Error('Workspace token missing. Run: npm run gws:auth');
    }

    const { dir, credentialsPath, tokenPath } = resolveGwsPaths();
    const gwsEnv = loadGwsDotEnv();
    console.log('[mcp-hub] Workspace token:', tokenPath);
    console.log('[mcp-hub] Workspace creds:', credentialsPath);

    /** @type {Record<string, string>} */
    const env = {
      ...gwsEnv,
      // Force absolute paths so CoPa's relative .env cannot point at a stale token.
      GOOGLE_CREDENTIALS_PATH: credentialsPath,
      GOOGLE_TOKEN_PATH: tokenPath,
    };
    for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI']) {
      if (process.env[key]) env[key] = process.env[key];
    }

    const attempt = async () => {
      // Kill any half-open prior gws client before retrying.
      this.detachServer('gws');
      await this.connectStdio({
        name: 'gws',
        command: process.env.NOVA_GWS_COMMAND?.trim() || 'google-workspace-mcp',
        args: [],
        cwd: dir,
        env,
        allowTool: isGwsToolAllowed,
        requestTimeout: 180_000,
      });
    };

    try {
      await attempt();
    } catch (err) {
      console.warn(
        '[mcp-hub] Workspace MCP attempt 1 failed:',
        err instanceof Error ? err.message : err,
        '— retrying…',
      );
      this.detachServer('gws');
      await new Promise((r) => setTimeout(r, 1500));
      await attempt();
    }

    // Skip inbox probe at boot — listTools already means the server is up.
    this.emailBackend = 'gws';
    this.detachServer('email');
    this.detachServer('gmail');
    return {
      ok: true,
      tools: [...this.toolIndex.keys()].filter((k) => k.startsWith('gws__')).length,
    };
  }

  /** Interactive browser OAuth for Google's remote Gmail MCP (preview program). */
  async authenticateGmail() {
    return this.connectGmail({ interactive: true });
  }

  /**
   * Optional remote https://gmailmcp.googleapis.com/mcp/v1 (needs Developer Preview).
   * @param {{ interactive?: boolean }} [opts]
   */
  async connectGmail(opts = {}) {
    const interactive = Boolean(opts.interactive);
    if (!hasGmailCredentials()) {
      throw new Error(
        'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env',
      );
    }
    if (!hasGmailTokens() && !interactive) {
      throw new Error('Gmail not authenticated. Run: npm run gmail:auth');
    }

    const authProvider = createGmailOAuthProvider();
    let client = new Client({ name: 'nova-gmail', version: '0.1.0' });
    let transport = new StreamableHTTPClientTransport(new URL(GMAIL_MCP_URL), {
      authProvider,
    });

    await client.connect(transport);

    if (!hasGmailTokens()) {
      if (!interactive) {
        throw new Error('Gmail not authenticated. Run: npm run gmail:auth');
      }

      console.log('[mcp-hub] Remote Gmail OAuth required — complete Google sign-in');
      const codePromise = waitForOAuthCallback();
      const probe = client.callTool({ name: 'list_labels', arguments: {} }).then(
        () => 'ok',
        (err) => err,
      );
      const code = await codePromise;
      await transport.finishAuth(code);
      void probe;

      try {
        await client.close();
      } catch {
        /* ignore */
      }

      client = new Client({ name: 'nova-gmail', version: '0.1.0' });
      transport = new StreamableHTTPClientTransport(new URL(GMAIL_MCP_URL), {
        authProvider,
      });
      await client.connect(transport);
    }

    if (!hasGmailTokens()) {
      throw new Error('Gmail OAuth finished but no access token was saved.');
    }

    const verify = await client.callTool({ name: 'list_labels', arguments: {} });
    if (verify.isError) {
      const text = (verify.content ?? []).map((c) => c.text).join(' ');
      throw new Error(`Gmail token rejected: ${text.slice(0, 200)}`);
    }

    await this.registerClient('gmail', client, transport, {
      allowTool: (n) => GMAIL_READONLY_TOOLS.has(n),
    });
    this.emailBackend = 'gmail';
    this.detachServer('email');
    return {
      ok: true,
      tools: [...this.toolIndex.keys()].filter((k) => k.startsWith('gmail__')).length,
    };
  }

  async connectDemoEmail() {
    /** @type {Record<string, string>} */
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    if (process.env.NOVA_EMAIL_MAILBOX) {
      env.NOVA_EMAIL_MAILBOX = process.env.NOVA_EMAIL_MAILBOX;
    }
    await this.connectStdio({
      name: 'email',
      command: process.execPath,
      args: [join(root, 'mcp/email/server.mjs')],
      env,
    });
    if (this.emailBackend === 'none') this.emailBackend = 'demo';
  }

  /** Prefer CoPa Workspace MCP → optional remote → demo (only if no real token). */
  async connectEmailPreferred() {
    if (hasGwsInstall() && hasGwsToken()) {
      try {
        await this.connectWorkspace();
        return;
      } catch (err) {
        console.warn(
          '[mcp-hub] local Workspace MCP not ready:',
          err instanceof Error ? err.message : err,
          '— run: npm run gws:auth',
        );
        // Do NOT fall through to demo when a real token exists — demo mailbox is worse than no mail.
        console.warn('[mcp-hub] skipping demo email (Workspace token present). Email tools unavailable until gws connects.');
        this.emailBackend = 'none';
        return;
      }
    }

    if (hasGwsInstall()) {
      try {
        await this.connectWorkspace();
        return;
      } catch (err) {
        console.warn(
          '[mcp-hub] local Workspace MCP not ready:',
          err instanceof Error ? err.message : err,
          '— run: npm run gws:auth',
        );
      }
    }

    if (process.env.NOVA_GMAIL_REMOTE === '1' && hasGmailCredentials()) {
      try {
        await this.connectGmail({ interactive: false });
        return;
      } catch (err) {
        console.warn(
          '[mcp-hub] remote Gmail MCP not ready:',
          err instanceof Error ? err.message : err,
        );
      }
    }

    console.log('[mcp-hub] using demo email MCP');
    await this.connectDemoEmail();
  }

  /**
   * @param {string} name
   * @param {{ close?: boolean }} [opts]
   */
  detachServer(name, opts = {}) {
    const shouldClose = opts.close !== false;
    const entry = this.servers.get(name);
    if (entry && shouldClose) {
      void entry.client.close().catch(() => {});
      void entry.transport?.close?.().catch?.(() => {});
    }
    this.servers.delete(name);
    for (const [key, e] of [...this.toolIndex.entries()]) {
      if (e.server === name) this.toolIndex.delete(key);
    }
  }

  listOpenAiTools() {
    if (this.emailBackend === 'gws' && this.toolIndex.size) {
      return [workspaceActionTool()];
    }
    return [...this.toolIndex.entries()].map(([name, { tool }]) => ({
      type: 'function',
      function: {
        name,
        description: tool.description ?? name,
        parameters: tool.inputSchema ?? { type: 'object', properties: {} },
      },
    }));
  }

  internalToolCount() {
    return this.toolIndex.size;
  }

  /**
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  async callTool(name, args = {}) {
    const entry = this.toolIndex.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);
    const { client } = this.servers.get(entry.server);
    const rawName = entry.tool.name;

    if (entry.server === 'gmail' && !GMAIL_READONLY_TOOLS.has(rawName)) {
      throw new Error(`Blocked write tool ${rawName}`);
    }
    if (entry.server === 'gws' && !isGwsToolAllowed(rawName)) {
      throw new Error(`Blocked Workspace tool ${rawName}`);
    }

    const result = await client.callTool(
      { name: rawName, arguments: args },
      undefined,
      { timeout: 120_000 },
    );
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    return {
      isError: Boolean(result.isError),
      text: text || JSON.stringify(result),
    };
  }

  async close() {
    for (const [name, { client, transport }] of this.servers) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      try {
        await transport.close?.();
      } catch {
        /* ignore */
      }
      console.log(`[mcp-hub] closed ${name}`);
    }
    this.servers.clear();
    this.toolIndex.clear();
    this.emailBackend = 'none';
  }
}

let hubPromise = null;

export function getMcpHub() {
  if (!hubPromise) {
    hubPromise = (async () => {
      const hub = new McpHub();
      try {
        await hub.connectEmailPreferred();
      } catch (err) {
        console.warn('[mcp-hub] email bootstrap failed:', err?.message || err);
      }
      return hub;
    })();
  }
  return hubPromise;
}

export async function resetMcpHub() {
  if (hubPromise) {
    try {
      await (await hubPromise).close();
    } catch {
      /* ignore */
    }
  }
  hubPromise = null;
  return getMcpHub();
}

// silence unused import when remote path unused in some builds
void UnauthorizedError;
