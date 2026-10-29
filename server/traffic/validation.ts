import type { BrowserFacts, Result, TrafficConfig } from '../../shared/traffic.ts';
import { defaultTrafficConfig } from '../../shared/traffic.ts';
import { parseNetwork } from './ip.ts';

export function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function invalid<T>(message: string): Result<T> { return { ok: false, error: { kind: 'invalid', message } }; }
export function parseConfig(value: unknown, previous = defaultTrafficConfig): Result<TrafficConfig> {
  if (!record(value) || Object.keys(value).some(k => !Object.hasOwn(previous, k))) return invalid('Unknown traffic setting.');
  const c = { ...previous, ...value };
  if (!['off', 'observe', 'enforce'].includes(c.mode) || typeof c.collectBrowser !== 'boolean' || typeof c.enforcementApproved !== 'boolean') return invalid('Choose a valid detection mode and collection settings.');
  if (!['allow', 'throttle', 'challenge', 'deny'].includes(c.highRiskAction)) return invalid('Choose a supported high-risk action.');
  if (!Number.isInteger(c.requestsPerMinute) || c.requestsPerMinute < 10 || c.requestsPerMinute > 10000) return invalid('Rate window must be between 10 and 10000 requests per minute.');
  if (!Number.isInteger(c.retentionDays) || c.retentionDays < 1 || c.retentionDays > 365 || !Number.isInteger(c.rawIpDays) || c.rawIpDays < 0 || c.rawIpDays > c.retentionDays) return invalid('Choose 1–365 retention days and a shorter raw-IP lifetime.');
  if (!Array.isArray(c.ownedOrigins) || c.ownedOrigins.length > 20) return invalid('At most 20 owned landing origins are supported.');
  for (const origin of c.ownedOrigins) {
    if (typeof origin !== 'string' || origin.length > 300) return invalid('Invalid owned origin.');
    try { const u = new URL(origin); if (u.origin !== origin || u.username || u.password || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)))) return invalid('Use exact HTTPS origins; HTTP is allowed only on loopback.'); } catch { return invalid('Invalid owned origin.'); }
  }
  if (new Set(c.ownedOrigins).size !== c.ownedOrigins.length) return invalid('Owned origins must be unique.');
  if (!Array.isArray(c.networks) || c.networks.length > 1000) return invalid('At most 1000 local network rules are supported.');
  for (const n of c.networks) if (!record(n) || Object.keys(n).some(k => !['cidr', 'kind', 'note'].includes(k)) || !parseNetwork(n.cidr).ok || !['deny', 'hosting', 'proxy'].includes(String(n.kind)) || typeof n.note !== 'string' || n.note.length > 200) return invalid('Each network rule needs a CIDR, kind and short note.');
  if (c.mode === 'enforce' && !c.enforcementApproved) return invalid('Review observation evidence and explicitly approve enforcement first.');
  return { ok: true, value: c };
}
export function parseBrowser(value: unknown): Result<BrowserFacts> {
  if (!record(value) || value.version !== 1 || Object.keys(value).some(k => !['version', 'webdriver', 'language', 'timezone', 'platform', 'viewport', 'cookiesEnabled', 'elapsedMs', 'errors'].includes(k))) return invalid('Unsupported browser observation schema.');
  for (const k of ['webdriver', 'cookiesEnabled']) if (value[k] !== null && typeof value[k] !== 'boolean') return invalid(`Invalid ${k}.`);
  for (const k of ['language', 'timezone', 'platform']) if (value[k] !== null && (typeof value[k] !== 'string' || (value[k] as string).length > 100)) return invalid(`Invalid ${k}.`);
  if (value.viewport !== null && (!record(value.viewport) || Object.keys(value.viewport).some(k => k !== 'width' && k !== 'height') || !Number.isInteger(value.viewport.width) || !Number.isInteger(value.viewport.height) || Number(value.viewport.width) < 0 || Number(value.viewport.width) > 20000 || Number(value.viewport.height) < 0 || Number(value.viewport.height) > 20000)) return invalid('Invalid viewport.');
  if (value.elapsedMs !== null && (typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 600000)) return invalid('Invalid collector duration.');
  if (!Array.isArray(value.errors) || value.errors.length > 10 || value.errors.some(x => typeof x !== 'string' || x.length > 100)) return invalid('Invalid collector errors.');
  return { ok: true, value: value as unknown as BrowserFacts };
}
