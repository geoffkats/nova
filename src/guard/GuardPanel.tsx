import { useEffect, useState, type FormEvent } from 'react';
import type { Advisory, AdvisoryReport, GuardFinding, LocalGuardSnapshot, RepositoryScan, WebsiteReport } from './types';

type Tab = 'computer' | 'repository' | 'website';

function Findings({ items }: { items: GuardFinding[] }) {
  if (!items.length) return <p className="guard-panel__message">No findings in the checks that ran.</p>;
  return (
    <ul className="guard-panel__findings">
      {items.map((finding) => (
        <li className={`guard-panel__finding is-${finding.severity}`} key={`${finding.id}:${finding.file ?? ''}`}>
          <span className="guard-panel__dot" aria-hidden="true" />
          <div>
            <strong>{finding.title}</strong>
            {finding.file && <code className="guard-panel__file">{finding.file}</code>}
            <p>{finding.detail}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

function LocalPanel({ snapshot, loading, error, onRescan }: {
  snapshot: LocalGuardSnapshot | null;
  loading: boolean;
  error: string;
  onRescan: () => void;
}) {
  const needsReview = snapshot?.findings.filter((finding) => finding.severity !== 'good').length ?? 0;
  return (
    <>
      {loading && <p className="guard-panel__message" role="status">Checking Windows security status…</p>}
      {!loading && error && <p className="guard-panel__message is-error" role="alert">{error}</p>}
      {!loading && snapshot && <>
        <div className="guard-panel__summary">
          <span className={needsReview ? 'guard-panel__count is-review' : 'guard-panel__count is-good'}>
            {needsReview ? `${needsReview} checks need review` : 'No issues found in these checks'}
          </span>
          <span>{snapshot.hostname} · {snapshot.platform}</span>
        </div>
        <Findings items={snapshot.findings} />
        {snapshot.listeners.length > 0 && <details className="guard-panel__ports">
          <summary>Local listening services ({snapshot.listeners.length})</summary>
          <ul>{snapshot.listeners.slice(0, 40).map((listener) => (
            <li key={`${listener.address}:${listener.port}:${listener.pid}`}>
              <code>{listener.address}:{listener.port}</code>
              <span>PID {listener.pid} · {listener.exposure === 'all-interfaces' ? 'all interfaces' : 'local address'}</span>
            </li>
          ))}</ul>
          {snapshot.listeners.length > 40 && <p>Showing the first 40 services.</p>}
        </details>}
        <p className="guard-panel__privacy">{snapshot.dataHandling}</p>
        <p className="guard-panel__stamp">Updated {new Date(snapshot.createdAt).toLocaleTimeString()}</p>
      </>}
      <p className="guard-panel__scope-note">This checks this computer only. It does not scan a company network, change settings, or block traffic.</p>
      <div className="guard-panel__actions"><button type="button" onClick={onRescan} disabled={loading}>{loading ? 'Checking…' : 'Run check again'}</button></div>
    </>
  );
}

function AdvisoryCard({ advisory }: { advisory: Advisory }) {
  return (
    <article className={`guard-panel__advisory is-${advisory.severity}`}>
      <div className="guard-panel__advisory-head">
        <span className={`guard-panel__badge is-${advisory.severity}`}>{advisory.severity}{advisory.score ? ` · ${advisory.score}` : ''}</span>
        <strong>{advisory.package}@{advisory.installedVersion}</strong>
      </div>
      <p className="guard-panel__advisory-title">{advisory.summary}</p>
      <p className="guard-panel__ids">{advisory.id}{advisory.aliases.length ? ` · ${advisory.aliases.join(' · ')}` : ''}</p>
      {advisory.fixedVersions.length > 0 && <p className="guard-panel__fix"><b>Fixed versions in OSV:</b> {advisory.fixedVersions.join(', ')}. Check compatibility and update your lockfile.</p>}
      {advisory.fixedVersions.length === 0 && <p className="guard-panel__fix">No fixed version was listed by OSV. Review the upstream advisory before choosing a mitigation.</p>}
      {advisory.references.length > 0 && <div className="guard-panel__links">
        {advisory.references.slice(0, 3).map((url) => <a href={url} target="_blank" rel="noreferrer" key={url}>Advisory reference</a>)}
      </div>}
      <div className="guard-panel__hn">
        <b>Hacker News context</b>
        {advisory.hackerNews.length ? advisory.hackerNews.map((hit) => (
          <a href={hit.url} target="_blank" rel="noreferrer" key={hit.url}>{hit.title}<span>{hit.points} points</span></a>
        )) : <span>No matching HN story found. HN discussion is context, not proof of impact.</span>}
      </div>
    </article>
  );
}

function RepositoryPanel() {
  const [scan, setScan] = useState<RepositoryScan | null>(null);
  const [advisories, setAdvisories] = useState<AdvisoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [onlineConsent, setOnlineConsent] = useState(false);
  const [error, setError] = useState('');

  const chooseAndScan = async () => {
    setLoading(true); setError(''); setScan(null); setAdvisories(null); setOnlineConsent(false);
    try {
      const result = await window.avatarHost?.guardScanRepository?.();
      if (!result) throw new Error('Repository scanning is available in the Nova desktop app.');
      if (!result.canceled) setScan(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Nova could not scan that repository.'); }
    finally { setLoading(false); }
  };

  const checkOnline = async () => {
    if (!scan?.scanId || !onlineConsent) return;
    setOnlineLoading(true); setError('');
    try {
      const result = await window.avatarHost?.guardLookUpAdvisories?.({ scanId: scan.scanId, consent: true });
      if (!result) throw new Error('Online advisory lookup is unavailable.');
      setAdvisories(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The advisory lookup failed.'); }
    finally { setOnlineLoading(false); }
  };

  return <>
    <p className="guard-panel__intro">Choose a folder to inspect source and npm manifests locally. Nova does not install or run code from it.</p>
    <div className="guard-panel__actions"><button type="button" onClick={() => void chooseAndScan()} disabled={loading}>{loading ? 'Scanning repository…' : scan ? 'Choose another repository' : 'Choose repository folder'}</button></div>
    {loading && <p className="guard-panel__message" role="status">Reading repository files…</p>}
    {error && <p className="guard-panel__message is-error" role="alert">{error}</p>}
    {scan && <>
      <div className="guard-panel__summary">
        <span className="guard-panel__count">{scan.repository} · {scan.filesScanned} files · {scan.dependencyCount} npm packages</span>
        <span>{scan.sourceFilesScanned} source files inspected · {scan.dependencySource}</span>
      </div>
      <Findings items={scan.findings ?? []} />
      {(scan.warnings ?? []).map((warning) => <p className="guard-panel__warning" key={warning}>{warning}</p>)}
      <div className="guard-panel__consent">
        <label>
          <input type="checkbox" checked={onlineConsent} onChange={(event) => setOnlineConsent(event.target.checked)} />
          <span>Allow current advisory lookup: send npm package names and versions to OSV.dev; send matching CVE/advisory IDs and package names to Hacker News search. Repository source and file contents stay local.</span>
        </label>
        <button type="button" onClick={() => void checkOnline()} disabled={!onlineConsent || onlineLoading || !scan.scanId}>
          {onlineLoading ? 'Checking OSV and Hacker News…' : 'Check CVEs and Hacker News'}
        </button>
      </div>
      {advisories && <>
        <p className="guard-panel__summary-line">OSV checked {advisories.scannedPackages} exact npm versions · Hacker News queried {advisories.hackerNewsChecked} advisories.</p>
        {advisories.notes.map((note) => <p className="guard-panel__warning" key={note}>{note}</p>)}
        {advisories.advisories.length === 0
          ? <p className="guard-panel__message">OSV returned no advisories for the exact npm versions in this scan.</p>
          : <div className="guard-panel__advisories">{advisories.advisories.map((advisory) => <AdvisoryCard advisory={advisory} key={`${advisory.id}:${advisory.package}:${advisory.installedVersion}`} />)}</div>}
      </>}
    </>}
    <p className="guard-panel__scope-note">Static checks can miss issues and can produce false positives. CVE matches are dependency/version matches, not proof that vulnerable code is reachable.</p>
  </>;
}

function WebsitePanel() {
  const [url, setUrl] = useState('');
  const [authorized, setAuthorized] = useState(false);
  const [report, setReport] = useState<WebsiteReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    if (!authorized) return;
    setLoading(true); setError(''); setReport(null);
    try {
      const result = await window.avatarHost?.guardScanWebsite?.({ url, authorized: true });
      if (!result) throw new Error('Website inspection is available in the Nova desktop app.');
      setReport(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Nova could not inspect this site.'); }
    finally { setLoading(false); }
  };

  return <>
    <p className="guard-panel__intro">A passive HTTPS configuration check. It sends one HEAD request, follows up to two same-host HTTPS redirects, and does not log in, crawl pages, submit forms, or send test payloads.</p>
    <form className="guard-panel__site-form" onSubmit={(event) => void inspect(event)}>
      <label htmlFor="guard-site-url">Website you control</label>
      <input id="guard-site-url" type="url" placeholder="https://example.com" value={url} onChange={(event) => setUrl(event.target.value)} required />
      <label className="guard-panel__auth-check">
        <input type="checkbox" checked={authorized} onChange={(event) => setAuthorized(event.target.checked)} />
        <span>I own this website or have permission to assess it. I understand the host receives a single HTTPS HEAD request from this computer.</span>
      </label>
      <button type="submit" disabled={!authorized || loading}>{loading ? 'Checking HTTPS headers…' : 'Inspect site configuration'}</button>
    </form>
    {error && <p className="guard-panel__message is-error" role="alert">{error}</p>}
    {report && <>
      <div className="guard-panel__summary"><span className="guard-panel__count">{report.hostname} · HTTP {report.status}</span><span>Checked {new Date(report.scannedAt).toLocaleTimeString()} · {report.redirects} redirects</span></div>
      <Findings items={report.findings} />
      <p className="guard-panel__scope-note">{report.scope} Missing headers are hardening opportunities, not proof of an exploitable vulnerability.</p>
    </>}
  </>;
}

export function GuardPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('computer');
  const [snapshot, setSnapshot] = useState<LocalGuardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const scanComputer = async () => {
    setLoading(true); setError('');
    try {
      const result = await window.avatarHost?.guardSnapshot?.();
      if (!result) throw new Error('Local checks are available in the Nova desktop app.');
      setSnapshot(result);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Nova could not read local security status.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void scanComputer(); }, []);

  return (
    <div className="guard-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="guard-panel" role="dialog" aria-modal="true" aria-labelledby="guard-title">
        <header className="guard-panel__header">
          <div><span className="guard-panel__eyebrow">NOVA / DEFENSIVE SECURITY</span><h1 id="guard-title">Nova Guard</h1></div>
          <button className="guard-panel__close" type="button" onClick={onClose} aria-label="Close Nova Guard">×</button>
        </header>
        <div className="guard-panel__tabs" role="tablist" aria-label="Security assessment type">
          {([['computer', 'Computer'], ['repository', 'Repository'], ['website', 'Website']] as const).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
        {tab === 'computer' && <LocalPanel snapshot={snapshot} loading={loading} error={error} onRescan={() => void scanComputer()} />}
        {tab === 'repository' && <RepositoryPanel />}
        {tab === 'website' && <WebsitePanel />}
      </section>
    </div>
  );
}
