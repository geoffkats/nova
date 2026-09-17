/**
 * Short spoken bridges so Nova stays present while tools run.
 * Keep lines under ~2 seconds of speech.
 */

const EMAIL = [
  'One sec, checking your email.',
  'Let me look through your inbox.',
  'Hang on, pulling up your mail.',
];

const CALENDAR = [
  'One moment, checking your calendar.',
  'Let me see what is on your schedule.',
];

const FILES = [
  'Give me a second to search your files.',
  'One sec, looking that up.',
];

const GENERIC_TOOL = [
  'One moment.',
  'On it.',
  'Give me a second.',
];

/**
 * Only call this when intent is already "tools".
 * @param {string} userText
 * @returns {string | null}
 */
export function pickBridgeLine(userText) {
  const t = String(userText || '').toLowerCase();
  if (!t.trim()) return null;

  if (/\b(email|inbox|mail|unread|gmail|message[s]?)\b/.test(t)) {
    return EMAIL[Math.floor(Math.random() * EMAIL.length)];
  }
  if (/\b(calendar|meeting|schedule|appointment)\b/.test(t)) {
    return CALENDAR[Math.floor(Math.random() * CALENDAR.length)];
  }
  if (/\b(file[s]?|drive|document[s]?|folder)\b/.test(t)) {
    return FILES[Math.floor(Math.random() * FILES.length)];
  }
  return GENERIC_TOOL[Math.floor(Math.random() * GENERIC_TOOL.length)];
}

/**
 * @param {string} toolName
 */
export function progressForTool(toolName) {
  const n = String(toolName || '');
  if (/gmail|email|inbox/i.test(n)) return 'searching your inbox…';
  if (/calendar|event/i.test(n)) return 'checking your calendar…';
  if (/drive|file/i.test(n)) return 'searching your files…';
  return 'working…';
}
