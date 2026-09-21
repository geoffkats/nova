/**
 * Local timed reminders — Nova can nudge while "asleep" without keeping Qwen open.
 * Persist under .nova/reminders.json. Scheduler fires avatar:nudge to the UI.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REMINDER_TOOL_NAMES = new Set(['set_reminder', 'list_reminders', 'cancel_reminder']);

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const storePath = join(root, '.nova', 'reminders.json');

/** @type {ReturnType<typeof setInterval> | null} */
let tickTimer = null;
/** @type {((nudge: object) => void) | null} */
let onFire = null;
const firedThisTick = new Set();

function str(v) {
  return String(v ?? '').trim();
}

function newId() {
  return `rem_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function loadAll() {
  try {
    if (!existsSync(storePath)) return [];
    const data = JSON.parse(readFileSync(storePath, 'utf8'));
    return Array.isArray(data?.reminders) ? data.reminders : [];
  } catch {
    return [];
  }
}

function saveAll(reminders) {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify({ reminders }, null, 2), 'utf8');
  return reminders;
}

/**
 * Parse "in 20 minutes", "in 1 hour", "at 5", "at 5pm", "at 17:30".
 * @param {string} when
 * @param {Date} [now]
 * @returns {{ at: number, label: string } | { error: string }}
 */
export function parseWhen(when, now = new Date()) {
  const t = str(when).toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!t) return { error: 'missing when' };

  const inMin = t.match(/^in\s+(\d+)\s*(m|min|mins|minute|minutes)?$/);
  if (inMin) {
    const n = Number(inMin[1]);
    if (!Number.isFinite(n) || n < 1) return { error: 'bad minutes' };
    const at = now.getTime() + n * 60_000;
    return { at, label: `in ${n} min` };
  }

  const inHr = t.match(/^in\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)$/);
  if (inHr) {
    const n = Number(inHr[1]);
    if (!Number.isFinite(n) || n <= 0) return { error: 'bad hours' };
    const at = now.getTime() + Math.round(n * 3600_000);
    return { at, label: `in ${n} h` };
  }

  // at 5 / at 5pm / at 5:30 pm / at 17:30
  const atMatch = t.match(
    /^(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/,
  );
  if (atMatch) {
    let h = Number(atMatch[1]);
    const m = Number(atMatch[2] || 0);
    const ap = atMatch[3] || '';
    if (h > 23 || m > 59) return { error: 'bad clock time' };
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (!ap && h <= 12) {
      // Bare "at 5" → next 5:00 in 12h sense favoring later today afternoon if morning passed oddly;
      // prefer next occurrence of that hour today, else tomorrow.
    }
    const target = new Date(now);
    target.setSeconds(0, 0);
    target.setHours(h, m, 0, 0);
    if (target.getTime() <= now.getTime() + 15_000) {
      target.setDate(target.getDate() + 1);
    }
    const label = target.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return { at: target.getTime(), label: `at ${label}` };
  }

  return { error: `could not parse when: "${when}"` };
}

export function listReminders() {
  const now = Date.now();
  return loadAll()
    .filter((r) => r.status === 'scheduled' && Number(r.at) > now - 60_000)
    .sort((a, b) => Number(a.at) - Number(b.at));
}

/**
 * @param {{ text?: string, when?: string, inMinutes?: number }} args
 */
export function addReminder(args = {}) {
  const text = str(args.text).slice(0, 200);
  if (!text) return { ok: false, error: 'What should I remind you about?' };

  let at;
  let label;
  if (args.inMinutes != null && Number(args.inMinutes) > 0) {
    const n = Math.round(Number(args.inMinutes));
    at = Date.now() + n * 60_000;
    label = `in ${n} min`;
  } else {
    const parsed = parseWhen(args.when || '');
    if ('error' in parsed) return { ok: false, error: parsed.error };
    at = parsed.at;
    label = parsed.label;
  }

  if (at < Date.now() + 10_000) {
    return { ok: false, error: 'That time is too soon — pick at least ~15 seconds out.' };
  }

  const rem = {
    id: newId(),
    text,
    at,
    label,
    status: 'scheduled',
    created: Date.now(),
  };
  const all = loadAll().filter((r) => r.status === 'scheduled' || Number(r.at) > Date.now() - 86_400_000);
  all.push(rem);
  saveAll(all.slice(-60));
  console.log(`[remind] scheduled ${rem.id} ${label} → ${text}`);
  return {
    ok: true,
    id: rem.id,
    text,
    at,
    label,
    when: new Date(at).toLocaleString(),
    spokenHint: `Okay — I'll remind you ${label}: ${text}`,
  };
}

export function cancelReminder(id) {
  const want = str(id);
  if (!want) return { ok: false, error: 'Need a reminder id' };
  const all = loadAll();
  const hit = all.find((r) => r.id === want || r.id.endsWith(want));
  if (!hit) return { ok: false, error: 'Reminder not found' };
  hit.status = 'cancelled';
  saveAll(all);
  return { ok: true, id: hit.id, text: hit.text };
}

function markFired(id) {
  const all = loadAll();
  const hit = all.find((r) => r.id === id);
  if (hit) {
    hit.status = 'fired';
    hit.firedAt = Date.now();
    saveAll(all);
  }
}

function tick() {
  if (!onFire) return;
  const now = Date.now();
  for (const r of loadAll()) {
    if (r.status !== 'scheduled') continue;
    if (Number(r.at) > now) continue;
    if (firedThisTick.has(r.id)) continue;
    firedThisTick.add(r.id);
    markFired(r.id);
    const spoken = `Hey — reminder: ${r.text}`;
    console.log(`[remind] fire ${r.id}: ${r.text}`);
    try {
      onFire({
        id: r.id,
        text: r.text,
        spoken,
        at: r.at,
      });
    } catch (err) {
      console.warn('[remind] onFire failed:', err instanceof Error ? err.message : err);
    }
  }
}

/**
 * @param {(nudge: { id: string, text: string, spoken: string, at: number }) => void} handler
 */
export function startReminderScheduler(handler) {
  onFire = handler;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = setInterval(tick, 4000);
  tick();
  console.log(`[remind] scheduler on · ${listReminders().length} pending`);
}

export function stopReminderScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  onFire = null;
}

export function reminderToolDefs() {
  return [
    {
      type: 'function',
      function: {
        name: 'set_reminder',
        description:
          'Schedule a local reminder. Nova will nudge even while asleep (short speak, then listen briefly). Use when the user says remind me, ping me, or set an alarm.',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to say when it fires, e.g. meeting with Alex' },
            when: {
              type: 'string',
              description: 'When: "in 20 minutes", "in 1 hour", "at 5", "at 5pm", "at 17:30"',
            },
            inMinutes: { type: 'number', description: 'Optional shortcut: minutes from now' },
          },
          required: ['text'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_reminders',
        description: 'List upcoming local reminders.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'cancel_reminder',
        description: 'Cancel a scheduled reminder by id from list_reminders.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
    },
  ];
}

export function isReminderTool(name) {
  return REMINDER_TOOL_NAMES.has(String(name || ''));
}

export function runReminderTool(name, args = {}) {
  switch (name) {
    case 'set_reminder':
      return JSON.stringify(addReminder(args));
    case 'list_reminders':
      return JSON.stringify({
        reminders: listReminders().map((r) => ({
          id: r.id,
          text: r.text,
          when: new Date(r.at).toLocaleString(),
          label: r.label,
        })),
      });
    case 'cancel_reminder':
      return JSON.stringify(cancelReminder(args.id));
    default:
      throw new Error(`Unknown reminder tool: ${name}`);
  }
}
