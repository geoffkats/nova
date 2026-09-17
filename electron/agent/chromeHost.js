/**
 * One Google Chrome window for Nova. Uses the installed Chrome binary —
 * never downloads Playwright's Chromium.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const profileDir = join(root, '.nova', 'chrome-profile');

/** @type {import('playwright-core').BrowserContext | null} */
let context = null;
/** @type {import('playwright-core').Page | null} */
let page = null;

function chromeExecutable() {
  const env = process.env.NOVA_CHROME_PATH?.trim();
  const home = homedir();
  const local = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const candidates = [
    env,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return candidates.find((p) => p && existsSync(p));
}

export function chromeAvailable() {
  return Boolean(chromeExecutable());
}

async function ensureContext() {
  if (context) return context;
  const executablePath = chromeExecutable();
  if (!executablePath) {
    throw new Error('Google Chrome is not installed. Nova uses your Chrome — it will not download another browser.');
  }
  mkdirSync(profileDir, { recursive: true });
  const { chromium } = await import('playwright-core');
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: false,
    viewport: { width: 1100, height: 740 },
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  context.on('close', () => {
    context = null;
    page = null;
  });
  console.log('[chrome] launched', executablePath);
  return context;
}

export async function getChromePage() {
  const ctx = await ensureContext();
  if (page && !page.isClosed()) {
    try {
      await page.bringToFront();
    } catch {
      /* ignore */
    }
    return page;
  }
  const open = ctx.pages().filter((p) => !p.isClosed());
  page = open[0] || (await ctx.newPage());
  page.on('close', () => {
    if (page?.isClosed()) page = null;
  });
  try {
    await page.bringToFront();
  } catch {
    /* ignore */
  }
  return page;
}

export async function dismissBanners(page) {
  const names = [/accept all/i, /^accept$/i, /i agree/i, /agree$/i, /reject all/i];
  for (const name of names) {
    try {
      const btn = page.getByRole('button', { name }).first();
      if (await btn.isVisible({ timeout: 800 })) {
        await btn.click({ timeout: 1500 });
        return;
      }
    } catch {
      /* next */
    }
  }
}

export async function closeChrome() {
  const ctx = context;
  context = null;
  page = null;
  if (!ctx) return;
  try {
    await ctx.close();
  } catch {
    /* already gone */
  }
}
