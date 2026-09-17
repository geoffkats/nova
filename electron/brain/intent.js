/**
 * Route utterances:
 * - instant: pure greetings only (no real questions)
 * - tools: clear email/calendar/files ask
 * - chat: everything else (LLM, no tools)
 */

const TOOL_DOMAIN_RE =
  /\b(e-?mails?|inbox|gmail|unread|calendar|meetings?|schedule|appointments?|files?|drive|documents?|docs|folders?|attachments?)\b/i;

const TOOL_ACTION_RE =
  /\b(check|search|find|look\s*up|pull\s*up|open|read|show|list)\b/i;

/** Real questions must never get canned instant lines. */
const QUESTION_RE =
  /\b(does|do|did|can|could|would|will|what|why|when|where|who|which|how|is|are|am|should|tell|explain|mean|speak|talk|think|know)\b/i;

/**
 * @param {string} text
 */
export function normalizeUtterance(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/["""']/g, '')
    .replace(/[,;:]+/g, ' ')
    .replace(/\b(key|kay|hei|hay|he+)\s+(nova)\b/g, 'hey $2')
    .replace(/\b(nover|novaah|noba)\b/g, 'nova')
    .replace(/[^a-z0-9'\s?!.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure greeting / ack — nothing else.
 * @param {string} t normalized
 */
function isPureGreeting(t) {
  if (/^nova([!.?]*)$/.test(t)) return true;
  if (
    /^(hey|hi|hello|yo|sup|hiya|howdy)(\s+nova)?([!.?]*)$/.test(t)
  ) {
    return true;
  }
  if (/^(good\s*(morning|afternoon|evening))(\s+nova)?([!.?]*)$/.test(t)) {
    return true;
  }
  if (/^(thanks|thank you|ty|cheers)(\s+nova)?([!.?]*)$/.test(t)) return true;
  if (/^(bye|goodbye|see you|later)(\s+nova)?([!.?]*)$/.test(t)) return true;
  if (/^(how are you|what'?s up|you there)(\s+nova)?([!.?]*)$/.test(t)) return true;
  if (/^(ok|okay|sure|cool|nice|got it|alright)([!.?]*)$/.test(t)) return true;
  return false;
}

/**
 * @param {string} userText
 * @returns {'instant' | 'chat' | 'tools'}
 */
export function classifyIntent(userText) {
  const raw = String(userText || '').trim();
  const t = normalizeUtterance(raw);
  if (!t) return 'chat';

  const hasDomain = TOOL_DOMAIN_RE.test(t);
  const hasAction = TOOL_ACTION_RE.test(t);

  if (hasDomain && (hasAction || /\b(my|the)\b/.test(t))) {
    return 'tools';
  }

  // Any real question / longer thought → chat (LLM), never canned.
  if (QUESTION_RE.test(t) && !isPureGreeting(t)) {
    return 'chat';
  }
  if (t.includes('?') && !isPureGreeting(t)) {
    return 'chat';
  }

  if (isPureGreeting(t)) return 'instant';

  return 'chat';
}

/**
 * @param {string} userText
 * @returns {string | null}
 */
export function instantReply(userText) {
  const t = normalizeUtterance(userText);
  if (!isPureGreeting(t)) return null;

  if (/^nova([!.?]*)$/.test(t)) {
    return pick(['Yes?', 'I am listening.', 'Here — what do you need?']);
  }
  if (/\b(thanks?|thank you|cheers)\b/.test(t)) {
    return pick(['You are welcome.', 'Anytime.', 'Glad to help.']);
  }
  if (/\b(bye|goodbye|see you|later)\b/.test(t)) {
    return pick(['Bye for now.', 'See you.', 'Catch you later.']);
  }
  if (/\b(how are you|what'?s up|you there)\b/.test(t)) {
    return pick(['I am good — ready when you are.', 'Right here.', 'All good.']);
  }
  if (/^(ok|okay|sure|cool|nice|got it|alright)([!.?]*)$/.test(t)) {
    return pick(['Okay.', 'Sounds good.', 'Alright.']);
  }
  return pick([
    'Hey — I am Nova.',
    'Hi, I am here.',
    'Hey. What do you need?',
    'Hello — listening.',
  ]);
}

/** @param {string[]} lines */
function pick(lines) {
  return lines[Math.floor(Math.random() * lines.length)];
}
