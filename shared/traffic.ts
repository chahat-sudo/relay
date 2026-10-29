export type Result<T, E = { kind: 'invalid'; message: string }> = { ok: true; value: T } | { ok: false; error: E };
export type VerificationStatus = 'verified' | 'unverified' | 'unknown';
export type Risk = 'low' | 'medium' | 'high' | 'unknown';
export type CollectionState = 'not-requested' | 'pending' | 'complete' | 'partial' | 'expired' | 'failed';
export type TrafficAction = 'allow' | 'throttle' | 'challenge' | 'deny';
export interface BrowserFacts {
  version: 1;
  webdriver: boolean | null;
  language: string | null;
  timezone: string | null;
  platform: string | null;
  viewport: { width: number; height: number } | null;
  cookiesEnabled: boolean | null;
  elapsedMs: number | null;
  errors: string[];
}
export interface TrafficConfig {
  mode: 'off' | 'observe' | 'enforce';
  collectBrowser: boolean;
  ownedOrigins: string[];
  networks: { cidr: string; kind: 'deny' | 'hosting' | 'proxy'; note: string }[];
  requestsPerMinute: number;
  highRiskAction: TrafficAction;
  enforcementApproved: boolean;
  retentionDays: number;
  rawIpDays: number;
}
export const defaultTrafficConfig: TrafficConfig = {
  mode: 'off', collectBrowser: false, ownedOrigins: [], networks: [], requestsPerMinute: 120,
  highRiskAction: 'throttle', enforcementApproved: false, retentionDays: 30, rawIpDays: 7,
};
export interface RequestFacts {
  requestTarget: string;
  ip: string | null;
  sourceIp: string | null;
  authority: 'socket' | 'cloudflare-signed';
  userAgent: string;
  accept: string | null;
  language: string | null;
  platformHint: string | null;
  edge: { verifiedBot: boolean | null; score: number | null; category: string | null; ja4: string | null };
}
export interface IdentityEvidence {
  claimedProvider: 'google' | 'meta' | null;
  status: VerificationStatus;
  method: 'official-ip-feed' | 'forward-confirmed-dns' | 'none';
  scope: string | null;
  reason: string;
  checkedAt: string;
  source: string | null;
  revision: string | null;
  match: string | null;
  checks: { method: 'official-ip-feed' | 'forward-confirmed-dns'; outcome: 'matched' | 'not-matched' | 'unavailable' | 'partial'; reason: string; source: string; revision: string | null; match: string | null; checkedAt: string; coverage: { examined: number; total: number } | null }[];
}
export interface Assessment {
  version: 'rules-1';
  identity: IdentityEvidence;
  automation: 'suspected' | 'not-established' | 'unknown';
  risk: Risk;
  score: number | null;
  scoreKind: 'heuristic';
  reasons: string[];
  coverage: string[];
  recommendedAction: TrafficAction;
  assessedAt: string;
}
export interface TrafficRecord {
  id: string; campaignId: string; campaignName: string; clickId: string | null;
  source: string; externalId: string; createdAt: string; destinationUrl: string | null;
  actualAction: TrafficAction; mode: TrafficConfig['mode']; estimatedCost: number;
  policyVersion: string;
  context: RequestFacts; collection: CollectionState; assessment: Assessment;
}
export interface TrafficPage { items: TrafficRecord[]; total: number; nextOffset: number | null; }
export interface TrafficSummary {
  total: number; qualifying: number; excluded: number; unknown: number; verifiedCrawlers: number;
  highRisk: number; collected: number; requested: number; estimatedCost: number;
  wouldAct: number; actualRestricted: number;
}
export interface IntelligenceStatus {
  service: string; source: string; fetchedAt: string | null; expiresAt: string | null;
  revision: string | null; ranges: number; fresh: boolean; failure: string | null;
}
export interface TrafficStatus {
  config: TrafficConfig; intelligence: IntelligenceStatus[];
  publicIngress: { configured: boolean; audience: string | null };
  model: { state: 'not-trained'; reason: string };
}
export const trafficOperations = ['traffic.status', 'traffic.config', 'traffic.history', 'traffic.requests', 'traffic.detail', 'traffic.summary', 'traffic.refresh', 'traffic.labels', 'traffic.simulate', 'traffic.maintenance', 'traffic.model'] as const;
export type TrafficOperation = typeof trafficOperations[number];
