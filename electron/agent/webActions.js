/**
 * Closed Chrome catalog. Playwright-core drives installed Google Chrome.
 * No Chromium download. One window, known actions only.
 */

import { closeChrome, dismissBanners, getChromePage } from './chromeHost.js';

export const WEB_TOOL_NAME = 'web';

const MAX_READ = 6000;

function str(v) {
  const s = String(v ?? '').trim();
  return s || undefined;
}

function pick(args, keys) {
  for (const k of keys) {
    const v = str(args[k]);
    if (v) return v;
  }
}

function asUrl(raw) {
  const input = str(raw);
  if (!input) return { error: 'Need url or query.' };
  if (/^https?:\/\//i.test(input)) {
    try {
      const u = new URL(input);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { error: 'Only http(s) URLs.' };
      }
      return { url: u.href };
    } catch {
      return { error: 'Invalid URL.' };
    }
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}([/:].*)?$/i.test(input) && !/\s/.test(input)) {
    return { url: `https://${input}` };
  }
  return { url: `https://www.google.com/search?q=${encodeURIComponent(input)}` };
}

async function pageInfo(page, extra = {}) {
  const url = page.url();
  const title = (await page.title().catch(() => '')) || url;
  return { ok: true, title, url, ...extra };
}

export const WEB_ACTIONS = {
  open: { hint: 'Open a site in Google Chrome. Set url (https://…) or query to search.' },
  read: { hint: 'Read visible text of the current Chrome tab, or set url first.' },
  close: { hint: 'Close Nova’s Chrome window.' },
};

export const WEB_ACTION_NAMES = Object.keys(WEB_ACTIONS);

export function webActionTool() {
  return {
    type: 'function',
    function: {
      name: WEB_TOOL_NAME,
      description: `Open and read pages in the user's installed Google Chrome. Does not install a browser. One known action.

open — open url or search query in Chrome
read — visible text of the current tab (or url)
close — close Nova’s Chrome window`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: WEB_ACTION_NAMES, description: 'The single known action.' },
          url: { type: 'string', description: 'https URL, domain, or search query for open/read.' },
          query: { type: 'string', description: 'Search query if url is empty.' },
        },
        required: ['action'],
      },
    },
  };
}

export function isWebTool(name) {
  return name === WEB_TOOL_NAME;
}

export async function runWebAction(args = {}) {
  const action = String(args.action || '').trim();
  if (!WEB_ACTIONS[action]) {
    return JSON.stringify({ error: `Unknown action "${action}". Use open, read, or close.` });
  }
  console.log('[web]', action, pick(args, ['url', 'query']) || '');
  try {
    if (action === 'close') {
      await closeChrome();
      return JSON.stringify({ ok: true, closed: true });
    }
    const raw = pick(args, ['url', 'query', 'path', 'title']);
    if (action === 'open') {
      const target = asUrl(raw);
      if (target.error) return JSON.stringify(target);
      const page = await getChromePage();
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await dismissBanners(page);
      return JSON.stringify(await pageInfo(page));
    }
    const page = await getChromePage();
    if (raw) {
      const target = asUrl(raw);
      if (target.error) return JSON.stringify(target);
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await dismissBanners(page);
    }
    const text = String(await page.locator('body').innerText({ timeout: 8_000 }).catch(() => '')).slice(0, MAX_READ);
    return JSON.stringify({ ...(await pageInfo(page)), text });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[web]', action, message);
    return JSON.stringify({ error: message });
  }
}
