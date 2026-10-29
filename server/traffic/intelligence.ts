import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import type { IdentityEvidence, IntelligenceStatus, RequestFacts, Result } from '../../shared/traffic.ts';
import type { Store } from '../store.ts';
import { claimedCrawler } from '../domain.ts';
import { contains, isPublic, parseIp, parseNetwork, type Network } from './ip.ts';
import { record } from './validation.ts';

export const feedSources = {
  common: 'https://developers.google.com/static/crawling/ipranges/common-crawlers.json',
  special: 'https://developers.google.com/static/crawling/ipranges/special-crawlers.json',
} as const;
type Service = keyof typeof feedSources;
interface Feed { service: Service; revision: string; fetchedAt: string; expiresAt: string; networks: Network[]; }
export interface CrawlerResolver { reverse(ip: string): Promise<string[]>; resolve4(host: string): Promise<string[]>; resolve6(host: string): Promise<string[]>; cancel(): void; }
export interface IntelligenceOptions { networkEnabled?: boolean; fetcher?: typeof fetch; clock?: () => number; resolver?: CrawlerResolver; }
export function parseFeed(value: unknown): Result<Network[]> {
  if (!record(value) || !Array.isArray(value.prefixes) || !value.prefixes.length || value.prefixes.length > 20000) return { ok: false, error: { kind: 'invalid', message: 'Invalid or oversized crawler feed.' } };
  const networks: Network[] = [];
  for (const prefix of value.prefixes) {
    if (!record(prefix) || (typeof prefix.ipv4Prefix === 'string') === (typeof prefix.ipv6Prefix === 'string')) return { ok: false, error: { kind: 'invalid', message: 'Malformed crawler prefix.' } };
    const parsed = parseNetwork(prefix.ipv4Prefix ?? prefix.ipv6Prefix);
    if (!parsed.ok || (typeof prefix.ipv4Prefix === 'string' && parsed.value.family !== 4) || (typeof prefix.ipv6Prefix === 'string' && parsed.value.family !== 6)) return { ok: false, error: { kind: 'invalid', message: 'Malformed crawler CIDR.' } };
    networks.push(parsed.value);
  }
  return { ok: true, value: networks };
}
export class Intelligence {
  private feeds = new Map<Service, Feed>();
  private failures = new Map<Service, string>();
  private refreshing = new Map<Service, Promise<void>>();
  private nextAttempt = new Map<Service, number>();
  private dnsCache = new Map<string, { expires: number; evidence: IdentityEvidence }>();
  private resolving = new Map<string, Promise<IdentityEvidence>>();
  private abort = new AbortController();
  private resolver: CrawlerResolver;
  private closed = false;
  private clock: () => number;
  private store: Store;
  private options: IntelligenceOptions;
  readonly ready: Promise<void>;
  constructor(store: Store, options: IntelligenceOptions = {}) {
    this.store = store; this.options = options;
    this.resolver = options.resolver ?? new Resolver({ timeout: 1500, tries: 1 });
    this.clock = options.clock ?? Date.now;
    this.ready = this.loadStored();
    void this.ready.catch(() => {}); // The runtime awaits readiness and reports failures before serving requests.
  }
  private async loadStored() {
    for (const service of Object.keys(feedSources) as Service[]) {
      const row = (await this.store.db.prepare("SELECT * FROM relay.intelligence_revisions WHERE service=$1 ORDER BY fetched_at DESC LIMIT 1").get(service));
      if (this.closed) return;
      if (!row) continue;
      let parsed: Result<Network[]>; try { parsed = parseFeed({ prefixes: (JSON.parse(String(row.ranges)) as string[]).map(x => x.includes(':') ? { ipv6Prefix: x } : { ipv4Prefix: x }) }); } catch { parsed = { ok: false, error: { kind: 'invalid', message: 'Stored feed is malformed.' } }; }
      if (parsed.ok) this.feeds.set(service, { service, revision: String(row.revision), fetchedAt: String(row.fetched_at), expiresAt: String(row.expires_at), networks: parsed.value });
      else this.failures.set(service, parsed.error.message);
    }
  }
  private service(ua: string): Service { return /(?:adsbot-google|mediapartners-google)/i.test(ua) ? 'special' : 'common'; }
  unknown(facts: RequestFacts, reason: string): IdentityEvidence {
    return { claimedProvider: claimedCrawler(facts.userAgent), status: 'unknown', method: 'none', scope: null, reason, checkedAt: new Date(this.clock()).toISOString(), source: null, revision: null, match: null, checks: [] };
  }
  identify(facts: RequestFacts): IdentityEvidence {
    const initial = this.unknown(facts, 'no-supported-provider-claim');
    if (!initial.claimedProvider) return initial;
    if (initial.claimedProvider !== 'google') return { ...initial, reason: 'provider-verification-unavailable' };
    const ip = parseIp(facts.ip); if (!ip.ok || !isPublic(ip.value)) return { ...initial, reason: 'public-client-ip-unavailable' };
    const service = this.service(facts.userAgent); const feed = this.feeds.get(service);
    const checks: IdentityEvidence['checks'] = [];
    if (feed && Date.parse(feed.expiresAt) > this.clock()) {
      const index = feed.networks.findIndex(n => contains(n, ip.value)); const match = index >= 0 ? feed.networks[index] : null;
      checks.push({ method: 'official-ip-feed', outcome: match ? 'matched' : 'not-matched', reason: match ? 'official-network-match' : 'official-network-no-match', source: feedSources[service], revision: feed.revision, match: match?.source ?? null, checkedAt: initial.checkedAt, coverage: { examined: match ? index + 1 : feed.networks.length, total: feed.networks.length } });
      if (match) return { ...initial, status: 'verified', method: 'official-ip-feed', scope: `google-${service}-crawler-network`, source: feedSources[service], revision: feed.revision, match: match.source, reason: 'official-network-match', checks };
    }
    const cached = this.dnsCache.get(`${service}:${ip.value.text}`);
    if (cached && cached.expires > this.clock()) return { ...cached.evidence, checks: [...checks, ...cached.evidence.checks.filter(c => c.method === 'forward-confirmed-dns')] };
    return { ...initial, scope: `google-${service}-crawler-network`, source: checks.length ? feedSources[service] : null, revision: checks.length ? feed!.revision : null, checks, reason: checks.length ? 'network-not-matched-dns-pending' : 'intelligence-unavailable-or-expired' };
  }
  status(): IntelligenceStatus[] {
    return (Object.keys(feedSources) as Service[]).map(service => { const f = this.feeds.get(service); return { service, source: feedSources[service], fetchedAt: f?.fetchedAt ?? null, expiresAt: f?.expiresAt ?? null, revision: f?.revision ?? null, ranges: f?.networks.length ?? 0, fresh: Boolean(f && Date.parse(f.expiresAt) > this.clock()), failure: this.failures.get(service) ?? null }; });
  }
  async refresh(force = false) {
    await this.ready;
    await Promise.all((Object.keys(feedSources) as Service[]).map(service => this.refreshOne(service, force)));
  }
  private refreshOne(service: Service, force: boolean): Promise<void> {
    const running = this.refreshing.get(service); if (running) return running;
    const feed = this.feeds.get(service);
    if (this.closed || this.options.networkEnabled === false || (!force && ((feed && Date.parse(feed.expiresAt) > this.clock()) || (this.nextAttempt.get(service) ?? 0) > this.clock()))) return Promise.resolve();
    const job = (async () => {
      this.nextAttempt.set(service, this.clock() + 60000);
      try {
        const response = await (this.options.fetcher ?? fetch)(feedSources[service], { redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(5000)]) });
        if (this.closed) { await response.body?.cancel(); return; }
        if (!response.ok) { await response.body?.cancel(); throw new Error(`Feed returned HTTP ${response.status}.`); }
        const reader = response.body?.getReader(); if (!reader) throw new Error('Feed response is empty.');
        const chunks: Uint8Array[] = []; let size = 0;
        try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 2 * 1024 * 1024) throw new Error('Feed exceeds the 2 MiB memory budget.'); chunks.push(chunk.value); } } finally { await reader.cancel().catch(() => {}); }
        const bytes = Buffer.concat(chunks); const parsed = parseFeed(JSON.parse(bytes.toString('utf8')));
        if (!parsed.ok) throw new Error(parsed.error.message);
        if (this.closed) return;
        const fetchedAt = new Date(this.clock()).toISOString(); const expiresAt = new Date(this.clock() + 6 * 3600000).toISOString();
        const revision = `${service}:${createHash('sha256').update(bytes).digest('hex')}:${fetchedAt}`;
        (await this.store.db.prepare("INSERT INTO relay.intelligence_revisions VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING").run(revision, service, feedSources[service], fetchedAt, expiresAt, JSON.stringify(parsed.value.map(n => n.source))));
        this.feeds.set(service, { service, revision, fetchedAt, expiresAt, networks: parsed.value }); this.failures.delete(service);
      } catch (error) { if (!this.closed) this.failures.set(service, error instanceof Error ? error.message : 'Feed update failed.'); }
    })().finally(() => this.refreshing.delete(service));
    this.refreshing.set(service, job); return job;
  }
  async enrich(facts: RequestFacts): Promise<IdentityEvidence> {
    await this.ready;
    const existing = this.identify(facts);
    if (this.closed || this.options.networkEnabled === false || existing.claimedProvider !== 'google' || existing.status === 'verified') return existing;
    const ip = parseIp(facts.ip); if (!ip.ok || !isPublic(ip.value)) return existing;
    await this.refresh(); const updated = this.identify(facts); if (updated.status === 'verified' || this.closed) return updated;
    const service = this.service(facts.userAgent); const key = `${service}:${ip.value.text}`;
    const cached = this.dnsCache.get(key); if (cached && cached.expires > this.clock()) return updated;
    const running = this.resolving.get(key); if (running) return running;
    if (this.resolving.size >= 16) return { ...updated, reason: 'dns-capacity-unavailable' };
    const job = (async () => {
      let result = updated;
      let coverage: { examined: number; total: number } | null = null;
      try {
        const allNames = await this.resolver.reverse(ip.value.text);
        const names = allNames.slice(0, 4).map(n => n.toLowerCase().replace(/\.$/, ''));
        coverage = { examined: names.length, total: allNames.length };
        const allowed = names.filter(n => service === 'special' ? /^rate-limited-proxy-[a-z0-9-]+\.google\.com$/.test(n) : /^(?:crawl-[a-z0-9-]+\.googlebot\.com|geo-crawl-[a-z0-9-]+\.geo\.googlebot\.com)$/.test(n));
        result = { ...updated, status: 'unverified', reason: 'reverse-name-does-not-match-service', method: 'forward-confirmed-dns', source: 'dns', revision: null };
        let forwardUnavailable = false;
        for (const hostname of allowed) {
          const answers = await Promise.allSettled([this.resolver.resolve4(hostname), this.resolver.resolve6(hostname)]);
          if (answers.some(a => a.status === 'fulfilled' && a.value.some(value => { const p = parseIp(value); return p.ok && p.value.text === ip.value.text; }))) { result = { ...result, status: 'verified', match: hostname, reason: 'forward-confirmed-service-hostname' }; break; }
          const failed = answers.some(a => a.status === 'rejected' && !['ENODATA', 'ENOTFOUND'].includes(String(a.reason?.code)));
          forwardUnavailable ||= failed;
          result = { ...result, status: failed ? 'unknown' : 'unverified', match: hostname, reason: failed ? 'forward-dns-unavailable' : 'forward-address-mismatch' };
        }
        if (result.status !== 'verified' && (forwardUnavailable || allNames.length > names.length)) result = { ...result, status: 'unknown', reason: forwardUnavailable ? 'forward-dns-unavailable' : 'reverse-coverage-limited' };
      } catch (error) { const code = record(error) ? error.code : null; result = { ...updated, status: code === 'ENOTFOUND' ? 'unverified' : 'unknown', method: 'forward-confirmed-dns', source: 'dns', revision: null, reason: code === 'ENOTFOUND' ? 'reverse-name-not-found' : 'dns-unavailable' }; }
      result = { ...result, checkedAt: new Date(this.clock()).toISOString(), checks: [...updated.checks.filter(c => c.method === 'official-ip-feed'), { method: 'forward-confirmed-dns', outcome: result.status === 'verified' ? 'matched' : result.status === 'unverified' ? 'not-matched' : coverage ? 'partial' : 'unavailable', reason: result.reason, source: 'dns', revision: null, match: result.match, checkedAt: new Date(this.clock()).toISOString(), coverage }] };
      if (!this.closed) { for (const [k, v] of this.dnsCache) if (v.expires <= this.clock()) this.dnsCache.delete(k); if (this.dnsCache.size >= 1024) this.dnsCache.delete(this.dnsCache.keys().next().value!); this.dnsCache.set(key, { expires: this.clock() + 60000, evidence: result }); }
      return result;
    })().finally(() => this.resolving.delete(key));
    this.resolving.set(key, job); return job;
  }
  async close() { this.closed = true; this.abort.abort(); this.resolver.cancel(); await Promise.allSettled([this.ready, ...this.refreshing.values(), ...this.resolving.values()]); }
}
