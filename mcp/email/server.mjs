#!/usr/bin/env node
/**
 * Read-only Email MCP server for Nova.
 *
 * Phase 1: demo mailbox (no OAuth) so "check my email" works end-to-end.
 * Later: swap the store for Gmail / IMAP behind the same tool names.
 *
 * Tools (all read-only):
 *   search_emails  — filter by query / unread
 *   read_email     — fetch one message by id
 *   inbox_summary  — quick unread + priority heuristic
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const mailboxPath = process.env.NOVA_EMAIL_MAILBOX || join(here, 'demo-mailbox.json');

/** @type {Array<Record<string, any>>} */
let mailbox = [];
try {
  mailbox = JSON.parse(readFileSync(mailboxPath, 'utf8'));
} catch (err) {
  console.error('[email-mcp] failed to load mailbox:', err);
  process.exit(1);
}

const server = new McpServer({
  name: 'nova-email',
  version: '0.1.0',
});

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

function matchesQuery(msg, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [msg.subject, msg.from, msg.snippet, msg.body]
    .filter(Boolean)
    .some((f) => String(f).toLowerCase().includes(q));
}

function priorityScore(msg) {
  const text = `${msg.subject} ${msg.snippet} ${msg.body}`.toLowerCase();
  let score = msg.unread ? 1 : 0;
  if (/urgent|asap|attention|deadline|invoice|security|sign-in|client|project|assignment|review/.test(text)) {
    score += 2;
  }
  if (/newsletter|unsubscribe|ci passed|receipt/.test(text)) score -= 1;
  return score;
}

server.registerTool(
  'search_emails',
  {
    description:
      'Search the mailbox. Read-only. Returns id, from, subject, date, unread, snippet.',
    annotations: readOnly,
    inputSchema: {
      query: z.string().optional().describe('Free-text filter across subject/from/body'),
      unread_only: z.boolean().optional().describe('If true, only unread messages'),
      limit: z.number().int().min(1).max(20).optional().describe('Max results (default 10)'),
    },
  },
  async ({ query, unread_only, limit }) => {
    const max = limit ?? 10;
    const hits = mailbox
      .filter((m) => (unread_only ? m.unread : true))
      .filter((m) => matchesQuery(m, query))
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, max)
      .map(({ id, from, subject, date, unread, snippet }) => ({
        id,
        from,
        subject,
        date,
        unread,
        snippet,
      }));

    return {
      content: [{ type: 'text', text: JSON.stringify({ count: hits.length, emails: hits }, null, 2) }],
    };
  },
);

server.registerTool(
  'read_email',
  {
    description: 'Read a single email by id. Read-only. Returns full body.',
    annotations: readOnly,
    inputSchema: {
      id: z.string().describe('Email id from search_emails'),
    },
  },
  async ({ id }) => {
    const msg = mailbox.find((m) => m.id === id);
    if (!msg) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `No email with id ${id}` }) }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              id: msg.id,
              from: msg.from,
              to: msg.to,
              subject: msg.subject,
              date: msg.date,
              unread: msg.unread,
              body: msg.body,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.registerTool(
  'inbox_summary',
  {
    description:
      'Summarize the inbox for a voice assistant: unread count and messages that likely need attention. Read-only.',
    annotations: readOnly,
    inputSchema: {
      max_priority: z
        .number()
        .int()
        .min(1)
        .max(5)
        .optional()
        .describe('How many priority items to include (default 3)'),
    },
  },
  async ({ max_priority }) => {
    const unread = mailbox.filter((m) => m.unread);
    const priority = [...unread]
      .map((m) => ({ ...m, score: priorityScore(m) }))
      .filter((m) => m.score >= 2)
      .sort((a, b) => b.score - a.score || Date.parse(b.date) - Date.parse(a.date))
      .slice(0, max_priority ?? 3)
      .map(({ id, from, subject, snippet, score }) => ({ id, from, subject, snippet, score }));

    const payload = {
      unread_count: unread.length,
      total_count: mailbox.length,
      needs_attention: priority,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[email-mcp] ready (${mailbox.length} messages from ${mailboxPath})`);
}

main().catch((err) => {
  console.error('[email-mcp] fatal:', err);
  process.exit(1);
});
