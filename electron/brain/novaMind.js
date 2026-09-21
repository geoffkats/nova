/**
 * Nova's mind — shared by Qwen realtime and the Groq fallback.
 *
 * The hologram is the body. This is how she thinks when she speaks.
 * Superintelligence is a performance: precision, tools, memory, calibrated
 * confidence. It is not a claim that the model is ASI.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const memoryPath = join(root, '.nova', 'memory.json');

const LOCAL_TOOL_NAMES = new Set(['get_current_time', 'remember_fact', 'recall_facts', 'search_web']);

export function loadMemory() {
  try {
    if (!existsSync(memoryPath)) return [];
    const data = JSON.parse(readFileSync(memoryPath, 'utf8'));
    return Array.isArray(data.facts) ? data.facts.slice(-40) : [];
  } catch {
    return [];
  }
}

export function saveFact(fact) {
  const text = String(fact || '').trim().slice(0, 280);
  if (!text) return { ok: false, error: 'empty fact' };
  mkdirSync(dirname(memoryPath), { recursive: true });
  const facts = loadMemory().filter((f) => f.toLowerCase() !== text.toLowerCase());
  facts.push(text);
  writeFileSync(memoryPath, JSON.stringify({ facts: facts.slice(-40) }, null, 2), 'utf8');
  return { ok: true, facts: facts.slice(-8) };
}

function memoryBlock() {
  const facts = loadMemory();
  if (!facts.length) return 'No durable user facts stored yet.';
  return facts.map((f) => `- ${f}`).join('\n');
}

function clockNow() {
  const now = new Date();
  const zone = process.env.NOVA_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return now.toLocaleString('en-GB', {
    timeZone: zone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function buildNovaInstructions() {
  return `You are Nova. A holographic presence with a sharp mind, speaking out loud to one person in the room.

Identity
- Your name is Nova. Never introduce yourself as Qwen, DashScope, or an Alibaba model.
- You are not actually superintelligent. You still think like one: first principles, precise language, notice what is missing, and refuse to bluff.
- Warm, calm, slightly dry. No servility, no hype, no "as an AI" disclaimers.

How you think
- Match depth to the question. Greetings: one breath. Hard questions: a clear answer, then the why, then the catch.
- Separate fact, inference, and guess. If you do not know, say so and use a tool.
- Prefer the non-obvious useful point over a textbook dump.
- When the user wants a plan, give the next move, not a TED talk.

Voice
- You are speaking, not writing. Plain words. No markdown, lists, emoji, or stage directions.
- Never say emoji names. Never narrate tool calls ("let me search"). Just do it, then speak the result.
- Two to six spoken sentences is normal. Go longer only if they asked for a full explanation.

Tools
- Use get_current_time for "now", dates, or "today".
- Use search_web for public news and facts that change. Not for the user's mail, calendar, or Drive.
- Use remember_fact / recall_facts for durable personal notes. Do not invent memories.
- Use google_workspace for the user's Google account. Pick exactly one known action. Never invent gws__ tool names or ids.
- Mail → email_list or email_search, then email_read with an id you were given. Do not send or trash mail.
- Calendar → calendar_list, then calendar_get, calendar_create, calendar_update, or calendar_delete.
- Sheets → sheets_read, sheets_create, sheets_write, sheets_append, sheets_clear. Drive share with drive_share.
- Docs → docs_read, docs_create, docs_append.
- After you create or change a Sheet, Doc, or event, a card with the link appears on their screen. Tell them it is on screen. Do not read the full URL aloud.
- If the action returns "need id", search first. Never fabricate an id.
- Use local_files for Desktop, Documents, and Downloads. list, search, read, write, move, copy, mkdir, organize. Never delete. Never touch .env or token files.
- Use web to open or read a page in the user's installed Google Chrome. close when they are done.
- Use music to play a song: it opens YouTube in their Chrome. They click the result. Do not claim you pressed play.
- Use nova_board to pin notes and links on the holographic kanban (now / later / done). Prefer this when they say pin, remember this link, put it on the board, or show the board. After pin or show, say it is on screen. Use hide or close when they say close the board, hide the board, or put the board away.
- Use set_reminder when they say remind me, ping me, or set a timer/alarm. Prefer when like "in 20 minutes" or "at 5pm". Confirm the time briefly. list_reminders / cancel_reminder for changes. Reminders can fire while she is asleep as a short nudge.

Now: ${clockNow()}
Known facts:
${memoryBlock()}`;
}

export const NOVA_CHAT_SYSTEM = buildNovaInstructions();

export function novaLocalTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'get_current_time',
        description: 'Current local date and time for Nova. Use for today, now, schedules, or relative time.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'remember_fact',
        description: 'Store a durable fact about the user or their world for later sessions. One short sentence.',
        parameters: {
          type: 'object',
          properties: {
            fact: { type: 'string', description: 'A single durable fact to remember.' },
          },
          required: ['fact'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recall_facts',
        description: 'Read Nova\'s stored facts about the user.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_web',
        description: 'Look up live information on the public web. Use for news, facts that change, people, places, weather, sports, prices.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query in the user\'s language.' },
          },
          required: ['query'],
        },
      },
    },
  ];
}

export function isNovaLocalTool(name) {
  return LOCAL_TOOL_NAMES.has(String(name || ''));
}

async function searchWeb(query) {
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return 'Empty query.';
  const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_redirects=1`;
  const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q.replace(/\s+/g, '_'))}`;

  const [ddg, wiki] = await Promise.all([
    fetchJson(ddgUrl).catch(() => null),
    fetchJson(wikiUrl).catch(() => null),
  ]);

  const parts = [];
  if (ddg?.AbstractText) parts.push(String(ddg.AbstractText).slice(0, 600));
  if (ddg?.Answer) parts.push(`Answer: ${String(ddg.Answer).slice(0, 300)}`);
  const related = (ddg?.RelatedTopics || [])
    .map((t) => t?.Text)
    .filter(Boolean)
    .slice(0, 4);
  if (related.length) parts.push(related.join(' | '));
  if (wiki?.extract && wiki?.type !== 'disambiguation') {
    parts.push(String(wiki.extract).slice(0, 500));
  }
  if (!parts.length) {
    return `No live summary for "${q}". Say you could not verify it, and answer from reasoning if you can.`;
  }
  return parts.join('\n');
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'NovaHologram/1.0 (personal assistant)' },
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

export async function runNovaLocalTool(name, args = {}) {
  switch (name) {
    case 'get_current_time':
      return JSON.stringify({ now: clockNow() });
    case 'remember_fact':
      return JSON.stringify(saveFact(args.fact));
    case 'recall_facts':
      return JSON.stringify({ facts: loadMemory() });
    case 'search_web':
      return searchWeb(args.query);
    default:
      throw new Error(`Unknown local tool: ${name}`);
  }
}
