import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const WINDOWS_AUDIT = String.raw`
$ErrorActionPreference = 'Stop'
$defender = $null
$firewall = $null
$listeners = @()
$firewallAvailable = $false
$listenersAvailable = $false
try {
  $d = Get-CimInstance -Namespace 'root/Microsoft/Windows/Defender' -ClassName 'MSFT_MpComputerStatus' -ErrorAction Stop
  $defender = [ordered]@{
    available = $true
    antivirusEnabled = [bool]$d.AntivirusEnabled
    realTimeProtectionEnabled = [bool]$d.RealTimeProtectionEnabled
    antispywareEnabled = [bool]$d.AntispywareEnabled
  }
} catch {
  $defender = [ordered]@{ available = $false; error = 'Windows Defender status is unavailable to this account.' }
}
try {
  $policy = New-Object -ComObject HNetCfg.FwPolicy2
  $firewall = @(
    [ordered]@{ name = 'Domain'; enabled = [bool]$policy.FirewallEnabled(1) }
    [ordered]@{ name = 'Private'; enabled = [bool]$policy.FirewallEnabled(2) }
    [ordered]@{ name = 'Public'; enabled = [bool]$policy.FirewallEnabled(4) }
  )
  $firewallAvailable = $true
} catch {
  $firewall = @()
}
try {
  $listeners = @(netstat.exe -ano -p tcp | ForEach-Object {
    if ($_ -match '^\s*TCP\s+(?<address>\[[^\]]+\]|[^:\s]+):(?<port>\d+)\s+\S+\s+LISTENING\s+(?<pid>\d+)\s*$') {
      [pscustomobject]@{ address = [string]$Matches.address.Trim('[', ']'); port = [int]$Matches.port; pid = [int]$Matches.pid }
    }
  } | Sort-Object address, port, pid -Unique)
  $listenersAvailable = $true
} catch { $listeners = @() }
[ordered]@{ defender = $defender; firewall = $firewall; firewallAvailable = $firewallAvailable; listeners = $listeners; listenersAvailable = $listenersAvailable } |
  ConvertTo-Json -Depth 5 -Compress
`;

function isPrivateAddress(address) {
  return address === '::1' || address === '127.0.0.1' || address.startsWith('10.') ||
    address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address) ||
    address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd');
}

function localAddresses() {
  return Object.values(os.networkInterfaces()).flatMap((entries = []) =>
    entries.filter((entry) => !entry.internal && isPrivateAddress(entry.address)).map((entry) => ({
      family: entry.family,
      address: entry.address,
    })),
  );
}

async function collectWindowsStatus() {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_AUDIT,
  ], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout.trim());
}

function evaluate(data) {
  const findings = [];
  if (data.defender?.available) {
    const protectedNow = data.defender.antivirusEnabled && data.defender.realTimeProtectionEnabled;
    findings.push({
      id: 'defender-realtime',
      severity: protectedNow ? 'good' : 'high',
      title: protectedNow ? 'Microsoft Defender real time protection is on' : 'Microsoft Defender protection needs review',
      detail: `Antivirus ${data.defender.antivirusEnabled ? 'on' : 'off'} · real time protection ${data.defender.realTimeProtectionEnabled ? 'on' : 'off'}`,
    });
  } else {
    findings.push({ id: 'defender-unavailable', severity: 'review', title: 'Defender status could not be verified', detail: data.defender?.error || 'Windows did not return Defender status.' });
  }

  if (data.firewallAvailable && Array.isArray(data.firewall) && data.firewall.length) {
    for (const profile of data.firewall) {
      findings.push({
        id: `firewall-${String(profile.name).toLowerCase()}`,
        severity: profile.enabled ? 'good' : 'high',
        title: `${profile.name} firewall ${profile.enabled ? 'is on' : 'is off'}`,
        detail: profile.enabled ? 'Windows Firewall reports this profile enabled.' : 'Review Windows Firewall settings for this network profile.',
      });
    }
  } else {
    findings.push({ id: 'firewall-unavailable', severity: 'review', title: 'Firewall status could not be verified', detail: 'Windows did not return firewall profile status.' });
  }

  if (!data.listenersAvailable) {
    findings.push({ id: 'listeners-unavailable', severity: 'review', title: 'Listening services could not be checked', detail: 'Windows did not return local TCP listener status.' });
    return findings;
  }

  const listeners = Array.isArray(data.listeners) ? data.listeners : [];
  const exposed = listeners.filter((item) => item.address === '0.0.0.0' || item.address === '::' || item.address === '*');
  findings.push({
    id: 'listening-ports',
    severity: exposed.length ? 'review' : 'good',
    title: `${listeners.length} local TCP service${listeners.length === 1 ? '' : 's'} listening`,
    detail: exposed.length
      ? `${exposed.length} listen on all local interfaces. Check whether each service is expected; a listening port alone does not mean it is vulnerable.`
      : 'No listeners bound to every local interface were reported.',
  });
  return findings;
}

export async function getLocalSecuritySnapshot() {
  const base = {
    createdAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    addresses: localAddresses(),
    scope: 'This computer only',
    dataHandling: 'Collected locally. Nothing is sent to Nova services or an external scanner.',
  };

  if (process.platform !== 'win32') {
    return { ...base, supported: false, findings: [{ id: 'unsupported', severity: 'review', title: 'Detailed checks are Windows only', detail: 'This first Nova Guard local audit currently reads Windows Defender, Firewall, and TCP listeners.' }], listeners: [] };
  }

  try {
    const status = await collectWindowsStatus();
    const listeners = Array.isArray(status.listeners) ? status.listeners : status.listeners ? [status.listeners] : [];
    return {
      ...base,
      supported: true,
      defender: status.defender,
      firewall: Array.isArray(status.firewall) ? status.firewall : status.firewall ? [status.firewall] : [],
      firewallAvailable: status.firewallAvailable === true,
      listenersAvailable: status.listenersAvailable === true,
      listeners: listeners.map(({ address, port, pid }) => ({
        address,
        port,
        pid,
        exposure: address === '0.0.0.0' || address === '::' || address === '*' ? 'all-interfaces' : 'local-interface',
      })),
      findings: evaluate(status),
    };
  } catch (error) {
    console.warn('[nova-guard] local audit failed:', JSON.stringify({
      code: error?.code ?? null,
      signal: error?.signal ?? null,
      killed: error?.killed ?? false,
      stderr: String(error?.stderr ?? '').trim().slice(-600),
      stdout: String(error?.stdout ?? '').trim().slice(-300),
      message: error instanceof Error ? error.message.split('\n')[0] : String(error).split('\n')[0],
    }));
    return {
      ...base,
      supported: true,
      findings: [{ id: 'audit-failed', severity: 'review', title: 'Local audit could not finish', detail: 'Nova could not read Windows security status. No system settings were changed.' }],
      listeners: [],
    };
  }
}
