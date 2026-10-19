import { randomInt } from 'node:crypto';
import type { Store } from './store.ts';
import type { Campaign, Rule, Device, Decision, Destination, CrawlerProvider, CrawlerRouting, TrafficDecision } from '../shared/types.ts';

export class Problem extends Error { status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Problem('Expected a JSON object.'); return value as Record<string, unknown>; }
export function text(value: unknown, label: string, max = 200, optional = false): string { if (optional && (value === undefined || value === null)) return ''; if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) throw new Problem(`${label} must be ${optional ? 'at most' : 'between 1 and'} ${max} characters.`); return value.trim(); }
export function number(value: unknown, label: string, max = 1000000): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Problem(`${label} must be a number from 0 to ${max}.`); return value; }
export function money(value: unknown, label: string) { const n = number(value, label); if (Math.abs(n * 100 - Math.round(n * 100)) > 0.00001) throw new Problem(`${label} supports two decimal places.`); return Math.round(n * 100); }
export function status(value: unknown) { if (value !== 'active' && value !== 'paused') throw new Problem('Status must be active or paused.'); return value; }
export function slug(value: unknown) { const s = text(value, 'URL alias', 80); if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) throw new Problem('Use lowercase letters, numbers and single hyphens for the URL alias.'); return s; }
export function webUrl(value: unknown) { const raw = text(value, 'Destination URL', 2048); let url; try { url = new URL(raw); } catch { throw new Problem('Enter a complete http:// or https:// URL.'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Problem('Use an HTTP(S) URL without embedded credentials.'); return url.toString(); }
export function deviceFrom(ua: string): Device { return /ipad|tablet/i.test(ua) ? 'tablet' : /mobile|android|iphone/i.test(ua) ? 'mobile' : 'desktop'; }
export function validateCrawlerRouting(value: unknown): CrawlerRouting {
  const r = object(value);
  if (typeof r.enabled !== 'boolean') throw new Problem('Choose whether crawler routing is enabled.');
  if (!Array.isArray(r.providers) || r.providers.some(p => p !== 'google' && p !== 'meta') || new Set(r.providers).size !== r.providers.length) throw new Problem('Choose Google, Meta, or both crawler groups.');
  if (r.enabled && !r.providers.length) throw new Problem('Select at least one crawler group.');
  const raw = text(r.url, 'Crawler destination URL', 2048, !r.enabled);
  return { enabled: r.enabled, url: raw ? webUrl(raw) : '', providers: r.providers as CrawlerProvider[] };
}
export function claimedCrawler(userAgent: string): CrawlerProvider | null {
  // These are self-declared tokens, not authenticated origin or ad-review identities.
  if (/(?:^|[^a-z0-9_-])(?:adsbot-google(?:-mobile(?:-apps)?)?|googlebot(?:-[a-z]+)?|mediapartners-google)(?=[/;\s)]|$)/i.test(userAgent)) return 'google';
  if (/(?:^|[^a-z0-9_-])(?:facebookexternalhit|facebot|meta-externalagent|meta-externalfetcher)(?=[/;\s)]|$)/i.test(userAgent)) return 'meta';
  return null;
}
export function resolveTraffic(campaign: Campaign, destinations: Destination[], context: { source: string; device: Device; userAgent: string }): TrafficDecision {
  if (campaign.status !== 'active') throw new Problem('This campaign is paused.', 410);
  const provider = claimedCrawler(context.userAgent);
  const config = campaign.crawlerRouting;
  if (config.enabled && provider && config.providers.includes(provider)) return { kind: 'crawler', campaign, ruleName: 'Crawler destination', provider, url: config.url, evidence: 'user-agent-only' };
  return { kind: 'visitor', ...chooseRoute(campaign, destinations, context) };
}
export function validateRules(value: unknown, destinations: Destination[]): Rule[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new Problem('Add between 1 and 30 routing rules.');
  const ids = new Set(destinations.map(d => d.id));
  return value.map((v, index) => {
    const r = object(v); if (typeof r.enabled !== 'boolean') throw new Problem('Each rule needs an enabled setting.');
    const device = text(r.device, 'Device', 20, true); if (!['', 'mobile', 'desktop', 'tablet'].includes(device)) throw new Problem('Unsupported device filter.');
    if (!Array.isArray(r.targets) || !r.targets.length || r.targets.length > 50) throw new Problem('Each rule needs 1–50 destinations.');
    const seen = new Set<string>();
    const targets = r.targets.map(v => { const t = object(v); const destinationId = text(t.destinationId, 'Destination ID'); if (!ids.has(destinationId)) throw new Problem('One of the destinations no longer exists.'); if (seen.has(destinationId)) throw new Problem('A destination can appear only once per rule.'); seen.add(destinationId); const weight = number(t.weight, 'Weight', 10000); if (!Number.isInteger(weight) || weight < 1) throw new Problem('Weights must be positive whole numbers.'); return { destinationId, weight }; });
    return { id: text(r.id ?? `rule-${index}`, 'Rule ID'), name: text(r.name, 'Rule name', 100), enabled: r.enabled, source: text(r.source, 'Source filter', 200, true), device: device as Rule['device'], targets };
  });
}
export function chooseRoute(campaign: Campaign, destinations: Destination[], context: { source: string; device: Device }, pick = (max: number) => randomInt(max)): Decision {
  if (campaign.status !== 'active') throw new Problem('This campaign is paused.', 410);
  const available = (d: Destination | undefined): d is Destination => Boolean(d && d.status === 'active' && (!d.dailyCap || d.clicksToday < d.dailyCap));
  for (const rule of campaign.rules) {
    if (!rule.enabled || (rule.source && rule.source !== context.source) || (rule.device && rule.device !== context.device)) continue;
    const eligible = rule.targets.flatMap(t => { const d = destinations.find(d => d.id === t.destinationId); return available(d) ? [{ destination: d, weight: t.weight }] : []; });
    if (!eligible.length) continue;
    let n = pick(eligible.reduce((s, t) => s + t.weight, 0));
    const selected = eligible.find(t => { n -= t.weight; return n < 0; });
    if (!selected) throw new Error('The routing selector returned an invalid value.');
    return { campaign, destination: selected.destination, ruleName: rule.name, eligible: eligible.map(t => ({ id: t.destination.id, name: t.destination.name, weight: t.weight })), fallback: false };
  }
  const fallback = destinations.find(d => d.id === campaign.fallbackId);
  if (available(fallback)) return { campaign, destination: fallback, ruleName: 'Fallback', eligible: [{ id: fallback.id, name: fallback.name, weight: 1 }], fallback: true };
  throw new Problem('No eligible destination. Check active routes, destination status and daily caps.', 503);
}
export function transactional<T>(store: Store, work: () => T): T { store.db.exec('BEGIN IMMEDIATE'); try { const result = work(); store.db.exec('COMMIT'); return result; } catch (e) { store.db.exec('ROLLBACK'); throw e; } }
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
