import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

const IPV4_PRIVATE = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Subnet(address, network, prefix) {
  const ip = ipv4Number(address);
  const base = ipv4Number(network);
  if (ip === null || base === null) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ip & mask) === (base & mask);
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !IPV4_PRIVATE.some(([network, prefix]) => inV4Subnet(address, network, prefix));
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    if (net.isIP(mapped) === 4) return isPublicAddress(mapped);
  }
  return normalized !== '::' && normalized !== '::1' &&
    !normalized.startsWith('fc') && !normalized.startsWith('fd') &&
    !normalized.startsWith('fe8') && !normalized.startsWith('fe9') &&
    !normalized.startsWith('fea') && !normalized.startsWith('feb') &&
    !normalized.startsWith('ff') && !normalized.startsWith('2001:db8:');
}

async function resolvePublic(hostname) {
  if (hostname.toLowerCase() === 'localhost' || hostname.endsWith('.local')) throw new Error('Local hostnames are not eligible for remote site checks.');
  const literalFamily = net.isIP(hostname);
  const addresses = literalFamily ? [{ address: hostname, family: literalFamily }] : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new Error('The site did not resolve exclusively to public IP addresses, so Nova stopped the request.');
  }
  return addresses[0];
}

function parseHttpsUrl(raw, expectedHostname = '') {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('Enter a valid HTTPS site URL.');
  let url;
  try { url = new URL(raw.includes('://') ? raw : `https://${raw}`); }
  catch { throw new Error('Enter a valid HTTPS site URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Nova checks HTTPS websites on the standard port only. Credentials in URLs are not accepted.');
  }
  if (!url.hostname || url.hostname.includes('%')) throw new Error('Enter a public website hostname.');
  if (expectedHostname && url.hostname.toLowerCase() !== expectedHostname.toLowerCase()) {
    throw new Error('The site redirected to a different hostname. Add that hostname as a separate authorized target.');
  }
  return url;
}

function requestHead(url, address) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: url.hostname,
      port: 443,
      path: `${url.pathname || '/'}${url.search}`,
      method: 'HEAD',
      headers: { 'user-agent': 'NovaGuard/1.0 (authorized passive configuration check)', accept: '*/*' },
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      timeout: 9000,
    }, (response) => {
      const headers = response.headers;
      response.resume();
      resolve({ status: response.statusCode ?? 0, headers, location: response.headers.location ?? '' });
    });
    request.on('timeout', () => request.destroy(new Error('Site did not respond within 9 seconds.')));
    request.on('error', reject);
    request.end();
  });
}

function addHeaderFinding(findings, headers, name, title, detail) {
  const value = headers[name];
  findings.push({
    id: `header-${name}`,
    severity: value ? 'good' : 'review',
    title: value ? `${title} is present` : `${title} is missing`,
    detail: value ? String(value).slice(0, 220) : detail,
  });
}

export async function inspectWebsite(rawUrl, authorized) {
  if (authorized !== true) throw new Error('Confirm that you own or are authorized to assess this website.');
  const first = parseHttpsUrl(rawUrl);
  const findings = [{ id: 'https', severity: 'good', title: 'HTTPS is required', detail: 'Nova uses HTTPS and verifies the server certificate.' }];
  let url = first;
  let response;
  let redirectCount = 0;
  const expectedHost = first.hostname;
  while (true) {
    const resolved = await resolvePublic(url.hostname);
    response = await requestHead(url, resolved);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.location) break;
    if (redirectCount >= 2) throw new Error('The site redirected more than twice; Nova stopped following redirects.');
    url = parseHttpsUrl(new URL(response.location, url).toString(), expectedHost);
    redirectCount += 1;
  }

  const headers = response.headers;
  addHeaderFinding(findings, headers, 'strict-transport-security', 'HSTS', 'Enable Strict-Transport-Security after confirming all subdomains are HTTPS ready.');
  addHeaderFinding(findings, headers, 'content-security-policy', 'Content Security Policy', 'Add a policy matched to the site’s scripts, styles, and content sources.');
  addHeaderFinding(findings, headers, 'x-content-type-options', 'X-Content-Type-Options', 'Set X-Content-Type-Options: nosniff.');
  addHeaderFinding(findings, headers, 'referrer-policy', 'Referrer-Policy', 'Choose a policy such as strict-origin-when-cross-origin.');
  addHeaderFinding(findings, headers, 'permissions-policy', 'Permissions-Policy', 'Disable browser capabilities the site does not need.');
  if (headers['x-frame-options'] || /frame-ancestors/i.test(headers['content-security-policy'] ?? '')) {
    findings.push({ id: 'clickjacking', severity: 'good', title: 'Framing restriction is present', detail: 'X-Frame-Options or CSP frame-ancestors was found.' });
  } else {
    findings.push({ id: 'clickjacking', severity: 'review', title: 'No framing restriction was detected', detail: 'Set CSP frame-ancestors or X-Frame-Options if the site should not be embedded.' });
  }
  const server = String(headers.server ?? '');
  if (server && /\d/.test(server)) findings.push({ id: 'server-version', severity: 'review', title: 'Server banner includes a version', detail: server.slice(0, 180) });
  if (headers['x-powered-by']) findings.push({ id: 'powered-by', severity: 'review', title: 'X-Powered-By reveals implementation details', detail: String(headers['x-powered-by']).slice(0, 180) });

  return {
    hostname: expectedHost,
    scannedAt: new Date().toISOString(),
    status: response.status,
    method: 'HEAD',
    redirects: redirectCount,
    scope: 'HTTPS response headers only; no login, page crawling, payloads, or vulnerability probes.',
    findings,
  };
}
