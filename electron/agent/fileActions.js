/**
 * Closed local-files catalog.
 *
 * Node fs only, inside Desktop / Documents / Downloads (plus optional
 * NOVA_FILES_ROOTS). The model sees one tool and known actions — never
 * raw filesystem MCP, never a shell.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const FILES_TOOL_NAME = 'local_files';

const MAX_LIST = 40;
const MAX_SEARCH = 30;
const MAX_ORGANIZE = 40;
const MAX_WALK = 4;
const MAX_READ = 24_000;
const MAX_WRITE = 80_000;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'appdata',
  'windows',
  '$recycle.bin',
  'system volume information',
]);

const BLOCKED_NAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  'token.json',
  'credentials.json',
  'id_rsa',
  'id_rsa.pub',
  '.npmrc',
  '.netrc',
  'secrets.json',
]);

const BLOCKED_WRITE_EXT = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.ps1',
  '.vbs',
  '.vbe',
  '.js',
  '.jse',
  '.wsf',
  '.wsh',
  '.msi',
  '.dll',
  '.scr',
  '.pif',
  '.lnk',
  '.reg',
]);

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.tsv',
  '.log',
  '.html',
  '.htm',
  '.css',
  '.xml',
  '.yaml',
  '.yml',
  '.ini',
  '.cfg',
  '.conf',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.sql',
  '.rtf',
]);

const ROOT_ALIASES = {
  desktop: 'Desktop',
  desk: 'Desktop',
  documents: 'Documents',
  document: 'Documents',
  docs: 'Documents',
  downloads: 'Downloads',
  download: 'Downloads',
};

const NEED_ALIASES = {
  path: ['path', 'id', 'folder', 'dir', 'source', 'from'],
  dest: ['dest', 'destination', 'to', 'target'],
  query: ['query', 'filter', 'pattern', 'glob'],
  title: ['title', 'name', 'filename'],
  description: ['description', 'content', 'text', 'body', 'values'],
};

const ARTIFACT_ACTIONS = new Set(['mkdir', 'write', 'move', 'copy', 'organize']);

const WIN_RESERVED = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'lpt1']);

function str(v) {
  const s = String(v ?? '').trim();
  return s || undefined;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function pick(args, key) {
  for (const k of NEED_ALIASES[key] || [key]) {
    const v = str(args[k]);
    if (v) return v;
  }
}

function missingNeeds(need, args) {
  return need.filter((key) => !pick(args, key));
}

function norm(p) {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

function isInside(root, target) {
  const r = norm(root).toLowerCase();
  const t = norm(target).toLowerCase();
  return t === r || t.startsWith(`${r}/`);
}

function isBlockedName(name) {
  return BLOCKED_NAMES.has(String(name || '').toLowerCase());
}

function isBlockedPath(abs) {
  const n = norm(abs).toLowerCase();
  if (/(^|\/)(windows|program files(?: \(x86\))?|system32)(\/|$)/i.test(n)) return true;
  const base = path.basename(abs);
  if (isBlockedName(base)) return true;
  const stem = base.replace(/\.[^.]+$/, '').toLowerCase();
  if (WIN_RESERVED.has(stem)) return true;
  return false;
}

function uniqueExisting(candidates) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of candidates) {
    if (!raw || !existsSync(raw)) continue;
    let real;
    try {
      real = realpathSync.native(raw);
    } catch {
      continue;
    }
    const key = norm(real).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

function extraRoots() {
  return (process.env.NOVA_FILES_ROOTS || '')
    .split(/[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Named allowlist. Desktop/Documents/Downloads, plus OneDrive copies, plus env extras.
 * @returns {{ Desktop?: string, Documents?: string, Downloads?: string, extra: string[] }}
 */
export function fileRoots() {
  const home = os.homedir();
  const named = {
    Desktop: uniqueExisting([path.join(home, 'Desktop'), path.join(home, 'OneDrive', 'Desktop')])[0],
    Documents: uniqueExisting([
      path.join(home, 'Documents'),
      path.join(home, 'OneDrive', 'Documents'),
    ])[0],
    Downloads: uniqueExisting([
      path.join(home, 'Downloads'),
      path.join(home, 'OneDrive', 'Downloads'),
    ])[0],
  };
  const extra = uniqueExisting(extraRoots()).filter(
    (p) => !Object.values(named).some((n) => n && isInside(n, p) && norm(n) === norm(p)),
  );
  return { ...named, extra };
}

export function allowedRootList() {
  const roots = fileRoots();
  return ['Desktop', 'Documents', 'Downloads']
    .map((name) => roots[name])
    .filter(Boolean)
    .concat(roots.extra);
}

function rootByName(name) {
  const roots = fileRoots();
  return roots[name];
}

function confine(target, { mustExist = false } = {}) {
  if (!target) return { error: 'Need path. Use Desktop, Documents, Downloads, or a path under those.' };
  let abs = path.resolve(target);
  try {
    if (existsSync(abs)) {
      abs = realpathSync.native(abs);
    } else {
      const parent = path.dirname(abs);
      const base = path.basename(abs);
      if (existsSync(parent)) abs = path.join(realpathSync.native(parent), base);
    }
  } catch {
    return { error: 'Could not resolve that path.' };
  }

  const roots = allowedRootList();
  if (!roots.length) return { error: 'No allowed folders found (Desktop, Documents, Downloads).' };
  if (!roots.some((r) => isInside(r, abs))) {
    return { error: 'Path is outside allowed folders (Desktop, Documents, Downloads).' };
  }
  if (isBlockedPath(abs)) return { error: 'That path is blocked.' };
  if (mustExist && !existsSync(abs)) return { error: `Not found: ${toRel(abs)}` };
  return { path: abs };
}

export function isAllowedAbsPath(raw) {
  const got = confine(raw, { mustExist: true });
  return Boolean(got.path);
}

export function isAllowedFileUrl(raw) {
  try {
    const u = new URL(String(raw || ''));
    if (u.protocol !== 'file:') return false;
    return isAllowedAbsPath(fileURLToPath(u));
  } catch {
    return false;
  }
}

function toRel(abs) {
  const roots = fileRoots();
  for (const name of ['Desktop', 'Documents', 'Downloads']) {
    const root = roots[name];
    if (!root || !isInside(root, abs)) continue;
    const rest = path.relative(root, abs);
    return !rest || rest === '.' ? name : `${name}/${rest.replace(/\\/g, '/')}`;
  }
  for (const root of roots.extra) {
    if (!isInside(root, abs)) continue;
    const rest = path.relative(root, abs);
    return !rest || rest === '.' ? path.basename(root) : `${path.basename(root)}/${rest.replace(/\\/g, '/')}`;
  }
  return abs;
}

function fileUrl(abs) {
  return pathToFileURL(abs).href;
}

/**
 * Voice-friendly paths: "Desktop", "Desktop/Invoices", or an absolute path under a root.
 */
function resolveDest(srcPath, destRaw) {
  const slashy = destRaw.replace(/\\/g, '/');
  const first = slashy.split('/').filter(Boolean)[0]?.toLowerCase();
  if (path.isAbsolute(destRaw) || ROOT_ALIASES[destRaw.toLowerCase()] || ROOT_ALIASES[first]) {
    return resolveUserPath(destRaw);
  }
  return confine(path.join(path.dirname(srcPath), destRaw));
}

function resolveUserPath(raw, opts = {}) {
  const input = str(raw);
  if (!input) {
    const desktop = rootByName('Desktop');
    return desktop ? { path: desktop } : { error: 'Desktop folder not found.' };
  }

  const slashy = input.replace(/\\/g, '/');
  const lower = slashy.toLowerCase();
  const alias = ROOT_ALIASES[lower];
  if (alias) {
    const root = rootByName(alias);
    return root ? { path: root } : { error: `${alias} folder not found.` };
  }

  const parts = slashy.split('/').filter(Boolean);
  const first = ROOT_ALIASES[parts[0].toLowerCase()];
  if (first) {
    const root = rootByName(first);
    if (!root) return { error: `${first} folder not found.` };
    return confine(path.join(root, ...parts.slice(1)), opts);
  }

  if (path.isAbsolute(input)) return confine(input, opts);

  for (const root of allowedRootList()) {
    const candidate = path.join(root, input);
    if (existsSync(candidate) || !opts.mustExist) {
      const got = confine(candidate, opts);
      if (!got.error && (!opts.mustExist || existsSync(got.path))) return got;
    }
  }
  const desktop = rootByName('Desktop');
  return desktop ? confine(path.join(desktop, input), opts) : { error: 'Could not resolve path.' };
}

function skipDir(name) {
  return SKIP_DIRS.has(String(name || '').toLowerCase()) || String(name || '').startsWith('.');
}

function matchesQuery(name, query) {
  const q = str(query);
  if (!q) return true;
  const n = name.toLowerCase();
  const raw = q.toLowerCase().replace(/^\*\./, '.').replace(/^\*/, '');
  if (raw.startsWith('.')) return n.endsWith(raw);
  if (/^[a-z0-9]{1,8}$/i.test(raw) && !n.includes(raw) && n.endsWith(`.${raw}`)) return true;
  if (raw.includes(',')) {
    return raw.split(',').some((part) => matchesQuery(name, part.trim()));
  }
  return n.includes(raw);
}

async function listDir(abs, limit) {
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.isDirectory() && skipDir(e.name)) continue;
    if (isBlockedName(e.name)) continue;
    const full = path.join(abs, e.name);
    if (isBlockedPath(full)) continue;
    let type = e.isDirectory() ? 'folder' : e.isFile() ? 'file' : 'other';
    let size;
    try {
      if (e.isFile()) size = (await fs.stat(full)).size;
    } catch {
      /* skip stat */
    }
    out.push({ name: e.name, type, path: toRel(full), size });
    if (out.length >= limit) break;
  }
  return out;
}

async function walkFind(abs, query, depth, acc) {
  if (acc.length >= MAX_SEARCH || depth < 0) return;
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX_SEARCH) return;
    if (e.isDirectory() && skipDir(e.name)) continue;
    if (isBlockedName(e.name)) continue;
    const full = path.join(abs, e.name);
    if (isBlockedPath(full)) continue;
    if (matchesQuery(e.name, query)) {
      acc.push({
        name: e.name,
        type: e.isDirectory() ? 'folder' : 'file',
        path: toRel(full),
      });
    }
    if (e.isDirectory()) await walkFind(full, query, depth - 1, acc);
  }
}

function isTextFile(abs) {
  return TEXT_EXT.has(path.extname(abs).toLowerCase());
}

function refuseWriteExt(abs) {
  return BLOCKED_WRITE_EXT.has(path.extname(abs).toLowerCase());
}

async function ensureDir(abs) {
  await fs.mkdir(abs, { recursive: true });
}

async function runAction(action, args) {
  switch (action) {
    case 'list': {
      const target = resolveUserPath(pick(args, 'path') || 'Desktop', { mustExist: true });
      if (target.error) return target;
      const entries = await listDir(target.path, Math.min(num(args.max_results, MAX_LIST), MAX_LIST));
      return { ok: true, path: toRel(target.path), entries };
    }
    case 'search': {
      const query = pick(args, 'query');
      const target = resolveUserPath(pick(args, 'path') || 'Desktop', { mustExist: true });
      if (target.error) return target;
      const hits = [];
      await walkFind(target.path, query, MAX_WALK, hits);
      return { ok: true, path: toRel(target.path), query, matches: hits };
    }
    case 'info': {
      const target = resolveUserPath(pick(args, 'path'), { mustExist: true });
      if (target.error) return target;
      const st = await fs.stat(target.path);
      return {
        ok: true,
        path: toRel(target.path),
        type: st.isDirectory() ? 'folder' : 'file',
        size: st.size,
        modified: st.mtime.toISOString(),
      };
    }
    case 'read': {
      const target = resolveUserPath(pick(args, 'path'), { mustExist: true });
      if (target.error) return target;
      const st = await fs.stat(target.path);
      if (st.isDirectory()) {
        const entries = await listDir(target.path, MAX_LIST);
        return { ok: true, path: toRel(target.path), type: 'folder', entries };
      }
      if (!isTextFile(target.path)) {
        return {
          ok: true,
          path: toRel(target.path),
          type: 'file',
          size: st.size,
          note: 'Binary or unknown type — not reading contents.',
        };
      }
      if (st.size > MAX_READ * 4) {
        return { ok: false, error: 'File is too large to read aloud.' };
      }
      const buf = await fs.readFile(target.path, 'utf8');
      return { ok: true, path: toRel(target.path), text: buf.slice(0, MAX_READ) };
    }
    case 'mkdir': {
      const title = pick(args, 'title');
      const rawPath = pick(args, 'path');
      const parent = resolveUserPath(rawPath || 'Desktop', { mustExist: true });
      if (parent.error) return parent;
      const dest = title ? path.join(parent.path, title) : parent.path;
      const confined = confine(dest);
      if (confined.error) return confined;
      if (existsSync(confined.path)) {
        const st = statSync(confined.path);
        if (st.isDirectory()) {
          return { ok: true, path: toRel(confined.path), existed: true, type: 'folder' };
        }
        return { error: 'A file already uses that name.' };
      }
      await ensureDir(confined.path);
      return { ok: true, path: toRel(confined.path), type: 'folder', open_url: fileUrl(confined.path) };
    }
    case 'write': {
      const title = pick(args, 'title');
      const body = pick(args, 'description') ?? '';
      if (body.length > MAX_WRITE) return { error: `Content too long (max ${MAX_WRITE} characters).` };
      const base = resolveUserPath(pick(args, 'path') || 'Desktop');
      if (base.error) return base;
      let dest = base.path;
      if (existsSync(dest) && statSync(dest).isDirectory()) {
        if (!title) return { error: 'Need title as the filename, or a full file path.' };
        dest = path.join(dest, title);
      } else if (!path.extname(dest)) {
        if (!title) return { error: 'Need title as the filename, or a full file path.' };
        dest = path.join(dest, title);
      }
      const confined = confine(dest);
      if (confined.error) return confined;
      if (refuseWriteExt(confined.path)) return { error: 'That file type cannot be created.' };
      if (isBlockedName(path.basename(confined.path))) return { error: 'That filename is blocked.' };
      if (existsSync(confined.path) && statSync(confined.path).isDirectory()) {
        return { error: 'That path is a folder.' };
      }
      await ensureDir(path.dirname(confined.path));
      await fs.writeFile(confined.path, body, 'utf8');
      return {
        ok: true,
        path: toRel(confined.path),
        type: 'file',
        bytes: Buffer.byteLength(body, 'utf8'),
        open_url: fileUrl(confined.path),
      };
    }
    case 'move':
    case 'copy': {
      const src = resolveUserPath(pick(args, 'path'), { mustExist: true });
      if (src.error) return src;
      const destRaw = pick(args, 'dest') || pick(args, 'title');
      if (!destRaw) return { error: 'Need dest (or title as the new name).' };
      const destGot = resolveDest(src.path, destRaw);
      if (destGot.error) return destGot;
      let dest = destGot.path;
      if (existsSync(dest) && statSync(dest).isDirectory()) {
        const again = confine(path.join(dest, path.basename(src.path)));
        if (again.error) return again;
        dest = again.path;
      }
      if (isInside(src.path, dest) && dest !== src.path) {
        return { error: 'Cannot move a folder into itself.' };
      }
      if (existsSync(dest)) return { error: `Already exists: ${toRel(dest)}` };
      await ensureDir(path.dirname(dest));
      if (action === 'copy') await fs.cp(src.path, dest, { recursive: true });
      else await fs.rename(src.path, dest);
      return {
        ok: true,
        from: toRel(src.path),
        path: toRel(dest),
        type: existsSync(dest) && statSync(dest).isDirectory() ? 'folder' : 'file',
        open_url: fileUrl(dest),
      };
    }
    case 'organize': {
      const query = pick(args, 'query');
      const title = pick(args, 'title');
      const src = resolveUserPath(pick(args, 'path') || 'Desktop', { mustExist: true });
      if (src.error) return src;
      const st = await fs.stat(src.path);
      if (!st.isDirectory()) return { error: 'Organize needs a folder path.' };
      const dest = confine(path.join(src.path, title));
      if (dest.error) return dest;
      await ensureDir(dest.path);
      const entries = await fs.readdir(src.path, { withFileTypes: true });
      const moved = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (e.name === title) continue;
        if (!matchesQuery(e.name, query)) continue;
        if (isBlockedName(e.name)) continue;
        const from = path.join(src.path, e.name);
        const to = path.join(dest.path, e.name);
        if (isBlockedPath(from) || isBlockedPath(to)) continue;
        await fs.rename(from, to);
        moved.push(e.name);
        if (moved.length >= MAX_ORGANIZE) break;
      }
      return {
        ok: true,
        path: toRel(dest.path),
        type: 'folder',
        moved,
        count: moved.length,
        open_url: fileUrl(dest.path),
      };
    }
    default:
      return { error: `Unknown action "${action}".` };
  }
}

/** @type {Record<string, { need?: string[], hint: string }>} */
export const FILE_ACTIONS = {
  list: { hint: 'List a folder. Default Desktop. Optional path: Desktop, Documents, Downloads, or Desktop/Invoices.' },
  search: {
    need: ['query'],
    hint: 'Find files by name under a folder. Set query (name or extension like pdf). Optional path.',
  },
  info: { need: ['path'], hint: 'Metadata for one file or folder. Set path.' },
  read: { need: ['path'], hint: 'Read a text file, or list a folder. Set path from list/search.' },
  mkdir: { need: ['title'], hint: 'Create a folder. Set title. Optional path (default Desktop).' },
  write: {
    hint: 'Write a text file. Set title as filename, description as contents. Optional path (default Desktop). Or set path to Desktop/name.txt.',
  },
  move: { need: ['path'], hint: 'Move or rename. Set path, and dest or title as the new location/name.' },
  copy: { need: ['path'], hint: 'Copy a file or folder. Set path and dest.' },
  organize: {
    need: ['title', 'query'],
    hint: 'Make a folder and move matching files into it. Set title as folder name, query as filter (pdf, invoice). Optional path (default Desktop).',
  },
};

export const FILE_ACTION_NAMES = Object.keys(FILE_ACTIONS);

function shortGuide() {
  return [
    'list — folder listing. Default Desktop.',
    'search — find by name or extension. Need query.',
    'info — metadata. Need path.',
    'read — text file or list folder. Need path.',
    'mkdir — create folder. Need title.',
    'write — text file. Need title or Desktop/name.txt. description is contents.',
    'move — rename or move. Need path and dest or title.',
    'copy — copy. Need path and dest.',
    'organize — new folder + move matches. Need title and query (pdf, invoice).',
  ].join('\n');
}

export function fileActionTool() {
  return {
    type: 'function',
    function: {
      name: FILES_TOOL_NAME,
      description: `Local files. One known action. Only Desktop, Documents, Downloads. Never delete.

${shortGuide()}

A card appears after create or move.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: FILE_ACTION_NAMES,
            description: 'The single known action to run.',
          },
          path: { type: 'string', description: 'File or folder. Desktop, Documents, Downloads, or Desktop/Name.' },
          dest: { type: 'string', description: 'Destination path or folder for move/copy.' },
          query: { type: 'string', description: 'Search text, filename fragment, or extension (pdf, *.jpg).' },
          title: { type: 'string', description: 'New folder or file name.' },
          description: { type: 'string', description: 'Text file contents for write.' },
          max_results: { type: 'integer' },
        },
        required: ['action'],
      },
    },
  };
}

export function isFileTool(name) {
  return name === FILES_TOOL_NAME;
}

export async function runFileAction(args = {}) {
  const action = String(args.action || '').trim();
  const spec = FILE_ACTIONS[action];
  if (!spec) {
    return JSON.stringify({
      error: `Unknown action "${action}". Use one of: ${FILE_ACTION_NAMES.join(', ')}`,
    });
  }
  const missing = missingNeeds(spec.need || [], args);
  if (missing.length) {
    return JSON.stringify({ error: `Need ${missing.join(', ')}. ${spec.hint}` });
  }
  console.log(`[files] ${action}`, pick(args, 'path') || pick(args, 'title') || '');
  try {
    const result = await runAction(action, args);
    return decorateResult(action, args, result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[files]', action, message);
    return JSON.stringify({ error: message });
  }
}

/**
 * @param {string} action
 * @param {Record<string, unknown>} args
 * @param {string} text
 * @returns {{ kind: string, title: string, url: string, id?: string } | null}
 */
export function extractFileArtifact(action, args = {}, text = '') {
  if (!ARTIFACT_ACTIONS.has(action)) return null;
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch {
    return null;
  }
  if (!parsed || parsed.ok === false || parsed.error) return null;
  const url = str(parsed.open_url);
  if (!url || !isAllowedFileUrl(url)) return null;
  let abs;
  try {
    abs = fileURLToPath(url);
  } catch {
    return null;
  }
  const kind = parsed.type === 'folder' || (existsSync(abs) && statSync(abs).isDirectory()) ? 'folder' : 'file';
  const title = str(parsed.path) || pick(args, 'title') || path.basename(abs);
  return { kind, title, url, id: str(parsed.path) };
}

function decorateResult(action, args, result) {
  const text = JSON.stringify(result);
  const artifact = extractFileArtifact(action, args, text);
  if (!artifact) return text;
  const parsed = { ...result, open_url: artifact.url, on_screen: true };
  return JSON.stringify(parsed);
}
