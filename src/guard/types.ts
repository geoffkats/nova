export type GuardSeverity = 'good' | 'review' | 'high';

export type GuardFinding = {
  id: string;
  severity: GuardSeverity;
  title: string;
  detail: string;
  file?: string;
};

export type LocalGuardSnapshot = {
  createdAt: string;
  hostname: string;
  platform: string;
  scope: string;
  dataHandling: string;
  supported: boolean;
  findings: GuardFinding[];
  listeners: Array<{ address: string; port: number; pid: number; exposure: string }>;
};

export type RepositoryScan = {
  canceled: boolean;
  scanId?: string;
  repository?: string;
  scannedAt?: string;
  filesScanned?: number;
  sourceFilesScanned?: number;
  dependencyCount?: number;
  dependencySource?: string;
  findings?: GuardFinding[];
  warnings?: string[];
};

export type Advisory = {
  id: string;
  aliases: string[];
  package: string;
  installedVersion: string;
  summary: string;
  severity: 'critical' | 'high' | 'moderate' | 'unspecified';
  score: number | null;
  fixedVersions: string[];
  references: string[];
  hackerNews: Array<{ title: string; url: string; points: number; createdAt: string | null }>;
};

export type AdvisoryReport = {
  scannedPackages: number;
  advisories: Advisory[];
  hackerNewsChecked: number;
  notes: string[];
};

export type WebsiteReport = {
  hostname: string;
  scannedAt: string;
  status: number;
  method: 'HEAD';
  redirects: number;
  scope: string;
  findings: GuardFinding[];
};
