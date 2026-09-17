/**
 * Music: open YouTube in the user's real default browser (their Chrome).
 * Do not auto-click a result — an anonymous Playwright profile cannot tell
 * which upload is the song they meant.
 */

import { shell } from 'electron';

export const MUSIC_TOOL_NAME = 'music';

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

function playUrl(query) {
  if (/^https?:\/\/(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com|open\.spotify\.com)\//i.test(query)) {
    return query;
  }
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

export const MUSIC_ACTIONS = {
  play: { hint: 'Open the song in the user’s Chrome / YouTube. Set query (artist and title). They pick the result.' },
};

export const MUSIC_ACTION_NAMES = Object.keys(MUSIC_ACTIONS);

export function musicActionTool() {
  return {
    type: 'function',
    function: {
      name: MUSIC_TOOL_NAME,
      description: `Open a song in the user's own Chrome on YouTube. Does not pick or autoplay a result — they click the right one. One action: play. Set query as artist and title.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: MUSIC_ACTION_NAMES, description: 'Must be play.' },
          query: { type: 'string', description: 'Song and artist, or a YouTube/Spotify URL.' },
          title: { type: 'string', description: 'Same as query.' },
        },
        required: ['action'],
      },
    },
  };
}

export function isMusicTool(name) {
  return name === MUSIC_TOOL_NAME;
}

export async function runMusicAction(args = {}) {
  const action = String(args.action || '').trim();
  if (action && action !== 'play') {
    return JSON.stringify({
      error: 'Nova cannot pause or pick tracks. Use play with a song name — it opens YouTube in your Chrome.',
    });
  }
  const query = pick(args, ['query', 'title', 'url', 'description']);
  if (!query) return JSON.stringify({ error: 'Need query (song and artist).' });
  const url = playUrl(query);
  console.log('[music] play', query);
  try {
    await shell.openExternal(url);
    return JSON.stringify({
      ok: true,
      url,
      query,
      note: 'Opened in your Chrome. Pick the result — Nova cannot tell which upload is the song.',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[music]', message);
    return JSON.stringify({ error: message });
  }
}
