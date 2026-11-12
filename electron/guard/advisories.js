const OSV_BATCH_URL = 'https://api.osv.dev/v1/querybatch';
const OSV_VULN_URL = 'https://api.osv.dev/v1/vulns/';
const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const MAX_ADVISORIES = 120;
const MAX_HN_QUERIES = 20;

async function fetchJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(18000) });
  if (!response.ok) throw new Error(`Security advisory service returned HTTP ${response.status}.`);
  return response.json();
}

function cvssV3Score(vector) {
  if (!/^CVSS:3\.[01]\//.test(vector)) return 0;
  const values = Object.fromEntries(vector.split('/').slice(1).map((part) => part.split(':')));
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[values.AV];
  const AC = { L: 0.77, H: 0.44 }[values.AC];
  const scopeChanged = values.S === 'C';
  const PR = scopeChanged ? { N: 0.85, L: 0.68, H: 0.5 }[values.PR] : { N: 0.85, L: 0.62, H: 0.27 }[values.PR];
  const UI = { N: 0.85, R: 0.62 }[values.UI];
  const impacts = [values.C, values.I, values.A].map((value) => ({ N: 0, L: 0.22, H: 0.56 }[value]));
  if ([AV, AC, PR, UI, ...impacts].some((value) => value === undefined)) return 0;
  const isc = 1 - impacts.reduce((product, impact) => product * (1 - impact), 1);
  const impact = scopeChanged ? 7.52 * (isc - 0.029) - 3.25 * (isc - 0.02) ** 15 : 6.42 * isc;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * AV * AC * PR * UI;
  const raw = scopeChanged ? Math.min(1.08 * (impact + exploitability), 10) : Math.min(impact + exploitability, 10);
  return Math.ceil((raw - 1e-9) * 10) / 10;
}

function severityScore(vulnerability) {
  for (const entry of vulnerability.severity ?? []) {
    const match = String(entry.score ?? '').match(/^(\d(?:\.\d)?)$/);
    if (match) return Number(match[1]);
    const vectorScore = cvssV3Score(String(entry.score ?? ''));
    if (vectorScore) return vectorScore;
  }
  const label = String(vulnerability.database_specific?.severity ?? '').toUpperCase();
  if (label === 'CRITICAL') return 9.5;
  if (label === 'HIGH') return 8;
  if (label === 'MODERATE' || label === 'MEDIUM') return 5.5;
  if (label === 'LOW') return 2.5;
  return 0;
}

function fixedVersions(vulnerability, packageName) {
  const fixes = new Set();
  for (const affected of vulnerability.affected ?? []) {
    if (affected.package?.name !== packageName) continue;
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) if (event.fixed) fixes.add(String(event.fixed));
    }
  }
  return [...fixes];
}

function advisoryIds(vulnerability) {
  const cves = (vulnerability.aliases ?? []).filter((id) => /^CVE-\d{4}-\d{4,}$/i.test(id));
  return [...new Set([...cves, vulnerability.id].filter(Boolean))];
}

async function queryBatch(queries) {
  const output = [];
  for (let start = 0; start < queries.length; start += 1000) {
    const part = queries.slice(start, start + 1000);
    const data = await fetchJson(OSV_BATCH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ queries: part.map(({ package: pkg, version }) => ({ package: pkg, version })) }),
    });
    for (let i = 0; i < part.length; i += 1) {
      for (const vuln of data.results?.[i]?.vulns ?? []) {
        if (vuln.id) output.push({ id: String(vuln.id), query: part[i] });
      }
    }
  }
  return output;
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }));
  return output;
}

async function getHackerNewsResults(vulnerability, packageName) {
  const cve = advisoryIds(vulnerability).find((id) => id.startsWith('CVE-'));
  const query = cve || `${vulnerability.id} ${packageName}`;
  const url = new URL(HN_SEARCH_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('tags', 'story');
  url.searchParams.set('hitsPerPage', '4');
  const data = await fetchJson(url, { headers: { accept: 'application/json' } });
  return (data.hits ?? []).map((hit) => ({
    title: String(hit.title ?? hit.story_title ?? 'Hacker News discussion').slice(0, 240),
    url: /^https?:\/\//i.test(hit.url ?? '') ? hit.url : `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`,
    points: Number(hit.points) || 0,
    createdAt: hit.created_at ?? null,
  }));
}

export async function lookUpRepositoryAdvisories(packages) {
  if (!Array.isArray(packages) || packages.length === 0) return { scannedPackages: 0, advisories: [], hackerNewsChecked: 0, notes: ['No exact npm package versions were available for lookup.'] };

  const safePackages = packages.slice(0, 5000).filter((pkg) =>
    pkg?.ecosystem === 'npm' && typeof pkg.name === 'string' && pkg.name.length <= 214 &&
    typeof pkg.version === 'string' && /^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(pkg.version),
  );
  const queryItems = safePackages.map((pkg) => ({
    package: { ecosystem: 'npm', name: pkg.name },
    version: pkg.version,
    pkg,
  }));
  const matches = await queryBatch(queryItems);
  const unique = new Map();
  for (const match of matches) {
    const key = `${match.id}\0${match.query.pkg.name}\0${match.query.pkg.version}`;
    if (!unique.has(key)) unique.set(key, match);
  }
  const selected = [...unique.values()].slice(0, MAX_ADVISORIES);
  const details = await mapLimit(selected, 6, async (match) => {
    const vulnerability = await fetchJson(`${OSV_VULN_URL}${encodeURIComponent(match.id)}`);
    const score = severityScore(vulnerability);
    return {
      id: String(vulnerability.id ?? match.id),
      aliases: (vulnerability.aliases ?? []).filter((id) => /^CVE-|^GHSA-/i.test(id)).slice(0, 12),
      package: match.query.pkg.name,
      installedVersion: match.query.pkg.version,
      summary: String(vulnerability.summary ?? vulnerability.details ?? 'No summary supplied by the advisory source.').slice(0, 700),
      severity: score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'moderate' : 'unspecified',
      score: score || null,
      fixedVersions: fixedVersions(vulnerability, match.query.pkg.name).slice(0, 8),
      references: (vulnerability.references ?? []).map((item) => item.url).filter((url) => /^https:\/\//i.test(url ?? '')).slice(0, 8),
      hackerNews: [],
    };
  });

  const order = { critical: 0, high: 1, moderate: 2, unspecified: 3 };
  details.sort((a, b) => order[a.severity] - order[b.severity] || (b.score ?? 0) - (a.score ?? 0));
  const research = details.slice(0, MAX_HN_QUERIES);
  const hnResults = await mapLimit(research, 4, async (advisory) => {
    try { return await getHackerNewsResults(advisory, advisory.package); }
    catch { return []; }
  });
  for (let i = 0; i < research.length; i += 1) research[i].hackerNews = hnResults[i];

  const notes = [];
  if (safePackages.length < packages.length) notes.push('Only exact npm versions are sent to the advisory service; other ecosystems and non-pinned versions are skipped.');
  if (unique.size > MAX_ADVISORIES) notes.push(`Showing ${MAX_ADVISORIES} of ${unique.size} matched package advisories.`);
  if (details.length > MAX_HN_QUERIES) notes.push(`Hacker News was queried for the first ${MAX_HN_QUERIES} advisories only. HN posts are community discussion, not confirmation that a vulnerability affects this project.`);
  return { scannedPackages: safePackages.length, advisories: details, hackerNewsChecked: Math.min(details.length, MAX_HN_QUERIES), notes };
}
