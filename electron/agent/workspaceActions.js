/**
 * Closed Workspace action catalog.
 *
 * The MCP server has 60+ tools. The model must not see them. It picks one
 * known action; we map that to a single MCP call. That cuts token cost,
 * latency, and tool hallucination.
 */

export const WORKSPACE_TOOL_NAME = 'google_workspace';

/** @typedef {{ tool: string, need?: string[], hint: string, map: (a: Record<string, unknown>) => Record<string, unknown> }} ActionSpec */

/** Caller-facing `need` keys → accepted argument aliases (never mapped MCP names). */
const NEED_ALIASES = {
  id: ['id', 'message_id', 'thread_id', 'event_id', 'file_id', 'document_id', 'spreadsheet_id', 'folder_id'],
  query: ['query', 'range'],
  title: ['title', 'summary'],
  values: ['values', 'description'],
  description: ['description', 'content'],
  attendees: ['attendees', 'email'],
};

const ARTIFACT_ACTIONS = new Set([
  'calendar_create',
  'calendar_update',
  'calendar_get',
  'docs_create',
  'docs_read',
  'docs_append',
  'sheets_create',
  'sheets_read',
  'sheets_write',
  'sheets_append',
  'drive_get',
  'drive_share',
]);

function isoNow() {
  return new Date().toISOString();
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function str(v) {
  const s = String(v ?? '').trim();
  return s || undefined;
}

function sheetValues(a) {
  if (Array.isArray(a.values)) return JSON.stringify(a.values);
  const raw = str(a.values) ?? (str(a.description) && !str(a.values) ? str(a.description) : undefined);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return JSON.stringify(parsed);
    return JSON.stringify([[parsed]]);
  } catch {
    const rows = raw.split(/\r?\n/).map((line) => line.split(/\t|,/)).filter((row) => row.some((c) => str(c)));
    return rows.length ? JSON.stringify(rows) : undefined;
  }
}

function driveQuery(raw) {
  const q = str(raw);
  if (!q) return undefined;
  if (/[=:]/.test(q) || /\bcontains\b/i.test(q)) return q;
  return `name contains '${q.replace(/'/g, "\\'")}'`;
}

function parseJsonish(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch {
    return null;
  }
}

function a1Range(sheetTitle, cells = 'A1:Z20') {
  const title = str(sheetTitle);
  if (!title) return cells;
  const quoted = /[\s'!]/.test(title) ? `'${title.replace(/'/g, "''")}'` : title;
  return `${quoted}!${cells}`;
}

function firstSheetTitle(metaText) {
  const parsed = parseJsonish(metaText);
  const sheets = parsed?.sheets;
  if (!Array.isArray(sheets) || !sheets.length) return undefined;
  const named = sheets.find((s) => str(s?.title));
  return str(named?.title || sheets[0]?.title);
}

function rangeFailed(text) {
  return /unable to parse range|unable to parse the range|invalid range|sheet.*not found/i.test(
    String(text || ''),
  );
}

function toolFailed(result) {
  if (result?.isError) return true;
  const text = String(result?.text || '');
  const parsed = parseJsonish(text);
  if (parsed && parsed.success === false) return rangeFailed(parsed.error || text);
  return rangeFailed(text);
}

function missingNeeds(need, args) {
  return need.filter((key) => {
    const keys = NEED_ALIASES[key] || [key];
    return !keys.some((k) => str(args[k]));
  });
}

function logShape(args) {
  return Object.keys(args).sort().join(',') || '(empty)';
}

/** @type {Record<string, ActionSpec>} */
export const KNOWN_ACTIONS = {
  email_list: {
    tool: 'gmail_list',
    hint: 'Overview of inbox or unread mail.',
    map: (a) => ({
      max_results: Math.min(num(a.max_results, 8), 15),
      query: str(a.query) || 'in:inbox',
    }),
  },
  email_search: {
    tool: 'gmail_search',
    need: ['query'],
    hint: 'Find mail by sender, subject, or Gmail query. Set query.',
    map: (a) => ({
      query: str(a.query),
      max_results: Math.min(num(a.max_results, 8), 15),
    }),
  },
  email_read: {
    tool: 'gmail_get',
    need: ['id'],
    hint: 'Read one message or thread. Set id from a previous list/search.',
    map: (a) => {
      const threadId = str(a.thread_id);
      const messageId = str(a.message_id) || str(a.id);
      if (threadId && !str(a.message_id)) {
        return { _tool: 'gmail_thread_get', thread_id: threadId, format: 'full' };
      }
      return { message_id: messageId || threadId, format: 'full' };
    },
  },
  calendar_list: {
    tool: 'calendar_event_list',
    hint: 'Upcoming events. Optional query, time_min, time_max.',
    map: (a) => ({
      max_results: Math.min(num(a.max_results, 10), 20),
      time_min: str(a.time_min) || isoNow(),
      time_max: str(a.time_max),
      query: str(a.query),
    }),
  },
  calendar_get: {
    tool: 'calendar_event_get',
    need: ['id'],
    hint: 'One event. Set id from calendar_list.',
    map: (a) => ({ event_id: str(a.id) || str(a.event_id) }),
  },
  calendar_create: {
    tool: 'calendar_event_create',
    need: ['title', 'start_time', 'end_time'],
    hint: 'Book an event. Need title, start_time, end_time (ISO 8601).',
    map: (a) => ({
      summary: str(a.title) || str(a.summary),
      start_time: str(a.start_time),
      end_time: str(a.end_time),
      description: str(a.description),
      location: str(a.location),
      attendees: str(a.attendees),
      timezone: str(a.timezone) || process.env.NOVA_TIMEZONE?.trim() || undefined,
    }),
  },
  calendar_update: {
    tool: 'calendar_event_update',
    need: ['id'],
    hint: 'Change an event. Set id from calendar_list. Optional title, start_time, end_time, description, location.',
    map: (a) => ({
      event_id: str(a.id) || str(a.event_id),
      summary: str(a.title) || str(a.summary),
      start_time: str(a.start_time),
      end_time: str(a.end_time),
      description: str(a.description),
      location: str(a.location),
    }),
  },
  calendar_delete: {
    tool: 'calendar_event_delete',
    need: ['id'],
    hint: 'Delete an event. Set id from calendar_list. This cannot be undone.',
    map: (a) => ({ event_id: str(a.id) || str(a.event_id) }),
  },
  drive_search: {
    tool: 'drive_search',
    need: ['query'],
    hint: 'Find files by name. Set query.',
    map: (a) => ({
      query: driveQuery(a.query),
      max_results: Math.min(num(a.max_results, 10), 20),
    }),
  },
  drive_list: {
    tool: 'drive_list',
    hint: 'List files in Drive or a folder. Optional id = folder id.',
    map: (a) => ({
      folder_id: str(a.id) || str(a.folder_id),
      max_results: Math.min(num(a.max_results, 20), 40),
      file_types: str(a.file_types),
      recursive: Boolean(a.recursive),
    }),
  },
  drive_get: {
    tool: 'drive_get',
    need: ['id'],
    hint: 'File metadata. Set id from drive_search or drive_list.',
    map: (a) => ({ file_id: str(a.id) || str(a.file_id) }),
  },
  docs_read: {
    tool: 'docs_get',
    need: ['id'],
    hint: 'Read a Google Doc. Set id from Drive search.',
    map: (a) => ({ document_id: str(a.id) || str(a.document_id) }),
  },
  docs_create: {
    tool: 'docs_create',
    need: ['title'],
    hint: 'Create a Google Doc. Set title. Optional description as body via docs_create_formatted.',
    map: (a) => {
      const content = str(a.description) || str(a.content);
      if (content) {
        return { _tool: 'docs_create_formatted', title: str(a.title), content };
      }
      return { title: str(a.title) };
    },
  },
  docs_append: {
    tool: 'docs_append',
    need: ['id', 'description'],
    hint: 'Append text to a Google Doc. Set id and description as the new text.',
    map: (a) => ({
      document_id: str(a.id) || str(a.document_id),
      text: str(a.description) || str(a.content),
    }),
  },
  sheets_read: {
    tool: 'sheets_read',
    need: ['id'],
    hint: 'Read a spreadsheet. Set id. Optional query as A1 range including the tab name. Omit query to read the first tab.',
    map: (a) => {
      const range = str(a.query) || str(a.range);
      return {
        spreadsheet_id: str(a.id) || str(a.spreadsheet_id),
        range,
        _resolveSheet: !range,
      };
    },
  },
  sheets_create: {
    tool: 'sheets_create',
    need: ['title'],
    hint: 'Create a spreadsheet. Set title. A card with the link appears on screen.',
    map: (a) => ({ title: str(a.title) }),
  },
  sheets_write: {
    tool: 'sheets_write',
    need: ['id', 'values'],
    hint: 'Overwrite cells. Set id and values as JSON rows [["A","B"],["1","2"]] or TSV. Optional query as A1 range.',
    map: (a) => ({
      spreadsheet_id: str(a.id) || str(a.spreadsheet_id),
      range: str(a.query) || str(a.range) || 'A1',
      values: sheetValues(a),
    }),
  },
  sheets_append: {
    tool: 'sheets_append',
    need: ['id', 'values'],
    hint: 'Add rows. Set id and values as JSON rows or TSV. Optional query as A1 range.',
    map: (a) => ({
      spreadsheet_id: str(a.id) || str(a.spreadsheet_id),
      range: str(a.query) || str(a.range) || 'A1',
      values: sheetValues(a),
    }),
  },
  sheets_clear: {
    tool: 'sheets_clear',
    need: ['id'],
    hint: 'Clear a range. Set id. Optional query as A1 range (default first tab).',
    map: (a) => ({
      spreadsheet_id: str(a.id) || str(a.spreadsheet_id),
      range: str(a.query) || str(a.range) || 'A1:Z1000',
    }),
  },
  drive_share: {
    tool: 'drive_share',
    need: ['id', 'attendees'],
    hint: 'Share a file/Doc/Sheet. Set id and attendees as the email. Optional query as role: reader, writer, commenter.',
    map: (a) => {
      const asked = (str(a.query) || str(a.file_types) || 'writer').toLowerCase();
      const role = ['reader', 'writer', 'commenter', 'owner'].includes(asked) ? asked : 'writer';
      return {
        file_id: str(a.id) || str(a.file_id) || str(a.spreadsheet_id) || str(a.document_id),
        email: str(a.attendees) || str(a.email),
        role,
      };
    },
  },
};

export const ACTION_NAMES = Object.keys(KNOWN_ACTIONS);

function actionGuide() {
  return ACTION_NAMES.map((name) => `${name} — ${KNOWN_ACTIONS[name].hint}`).join('\n');
}

export function workspaceActionTool() {
  return {
    type: 'function',
    function: {
      name: WORKSPACE_TOOL_NAME,
      description: `Google Workspace. Call exactly once with one known action. Do not invent tool names or IDs.

${actionGuide()}

If you lack an id, list or search first. Never guess file, mail, or event ids. Never send or trash Gmail. Calendar delete and Sheets/Docs edits are allowed. After create or edit, a card with the Google link appears on the user's screen — mention that, do not read the full URL aloud.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ACTION_NAMES,
            description: 'The single known action to run.',
          },
          query: { type: 'string', description: 'Search query, Gmail query, Sheets A1 range, or Drive share role (reader/writer/commenter).' },
          id: { type: 'string', description: 'Message, thread, event, file, doc, sheet, or folder id from a prior result.' },
          title: { type: 'string', description: 'Title for create or calendar update.' },
          values: { type: 'string', description: 'Sheet rows as JSON [["Name","Age"],["Ada","30"]] or TSV/CSV lines.' },
          start_time: { type: 'string', description: 'Event start ISO 8601.' },
          end_time: { type: 'string', description: 'Event end ISO 8601.' },
          description: { type: 'string', description: 'Event notes, Doc body/append text, or sheet TSV if values is empty.' },
          location: { type: 'string' },
          attendees: { type: 'string', description: 'Comma-separated emails, or one email to share a file with.' },
          timezone: { type: 'string' },
          max_results: { type: 'integer' },
          file_types: { type: 'string', description: 'document,spreadsheet,pdf,folder,image' },
          time_min: { type: 'string' },
          time_max: { type: 'string' },
        },
        required: ['action'],
      },
    },
  };
}

export function isWorkspaceTool(name) {
  return name === WORKSPACE_TOOL_NAME;
}

/**
 * @param {{ callTool: (name: string, args: Record<string, unknown>) => Promise<{ text?: string, isError?: boolean }> }} hub
 * @param {Record<string, unknown>} args
 */
export async function runKnownAction(hub, args = {}) {
  const action = String(args.action || '').trim();
  const spec = KNOWN_ACTIONS[action];
  if (!spec) {
    return JSON.stringify({
      error: `Unknown action "${action}". Use one of: ${ACTION_NAMES.join(', ')}`,
    });
  }

  const missing = missingNeeds(spec.need || [], args);
  if (missing.length) {
    return JSON.stringify({ error: `Need ${missing.join(', ')}. ${spec.hint}` });
  }

  const mapped = spec.map(args);
  const toolName = mapped._tool ? `gws__${mapped._tool}` : `gws__${spec.tool}`;
  const resolveSheet = Boolean(mapped._resolveSheet);
  const { _tool, _resolveSheet, ...mcpArgs } = mapped;

  const clean = Object.fromEntries(
    Object.entries(mcpArgs).filter(([, v]) => v !== undefined && v !== ''),
  );
  if (resolveSheet && !clean.range) clean.range = 'A1:Z20';

  console.log(`[workspace] ${action} → ${toolName}`, logShape(clean));
  let result = await hub.callTool(toolName, clean);

  if (resolveSheet && toolFailed(result) && str(clean.spreadsheet_id)) {
    try {
      const meta = await hub.callTool('gws__sheets_get_metadata', {
        spreadsheet_id: clean.spreadsheet_id,
      });
      const title = firstSheetTitle(meta.text);
      if (title) {
        const retry = { ...clean, range: a1Range(title) };
        console.log(`[workspace] ${action} → ${toolName} first-tab retry`);
        result = await hub.callTool(toolName, retry);
      }
    } catch {
      /* keep first result */
    }
  }

  return decorateResult(action, args, result.text || JSON.stringify(result));
}

function googleUrlFromIds(parsed, args = {}) {
  const sheetId = str(parsed?.spreadsheet_id) || (String(args.action || '').startsWith('sheets_') ? str(args.id) || str(args.spreadsheet_id) : undefined);
  const docId = str(parsed?.document_id) || (String(args.action || '').startsWith('docs_') ? str(args.id) || str(args.document_id) : undefined);
  const fileId = str(parsed?.file_id) || str(args.file_id);
  if (sheetId) return `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
  if (docId) return `https://docs.google.com/document/d/${docId}/edit`;
  if (fileId) return `https://drive.google.com/file/d/${fileId}/view`;
  return undefined;
}

function kindFromAction(action) {
  if (String(action).startsWith('calendar_')) return 'calendar';
  if (String(action).startsWith('docs_')) return 'doc';
  if (String(action).startsWith('sheets_')) return 'sheet';
  return 'drive';
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} args
 * @param {string} text
 * @returns {{ kind: string, title: string, url: string, id?: string } | null}
 */
export function extractWorkspaceArtifact(action, args = {}, text = '') {
  if (!ARTIFACT_ACTIONS.has(action)) return null;
  const parsed = parseJsonish(text);
  if (parsed && parsed.success === false) return null;
  const url =
    str(parsed?.open_url) ||
    str(parsed?.spreadsheet_url) ||
    str(parsed?.document_url) ||
    str(parsed?.html_link) ||
    str(parsed?.web_link) ||
    str(parsed?.webViewLink) ||
    googleUrlFromIds(parsed, { ...args, action }) ||
    str(String(text).match(/https:\/\/(?:www\.)?(?:docs|drive|calendar)\.google\.com[^\s"'<>]+/i)?.[0]);
  if (!url) return null;
  const id =
    str(parsed?.spreadsheet_id) ||
    str(parsed?.document_id) ||
    str(parsed?.event_id) ||
    str(parsed?.file_id) ||
    str(args.id);
  const title =
    str(parsed?.title) ||
    str(parsed?.summary) ||
    str(parsed?.name) ||
    str(args.title) ||
    (kindFromAction(action) === 'sheet' ? 'Google Sheet' : kindFromAction(action) === 'doc' ? 'Google Doc' : kindFromAction(action) === 'calendar' ? 'Calendar event' : 'Google file');
  return { kind: kindFromAction(action), title, url, id };
}

function decorateResult(action, args, text) {
  const artifact = extractWorkspaceArtifact(action, args, text);
  if (!artifact) return text;
  const parsed = parseJsonish(text);
  if (parsed && typeof parsed === 'object') {
    parsed.open_url = artifact.url;
    parsed.on_screen = true;
    return JSON.stringify(parsed);
  }
  return JSON.stringify({ result: text, open_url: artifact.url, on_screen: true });
}
