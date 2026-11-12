import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', 'vendor', 'target', '.venv', 'venv']);
const SOURCE_EXTS = new Set(['.js', '.jsx', '.cjs', '.mjs', '.ts', '.tsx', '.py', '.go', '.java', '.php', '.rb', '.cs', '.vue', '.svelte']);
const MAX_FILES = 6000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 28_000_000;
const SECRET_PATTERNS = [
  { id: 'private-key', title: 'Private key material in the repository', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { id: 'aws-key', title: 'AWS access key pattern in the repository', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', title: 'GitHub token pattern in the repository', re: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { id: 'slack-token', title: 'Slack token pattern in the repository', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];

function packageNameFromLockPath(path) {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index < 0) return '';
  return path.slice(index + marker.length);
}

function lockPackages(lock) {
  const found = new Map();
  if (lock.packages && typeof lock.packages === 'object') {
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || !entry?.version) continue;
      const name = entry.name || packageNameFromLockPath(path);
      if (name && !name.startsWith('.')) found.set(`${name}\0${entry.version}`, { name, version: String(entry.version), ecosystem: 'npm' });
    }
  } else {
    const visit = (items = {}) => {
      for (const [name, entry] of Object.entries(items)) {
        if (entry?.version) found.set(`${name}\0${entry.version}`, { name, version: String(entry.version), ecosystem: 'npm' });
        visit(entry?.dependencies);
      }
    };
    visit(lock.dependencies);
  }
  return [...found.values()];
}

function pinnedManifestPackages(manifest) {
  const found = new Map();
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, spec] of Object.entries(manifest?.[section] ?? {})) {
      const version = String(spec).replace(/^=/, '');
      if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
        found.set(`${name}\0${version}`, { name, version: version.replace(/^v/, ''), ecosystem: 'npm' });
      }
    }
  }
  return [...found.values()];
}

function finding(id, severity, title, detail, file = '') {
  return { id, severity, title, detail, ...(file ? { file } : {}) };
}

export async function scanRepository(rootPath) {
  const root = resolve(rootPath);
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error('Select a repository folder.');

  const files = [];
  let totalBytes = 0;
  const warnings = [];
  const textCache = new Map();
  async function walk(directory, depth) {
    if (depth > 12 || files.length >= MAX_FILES) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path, depth + 1);
      } else if (entry.isFile()) {
        files.push({ path });
      }
    }
  }
  await walk(root, 0);
  if (files.length >= MAX_FILES) warnings.push('Scan reached its file limit; some files were not inspected.');

  async function readText(file, maxBytes = MAX_FILE_BYTES) {
    if (textCache.has(file.path)) return textCache.get(file.path);
    try {
      const size = (await stat(file.path)).size;
      if (size > maxBytes || totalBytes + size > MAX_TOTAL_BYTES) {
        warnings.push('Scan reached a file size limit; some content was not inspected.');
        textCache.set(file.path, '');
        return '';
      }
      const content = await readFile(file.path, 'utf8');
      totalBytes += size;
      textCache.set(file.path, content);
      return content;
    } catch { return ''; }
  }

  const byName = new Map(files.map((file) => [relative(root, file.path).replaceAll('\\', '/'), file]));
  const findings = [];
  const manifestFile = byName.get('package.json');
  let manifest = null;
  if (manifestFile) {
    try { manifest = JSON.parse(await readText(manifestFile)); }
    catch { findings.push(finding('manifest-invalid', 'review', 'package.json could not be parsed', 'Correct the JSON before dependency checks.', 'package.json')); }
  }

  const lockFile = byName.get('package-lock.json') ?? byName.get('npm-shrinkwrap.json');
  let packages = [];
  let packageSource = 'none';
  if (lockFile) {
    try {
      const lock = JSON.parse(await readText(lockFile, 12_000_000));
      packages = lockPackages(lock);
      packageSource = relative(root, lockFile.path).replaceAll('\\', '/');
    } catch {
      findings.push(finding('lock-invalid', 'review', 'npm lockfile could not be parsed', 'Regenerate and commit a valid package lockfile.', relative(root, lockFile.path).replaceAll('\\', '/')));
    }
  } else if (manifest) {
    packages = pinnedManifestPackages(manifest);
    packageSource = 'pinned versions in package.json';
    if (packages.length) findings.push(finding('lock-missing', 'review', 'Dependency lockfile is missing', 'Add and commit package-lock.json so the scan can check resolved transitive packages.'));
  }
  packages = packages.slice(0, 5000);
  if (packages.length === 5000) warnings.push('Dependency inventory capped at 5,000 npm packages.');

  const gitignore = byName.get('.gitignore');
  const ignoreText = gitignore ? await readText(gitignore) : '';
  const envIgnored = /^\s*\/?\.env(?:\*|\.\*|\/|$)/m.test(ignoreText);
  if (!envIgnored) findings.push(finding('env-ignore-missing', 'review', '.env files are not clearly excluded by .gitignore', 'Add .env and .env.* to .gitignore while keeping an explicit .env.example template.'));

  const sourceFindings = new Map();
  let sourceFiles = 0;
  for (const file of files) {
    const rel = relative(root, file.path).replaceAll('\\', '/');
    const ext = extname(file.path).toLowerCase();
    const isSource = SOURCE_EXTS.has(ext);
    const isEnv = /^\.env(?:\.|$)/i.test(basename(file.path));
    if (!isSource && !isEnv) continue;
    sourceFiles += isSource ? 1 : 0;
    const content = await readText(file);
    if (!content || content.includes('\0')) continue;
    for (const rule of SECRET_PATTERNS) {
      if (rule.re.test(content)) sourceFindings.set(`${rule.id}:${rel}`, finding(rule.id, 'high', rule.title, 'A credential-like value was detected. The value is hidden; rotate it if it is real and remove it from repository history.', rel));
    }
    if (isSource) {
      if (/\b(?:child_process\.)?exec\s*\([^\n]*(?:\+\s*[A-Za-z_$]|\$\{)/.test(content)) {
        sourceFindings.set(`dynamic-shell:${rel}`, finding('dynamic-shell', 'review', 'Dynamically composed shell command', 'Review quoting and input validation around shell execution.', rel));
      }
      if (/\beval\s*\(/.test(content) || /new\s+Function\s*\(/.test(content)) {
        sourceFindings.set(`dynamic-code:${rel}`, finding('dynamic-code', 'review', 'Dynamic code execution primitive', 'Confirm untrusted input cannot reach eval or the Function constructor.', rel));
      }
      if (/\bdangerouslySetInnerHTML\b|\.innerHTML\s*=/.test(content)) {
        sourceFindings.set(`html-injection:${rel}`, finding('html-injection', 'review', 'Raw HTML insertion point', 'Review whether inserted HTML is sanitized and whether user controlled data can reach it.', rel));
      }
    }
  }
  findings.push(...sourceFindings.values());

  const trackedEnv = byName.has('.env') || files.some((file) => /^\.env\.(?!example$)/i.test(basename(file.path)));
  if (trackedEnv) findings.push(finding('env-present', 'review', 'Environment file exists in selected folder', 'Nova did not transmit file contents. Confirm this file is ignored and is not committed.'));

  const unsupportedManifests = ['requirements.txt', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'composer.json'].filter((name) => byName.has(name));
  if (unsupportedManifests.length) warnings.push(`Non-npm manifests detected but not yet queried for CVEs: ${unsupportedManifests.join(', ')}.`);
  if (!manifest && unsupportedManifests.length === 0) warnings.push('No supported npm manifest found. Current CVE lookup supports npm lockfiles and pinned npm package.json versions.');

  if (manifest && Object.keys(manifest.dependencies ?? {}).length > 0 && !lockFile && packages.length === 0) {
    warnings.push('package.json uses version ranges; exact installed versions cannot be checked until a lockfile is added.');
  }

  return {
    repository: basename(root),
    scannedAt: new Date().toISOString(),
    filesScanned: files.length,
    sourceFilesScanned: sourceFiles,
    dependencyCount: packages.length,
    dependencySource: packageSource,
    findings,
    warnings,
    packages,
  };
}
