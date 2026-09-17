#!/usr/bin/env node
/**
 * Authenticate Nova against Google's official Gmail MCP:
 *   https://gmailmcp.googleapis.com/mcp/v1
 *
 * Then: npm run gmail:auth
 */

import { config as loadEnv } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GMAIL_REDIRECT_URI,
  clearOAuthStore,
  hasGmailCredentials,
  hasGmailTokens,
} from '../electron/agent/gmailOAuth.js';
import { McpHub } from '../electron/agent/mcpHub.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: join(root, '.env') });

async function main() {
  console.log('Nova → Google Workspace Gmail MCP');
  console.log('  server:', 'https://gmailmcp.googleapis.com/mcp/v1');
  console.log('  redirect:', GMAIL_REDIRECT_URI);

  if (!hasGmailCredentials()) {
    console.error(`
Missing credentials. Add to .env:

  GOOGLE_OAUTH_CLIENT_ID=...
  GOOGLE_OAUTH_CLIENT_SECRET=...

See mcp/email/README.md for the Google Cloud setup steps.
`);
    process.exit(1);
  }

  // Clear incomplete prior attempt (codeVerifier-only).
  if (!hasGmailTokens()) {
    clearOAuthStore();
    console.log('Starting fresh OAuth (no access token on disk yet)…');
  }

  const hub = new McpHub();
  const result = await hub.authenticateGmail();

  if (!hasGmailTokens()) {
    throw new Error('Auth finished but access token was not saved.');
  }

  console.log(`\nOK — connected with tokens. Exposed ${result.tools} read-only tools:`);
  for (const t of hub.listOpenAiTools().filter((x) => x.function.name.startsWith('gmail__'))) {
    console.log(' -', t.function.name);
  }

  const sample = await hub.callTool('gmail__search_threads', {
    query: 'is:unread',
    pageSize: 5,
  });
  if (sample.isError) {
    throw new Error(`search_threads failed: ${sample.text.slice(0, 300)}`);
  }
  console.log('\nSample search (is:unread):\n', sample.text.slice(0, 1000));

  await hub.close();
  console.log('\nTokens saved under .nova/gmail-oauth.json — restart Electron and ask Nova to check email.');
}

main().catch((err) => {
  console.error('gmail:auth failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
