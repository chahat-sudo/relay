import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openTestStore as openStore } from './postgres.ts';
import { createApp } from '../server/app.ts';
import { TrafficRuntime } from '../server/traffic/runtime.ts';
import { feedSources, Intelligence, parseFeed, type CrawlerResolver } from '../server/traffic/intelligence.ts';
import { EdgeVerifier, headersHash, signEnvelope, type EdgeEnvelope } from '../server/traffic/context.ts';
import type { IncomingMessage } from 'node:http';
import { contains, isPublic, parseIp, parseNetwork } from '../server/traffic/ip.ts';
import { evaluateExamples } from '../server/traffic/model.ts';
import type { Assessment, BrowserFacts, TrafficPage, TrafficRecord, TrafficStatus, TrafficSummary } from '../shared/traffic.ts';
import type { CrawlerRequest, TrafficDecision } from '../shared/types.ts';
import worker from '../edge/worker.ts';
import { signedHeaders } from '../shared/edge.ts';

async function fixture(options: { feeds?: boolean; clock?: () => number; networkEnabled?: boolean; fetcher?: typeof fetch; resolver?: CrawlerResolver } = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), 'relay-traffic-test-')); const store = (await openStore(folder));
  const loadedAt = fixtureClock();
  if (options.feeds) for (const [service, ranges] of [['common', ['66.249.66.0/24', '2001:4860:4801::/48']], ['special', ['66.249.90.0/24']]] as const) (await store.db.prepare("INSERT INTO relay.intelligence_revisions VALUES($1,$2,$3,$4,$5,$6)").run(`simulated-${service}`, service, feedSources[service], new Date(loadedAt).toISOString(), new Date(loadedAt + 3600000).toISOString(), JSON.stringify(ranges)));
  const key = randomBytes(32).toString('hex'); const audience = 'https://tracking.example.test';
  const runtime = new TrafficRuntime(store, { networkEnabled: options.networkEnabled ?? false, fetcher: options.fetcher, resolver: options.resolver, clock: options.clock, edge: { audience, keys: { primary: key, previous: key + 'previous' } } });
  await runtime.ready;
  const admin = createApp(store, folder, runtime); const publicServer = runtime.createPublicServer();
  await Promise.all([new Promise<void>(r => admin.listen(0, '127.0.0.1', r)), new Promise<void>(r => publicServer.listen(0, '127.0.0.1', r))]);
  const base = `http://127.0.0.1:${(admin.address() as { port: number }).port}`; const publicBase = `http://127.0.0.1:${(publicServer.address() as { port: number }).port}`;
  async function api<T = Record<string, unknown>>(route: string, data?: unknown, method = 'POST') {
    const response = await fetch(base + '/api' + route, data === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json', 'X-Relay-Request': '1' }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() as T };
  }
  async function setup(target = 'https://landing.example.test/offer') {
    const destination = await api<{ id: string }>('/destinations', { name: 'Offer', url: target, status: 'active', dailyCap: 0 });
    const campaign = await api<{ id: string }>('/campaigns', { name: 'Observed campaign', slug: 'observed', source: 'ads', status: 'active', costPerClick: .25, fallbackId: '', rules: [{ id: 'r', name: 'Primary', source: '', device: '', enabled: true, targets: [{ destinationId: destination.data.id, weight: 100 }] }], crawlerRouting: { enabled: true, url: 'https://example.org/legacy-crawler', providers: ['google', 'meta'] } });
    assert.equal(campaign.status, 200); return { campaignId: campaign.data.id, destinationId: destination.data.id };
  }
  async function signed(route: string, options: { ip?: string; ua?: string; headers?: Record<string, string>; raw?: string; method?: string; nonce?: string; timestamp?: number; audience?: string; keyId?: string; tamper?: Record<string, string>; edge?: EdgeEnvelope['edge']; signal?: AbortSignal } = {}) {
    const method = options.method ?? 'GET'; const bytes = Buffer.from(options.raw ?? '');
    const headers: Record<string, string> = { 'user-agent': options.ua ?? 'Mozilla/5.0', accept: 'text/html', ...options.headers };
    for (const name of signedHeaders) if (!Object.hasOwn(headers, name)) headers[name] = '';
    const envelope: EdgeEnvelope = { version: 1, keyId: options.keyId ?? 'primary', audience: options.audience ?? audience, timestamp: options.timestamp ?? fixtureClock(), nonce: options.nonce ?? randomUUID(), method, target: route, headersHash: headersHash(headers as IncomingHttpHeaders), bodyHash: createHash('sha256').update(bytes).digest('hex'), ip: options.ip ?? '8.8.8.8', edge: options.edge ?? { verifiedBot: null, score: null, category: null, ja4: null } };
    const signature = signEnvelope(envelope, envelope.keyId === 'previous' ? key + 'previous' : key);
    return fetch(publicBase + route, { method, headers: { ...headers, 'x-relay-envelope': signature.payload, 'x-relay-signature': signature.signature, ...options.tamper }, body: method === 'POST' ? bytes : undefined, redirect: 'manual', signal: options.signal });
  }
  function fixtureClock() { return options.clock?.() ?? Date.now(); }
  async function close() {
    await runtime.close(); for (const s of [admin, publicServer]) s.closeAllConnections();
    await Promise.all([admin, publicServer].map(s => new Promise<void>(r => s.close(() => r())))); (await store.db.close());
    assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir())); assert.ok(path.basename(folder).startsWith('relay-traffic-test-')); rmSync(folder, { recursive: true });
  }
  return { folder, store, runtime, base, publicBase, api, setup, signed, close, key, audience };
}
const browser: BrowserFacts = { version: 1, webdriver: false, language: 'en-US', timezone: 'Asia/Kolkata', platform: 'Windows', viewport: { width: 1440, height: 900 }, cookiesEnabled: true, elapsedMs: 2, errors: [] };

test('verified routing works in every mode; claims, generic bot metadata and expired ranges use visitor rules', async () => {
  let now = Date.now(); const f = await fixture({ feeds: true, clock: () => now }); try {
    const { campaignId } = await f.setup();
    for (const mode of ['off', 'observe', 'enforce'] as const) {
      await f.api('/traffic/config', { mode, enforcementApproved: mode === 'enforce' }, 'PUT');
      const verified = await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '::ffff:66.249.66.1' });
      assert.equal(verified.headers.get('location'), 'https://example.org/legacy-crawler'); assert.equal(verified.headers.get('set-cookie'), null);
      for (const input of [
        { ua: 'Googlebot/2.1', ip: '8.8.8.8' },
        { ua: 'facebookexternalhit/1.1', ip: '66.249.66.1' },
        { ua: 'Mozilla/5.0', ip: '66.249.66.1' },
        { ua: 'NotGooglebot/2.1', ip: '66.249.66.1' },
        { ua: 'Googlebot/2.1', ip: '8.8.8.8', edge: { verifiedBot: true, score: 99, category: 'Search Engine Crawler', ja4: null } },
      ]) {
        const response = await f.signed('/r/observed', input); assert.equal(response.status, 302);
        assert.equal(new URL(response.headers.get('location')!).hostname, 'landing.example.test');
      }
    }
    assert.equal((await f.store.campaigns())[0].clicks, 15);
    assert.equal((await f.api<{ total: number }>('/crawler-requests')).data.total, 3);
    const before = (await f.store.db.prepare("SELECT count(*) n FROM relay.traffic_requests").get())!.n;
    const head = await f.signed('/r/observed', { method: 'HEAD', ua: 'Googlebot/2.1', ip: '66.249.66.1' });
    assert.equal(head.status, 200); assert.equal(head.headers.get('set-cookie'), null);
    assert.equal((await f.store.db.prepare("SELECT count(*) n FROM relay.traffic_requests").get())!.n, before);
    assert.equal((await f.api<{ total: number }>('/crawler-requests')).data.total, 3);
    const sim = await f.api<TrafficDecision>('/simulate', { campaignId, source: '', device: 'desktop', userAgent: 'Googlebot/2.1', identity: { status: 'verified' }, ip: '66.249.66.1' });
    assert.equal(sim.data.kind, 'visitor'); assert.equal(sim.data.identity.status, 'unknown'); assert.equal(sim.data.identity.reason, 'synthetic-simulation-not-origin-proof');
    assert.equal((await f.store.campaigns())[0].clicks, 15);
    for (const crawlerRouting of [
      { enabled: false, url: 'https://example.org/legacy-crawler', providers: ['google'] },
      { enabled: true, url: 'https://example.org/legacy-crawler', providers: ['meta'] },
    ]) {
      await f.api(`/campaigns/${campaignId}`, { ...(await f.store.campaigns())[0], crawlerRouting }, 'PUT');
      assert.equal(new URL((await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1' })).headers.get('location')!).hostname, 'landing.example.test');
    }
    await f.api(`/campaigns/${campaignId}`, { ...(await f.store.campaigns())[0], crawlerRouting: { enabled: true, url: 'https://example.org/legacy-crawler', providers: ['google'] } }, 'PUT');
    now += 2 * 3600000;
    assert.equal(new URL((await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1' })).headers.get('location')!).hostname, 'landing.example.test');
    assert.equal((await f.api<{ total: number }>('/crawler-requests')).data.total, 3);
    await f.api(`/campaigns/${campaignId}`, { ...(await f.store.campaigns())[0], status: 'paused' }, 'PUT');
    assert.equal((await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1' })).status, 410);
  } finally { await f.close(); }
});

test('cold verification never delays delivery or rewrites it; later requests use the refreshed feed with detection off', async () => {
  let release!: () => void; const gate = new Promise<void>(r => { release = r; }); let fetches = 0;
  const f = await fixture({ networkEnabled: true, fetcher: async input => { fetches++; await gate; return new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: String(input).includes('common-crawlers') ? '66.249.66.0/24' : '66.249.90.0/24' }] })); } });
  try {
    await f.setup();
    // A deadline catches accidental waiting on the unreleased network gate.
    const response = await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1', signal: AbortSignal.timeout(2000) });
    const original = response.headers.get('location')!; assert.equal(new URL(original).hostname, 'landing.example.test'); assert.equal(fetches, 2);
    release();
    const facts = { requestTarget: '/r/observed', ip: '66.249.66.1', sourceIp: '66.249.66.1', authority: 'cloudflare-signed' as const, userAgent: 'Googlebot/2.1', accept: null, language: null, platformHint: null, edge: { verifiedBot: null, score: null, category: null, ja4: null } };
    assert.equal((await f.runtime.intelligence.enrich(facts)).status, 'verified');
    assert.equal((await f.signed('/r/observed', { ua: facts.userAgent, ip: facts.ip })).headers.get('location'), 'https://example.org/legacy-crawler');
    assert.equal((await f.store.campaigns())[0].clicks, 1); assert.equal((await f.runtime.repository.summary(30)).total, 0);
    assert.ok((await f.store.db.prepare("SELECT id FROM relay.clicks WHERE id=$1").get(new URL(original).searchParams.get('click_id')!)));
  } finally { release(); await f.close(); }
});

test('DNS proof selects subsequent routes only while fresh and preserves the original delivery and cost', async () => {
  let now = Date.now(); const resolver: CrawlerResolver = { reverse: async () => ['crawl-66-249-66-1.googlebot.com'], resolve4: async () => ['66.249.66.1'], resolve6: async () => [], cancel() {} };
  const f = await fixture({ networkEnabled: true, clock: () => now, resolver, fetcher: async () => new Response('', { status: 503 }) });
  try {
    await f.setup(); await f.api('/traffic/config', { mode: 'observe' }, 'PUT');
    const first = await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1' });
    const firstUrl = first.headers.get('location')!; const row = (await f.runtime.repository.list({ days: 30, offset: 0, limit: 1 })).items[0];
    assert.equal(new URL(firstUrl).hostname, 'landing.example.test');
    assert.equal((await f.runtime.intelligence.enrich(row.context)).status, 'verified');
    const second = await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1' }); assert.equal(second.headers.get('location'), 'https://example.org/legacy-crawler');
    const log = (await f.api<{ items: CrawlerRequest[] }>('/crawler-requests')).data.items; assert.equal(log[0].identity?.method, 'forward-confirmed-dns'); assert.equal(log[0].identity?.match, 'crawl-66-249-66-1.googlebot.com');
    const retained = (await f.runtime.repository.get(row.id))!; assert.equal(retained.destinationUrl, firstUrl); assert.equal(retained.estimatedCost, .25); assert.ok(retained.clickId);
    now += 60001;
    assert.equal(new URL((await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1' })).headers.get('location')!).hostname, 'landing.example.test');
    assert.equal((await f.store.campaigns())[0].clicks, 2);
  } finally { await f.close(); }
});



test('IP ownership boundary handles IPv4, IPv6 and mapped addresses without CIDR ambiguity', () => {
  const ip = parseIp('::ffff:66.249.66.1'); assert.ok(ip.ok); assert.equal(ip.value.text, '66.249.66.1'); assert.equal(ip.value.family, 4);
  const six = parseIp('2001:4860:4801:0000:0000:0000:0000:0001'); assert.ok(six.ok); assert.equal(six.value.text, '2001:4860:4801::1');
  for (const [cidr, address, expected] of [['66.249.66.7/24', '66.249.66.9', true], ['66.249.66.0/24', '66.249.67.1', false], ['2001:4860::/32', '2001:4860:4801::1', true], ['0.0.0.0/0', '8.8.8.8', true]] as const) { const n = parseNetwork(cidr); const p = parseIp(address); assert.ok(n.ok && p.ok); assert.equal(contains(n.value, p.value), expected); }
  for (const value of ['127.1', '001.2.3.4', '8.8.8.8, 1.1.1.1', 'fe80::1%eth0', 'not-an-ip']) assert.equal(parseIp(value).ok, false);
  for (const value of ['1.2.3.4/33', '::1/129', '1.2.3.4/-1', '1.2.3.4/24/1']) assert.equal(parseNetwork(value).ok, false);
  const local = parseIp('127.0.0.1'); assert.ok(local.ok); assert.equal(isPublic(local.value), false);
});

test('authenticated ingress rejects forgery, tampering, replay, stale signatures and public admin access', async () => {
  const f = await fixture(); try {
    await f.setup(); await f.api('/traffic/config', { mode: 'observe' }, 'PUT');
    assert.equal((await fetch(f.publicBase + '/r/observed', { redirect: 'manual', headers: { 'CF-Connecting-IP': '66.249.66.1', 'CF-Verified-Bot': 'true' } })).status, 403);
    assert.equal((await f.signed('/r/observed', { tamper: { 'user-agent': 'Googlebot/2.1' } })).status, 403);
    assert.equal((await f.signed('/r/observed', { timestamp: Date.now() - 61000 })).status, 403);
    assert.equal((await f.signed('/r/observed', { audience: 'https://other.example.test' })).status, 403);
    const nonce = randomUUID(); assert.equal((await f.signed('/r/observed', { nonce })).status, 302); assert.equal((await f.signed('/r/observed', { nonce })).status, 403);
    assert.equal((await f.signed('/r/observed', { keyId: 'previous' })).status, 302);
    assert.equal((await f.signed('/r/observed', { keyId: 'unknown' })).status, 403);
    for (const route of ['/api/bootstrap', '/api/settings', '/site', '/example/frame', '/']) assert.equal((await f.signed(route)).status, 404);
    assert.equal((await f.signed('/r/observed', { method: 'POST', raw: '{}' })).status, 405);
    const foreignHostStatus = await new Promise<number>(resolve => { http.get(f.base + '/api/bootstrap', { headers: { Host: 'public.example.test' } }, response => { response.resume(); resolve(response.statusCode!); }); });
    assert.equal(foreignHostStatus, 403);
    const list = await f.api<TrafficPage>('/traffic/requests'); assert.equal(list.data.total, 2);
    assert.ok(list.data.items.every(r => r.context.authority === 'cloudflare-signed'));
    assert.ok(!JSON.stringify(list.data).includes(f.key));
  } finally { await f.close(); }
});

test('observation routes only service-verified origins and preserves visitor CPC and crawler evidence', async () => {
  const f = await fixture({ feeds: true }); try {
    const { campaignId } = await f.setup(); await f.api('/traffic/config', { mode: 'observe' }, 'PUT');
    const inputs = [{ ip: '66.249.66.1', ua: 'Googlebot/2.1', verified: true }, { ip: '2001:4860:4801::1', ua: 'Googlebot/2.1', verified: true }, { ip: '66.249.90.77', ua: 'AdsBot-Google', verified: true }, { ip: '66.249.66.1', ua: 'AdsBot-Google', verified: false }, { ip: '8.8.8.8', ua: 'facebookexternalhit/1.1', verified: false }];
    for (const i of inputs) {
      const r = await f.signed('/r/observed', i); assert.equal(r.status, 302);
      assert.equal(new URL(r.headers.get('location')!).hostname, i.verified ? 'example.org' : 'landing.example.test');
      if (i.verified) { assert.equal(r.headers.get('set-cookie'), null); assert.equal(r.headers.get('location'), 'https://example.org/legacy-crawler'); }
    }
    const list = (await f.api<TrafficPage>('/traffic/requests')).data; assert.equal(list.total, 5); assert.equal(list.items.filter(r => r.assessment.identity.status === 'verified').length, 3);
    assert.equal((await f.store.campaigns())[0].crawlerRouting.enabled, true);
    const summary = (await f.api<TrafficSummary>('/traffic/summary')).data; assert.equal(summary.total, 5); assert.equal(summary.estimatedCost, .5); assert.equal(summary.verifiedCrawlers, 3); assert.equal(summary.qualifying + summary.excluded + summary.unknown, summary.total);
    assert.equal((await f.store.campaigns())[0].clicks, 2);
    const before = (await f.store.db.prepare("SELECT count(*) n FROM relay.traffic_requests").get())!.n;
    assert.equal((await f.signed('/r/observed', { method: 'HEAD', ua: 'Googlebot/2.1', ip: '66.249.66.1' })).status, 200);
    assert.equal((await f.store.db.prepare("SELECT count(*) n FROM relay.traffic_requests").get())!.n, before);
    assert.equal((await f.api('/traffic/config', { mode: 'off' }, 'PUT')).status, 200);
    assert.equal(new URL((await f.signed('/r/observed', { ua: 'Googlebot/2.1' })).headers.get('location')!).hostname, 'landing.example.test');
    assert.equal((await f.store.campaigns()).find(c => c.id === campaignId)!.clicks, 3);
    const crawlers = (await f.api<{ items: CrawlerRequest[] }>('/crawler-requests')).data; assert.equal(crawlers.items.length, 3);
    assert.ok(crawlers.items.every(r => r.identity?.status === 'verified' && r.identity.revision?.startsWith('simulated-')));
    assert.ok(list.items.filter(r => r.assessment.identity.status === 'verified').every(r => r.clickId === null && r.estimatedCost === 0 && r.collection === 'not-requested'));
  } finally { await f.close(); }
});

test('local proxy headers never establish identity; simulations are synthetic and have no writes', async () => {
  const f = await fixture({ feeds: true }); try {
    await f.setup(); await f.api('/traffic/config', { mode: 'observe' }, 'PUT');
    await fetch(f.base + '/r/observed', { redirect: 'manual', headers: { 'User-Agent': 'Googlebot/2.1', 'CF-Connecting-IP': '66.249.66.1', 'CF-Verified-Bot': 'true' } });
    const r = (await f.api<TrafficPage>('/traffic/requests')).data.items[0]; assert.equal(r.context.authority, 'socket'); assert.equal(r.context.ip, '127.0.0.1'); assert.equal(r.assessment.identity.status, 'unknown'); assert.equal(r.context.edge.verifiedBot, null);
    const before = (await f.api<TrafficSummary>('/traffic/summary')).data;
    const sim = await f.api<{ synthetic: boolean; assessment: Assessment }>('/traffic/simulate', { userAgent: 'Googlebot/2.1', ip: '66.249.66.1', rateCount: 1000 });
    assert.equal(sim.data.synthetic, true); assert.equal(sim.data.assessment.identity.status, 'unknown'); assert.equal(sim.data.assessment.identity.reason, 'synthetic-simulation-not-origin-proof');
    assert.deepEqual((await f.api<TrafficSummary>('/traffic/summary')).data, before);
    for (const route of ['/traffic/requests?limit=0', '/traffic/requests?risk=human', '/traffic/summary?days=-1']) assert.equal((await f.api(route)).status, 400);
  } finally { await f.close(); }
});

test('browser observations require a scoped cookie and exact origin; retries retain one click and immutable delivery', async () => {
  let now = Date.now(); const f = await fixture({ clock: () => now }); try {
    await f.setup(); await f.api('/traffic/config', { mode: 'observe', collectBrowser: true, ownedOrigins: ['https://landing.example.test'] }, 'PUT');
    const visit = await f.signed('/r/observed?external_id=original'); const u = new URL(visit.headers.get('location')!); const requestId = u.searchParams.get('relay_request')!;
    const tokenCookie = visit.headers.getSetCookie().find(c => c.startsWith('relay_collection='))!.split(';')[0]; assert.ok(tokenCookie); assert.ok(!u.href.includes(tokenCookie.split('=')[1]));
    const route = `/t/events/${requestId}`; const headers = { origin: 'https://landing.example.test', cookie: tokenCookie, 'content-type': 'application/json' };
    assert.equal((await f.signed(route, { method: 'POST', raw: JSON.stringify(browser), headers: { ...headers, origin: 'https://evil.example.test' } })).status, 403);
    assert.equal((await f.signed(route, { method: 'POST', raw: JSON.stringify(browser), headers: { ...headers, cookie: '' } })).status, 403);
    assert.equal((await f.signed(route, { method: 'POST', raw: '{}', headers })).status, 400);
    const preflight = await f.signed(route, { method: 'OPTIONS', headers: { origin: headers.origin } }); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), headers.origin);
    const concurrent = await Promise.all([1, 2].map(() => f.signed(route, { method: 'POST', raw: JSON.stringify(browser), headers })));
    assert.ok(concurrent.every(r => r.status === 200));
    assert.deepEqual((await Promise.all(concurrent.map(r => r.json()))).map(r => r.duplicate).sort(), [false, true]);
    const duplicate = await f.signed(route, { method: 'POST', raw: JSON.stringify(browser), headers }); assert.equal((await duplicate.json()).duplicate, true);
    assert.equal((await f.signed(route, { method: 'POST', raw: JSON.stringify({ ...browser, webdriver: true }), headers })).status, 409);
    const row = (await f.runtime.repository.get(requestId))!; assert.equal(row.collection, 'complete'); assert.equal(row.destinationUrl, u.href); assert.equal(row.externalId, 'original'); assert.equal((await f.store.campaigns())[0].clicks, 1);
    const detail = (await f.runtime.repository.detail(requestId)); assert.equal(detail.assessments.length, 2); assert.equal(detail.actions.length, 1); assert.equal(detail.observations.filter(o => o.kind === 'browser').length, 1);
    const second = await f.signed('/r/observed'); const secondId = new URL(second.headers.get('location')!).searchParams.get('relay_request')!;
    now += 121000; (await f.runtime.repository.maintain(now)); assert.equal((await f.runtime.repository.get(secondId))!.collection, 'expired');
    const secondCookie = second.headers.getSetCookie().find(c => c.startsWith('relay_collection='))!.split(';')[0];
    assert.equal((await f.signed(`/t/events/${secondId}`, { method: 'POST', raw: JSON.stringify(browser), headers: { ...headers, cookie: secondCookie } })).status, 410);
    assert.equal((await f.api('/traffic/model/evaluate', {})).data.state, 'not-enough-data');
  } finally { await f.close(); }
});

test('configured enforcement, verified crawler exception and manual continuation preserve exact accounting', async () => {
  const f = await fixture({ feeds: true }); try {
    await f.setup();
    assert.equal((await f.api('/traffic/config', { mode: 'enforce' }, 'PUT')).status, 400);
    const networks = [{ cidr: '8.8.8.8/32', kind: 'deny', note: 'Synthetic test rule' }, { cidr: '66.249.66.0/24', kind: 'deny', note: 'Verified crawler exception test' }];
    await f.api('/traffic/config', { mode: 'enforce', enforcementApproved: true, highRiskAction: 'throttle', networks }, 'PUT');
    const throttled = await f.signed('/r/observed'); assert.equal(throttled.status, 429); assert.equal(throttled.headers.get('retry-after'), '60'); assert.equal((await f.store.campaigns())[0].clicks, 0);
    assert.equal((await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1' })).status, 302);
    await f.api('/traffic/config', { highRiskAction: 'deny' }, 'PUT'); assert.equal((await f.signed('/r/observed')).status, 403);
    await f.api('/traffic/config', { highRiskAction: 'challenge' }, 'PUT');
    const challenge = await f.signed('/r/observed'); assert.equal(challenge.status, 200); const html = await challenge.text(); assert.ok(!html.includes('<script')); const token = /name="token" value="([a-f0-9]{64})"/.exec(html)![1];
    const follow = () => f.signed('/t/challenge', { method: 'POST', headers: { origin: f.audience, 'content-type': 'application/x-www-form-urlencoded' }, raw: `token=${token}` });
    const [first, second] = await Promise.all([follow(), follow()]); assert.equal(first.status, 302); assert.equal(second.headers.get('location'), first.headers.get('location'));
    assert.equal((await f.store.campaigns())[0].clicks, 1); const summary = (await f.runtime.repository.summary(30)); assert.equal(summary.total, 4); assert.equal(summary.estimatedCost, .75); assert.equal(summary.actualRestricted, 2);
    const challenged = (await f.api<TrafficPage>('/traffic/requests')).data.items.find(r => r.assessment.reasons.includes('network-deny') && r.actualAction === 'allow' && r.assessment.identity.status !== 'verified')!;
    assert.deepEqual((await f.runtime.repository.detail(challenged.id)).actions.map(a => a.action), ['challenge', 'allow']);
    const clickId = new URL(first.headers.get('location')!).searchParams.get('click_id');
    const conversion = await f.api('/conversions', { clickId, transactionId: 'after-challenge', revenue: 10, status: 'approved' }); assert.equal(conversion.status, 200);
    await f.api('/traffic/config', { mode: 'observe' }, 'PUT'); assert.equal((await f.signed('/r/observed')).status, 302);
  } finally { await f.close(); }
});

test('simultaneous observed visits still honor caps, and retention removes IPs without rewriting accounting', async () => {
  let now = Date.now(); const f = await fixture({ clock: () => now }); try {
    const { campaignId, destinationId } = await f.setup();
    const fallback = (await f.api<{ id: string }>('/destinations', { name: 'Fallback', url: 'https://example.net/fallback', status: 'active', dailyCap: 0 })).data.id;
    await f.api(`/destinations/${destinationId}`, { name: 'Primary', url: 'https://landing.example.test/offer', status: 'active', dailyCap: 3 }, 'PUT');
    const c = (await f.store.campaigns())[0]; await f.api(`/campaigns/${campaignId}`, { ...c, fallbackId: fallback }, 'PUT');
    await f.api('/traffic/config', { mode: 'observe', rawIpDays: 0 }, 'PUT');
    const visits = await Promise.all(Array.from({ length: 20 }, () => f.signed('/r/observed'))); assert.ok(visits.every(r => r.status === 302));
    assert.equal((await f.store.destinations()).find(d => d.id === destinationId)!.clicksToday, 3); assert.equal((await f.store.destinations()).find(d => d.id === fallback)!.clicksToday, 17);
    now += 2; (await f.runtime.repository.maintain(now)); const records = (await f.runtime.repository.list({ days: 30, limit: 25, offset: 0 })); assert.ok(records.items.every(r => r.context.ip === null && r.context.sourceIp === null)); assert.equal((await f.runtime.repository.summary(30)).estimatedCost, 5);
    now += 31 * 86400000; (await f.runtime.repository.maintain(now)); assert.equal((await f.runtime.repository.summary(30)).total, 0); assert.equal((await f.store.campaigns())[0].clicks, 20);
  } finally { await f.close(); }
});

test('feed parsing and refresh keep mixed outcomes, expiry and cancellation explicit (simulated network)', async () => {
  assert.equal(parseFeed({ prefixes: [{ ipv4Prefix: '1.2.3.4/99' }] }).ok, false); assert.equal(parseFeed({ prefixes: [{ ipv4Prefix: '1.2.3.0/24', ipv6Prefix: '2001:4860::/32' }] }).ok, false);
  const folder = mkdtempSync(path.join(tmpdir(), 'relay-traffic-test-')); const store = (await openStore(folder)); let now = Date.now();
  const intel = new Intelligence(store, { clock: () => now, fetcher: async input => String(input).includes('common-crawlers') ? new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: '66.249.66.0/24' }] })) : new Response('', { status: 503 }) });
  try {
    await intel.refresh(); assert.equal(intel.status()[0].fresh, true); assert.match(intel.status()[1].failure!, /503/);
    now += 7 * 3600000; assert.equal(intel.status()[0].fresh, false);
    const facts = { requestTarget: '/r/test', ip: '66.249.66.1', sourceIp: '66.249.66.1', authority: 'cloudflare-signed' as const, userAgent: 'Googlebot/2.1', accept: null, language: null, platformHint: null, edge: { verifiedBot: null, score: null, category: null, ja4: null } };
    assert.equal(intel.identify(facts).status, 'unknown');
  } finally { await intel.close(); (await store.db.close()); assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir())); rmSync(folder, { recursive: true }); }
});



test('offline model refuses missing labels and evaluates synthetic held-out sessions without activation', () => {
  assert.equal(evaluateExamples([]).state, 'not-enough-data');
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: String(i), session: `session-${i}`, at: new Date(1700000000000 + i * 1000).toISOString(), label: (i % 2 ? 'abusive' : 'legitimate') as 'abusive' | 'legitimate', reasons: i % 2 ? ['browser-reports-automation'] : [], baselineHigh: false }));
  const report = evaluateExamples(rows); assert.equal(report.state, 'evaluated');
  if (report.state === 'evaluated') { assert.equal(report.activated, false); assert.equal(report.eligibleForReview, false); assert.equal(report.candidate.recall, 1); assert.equal(report.baseline.recall, 0); }
});

test('configuration changes retain before/after snapshots and identical saves are idempotent', async () => {
  const f = await fixture(); try {
    assert.equal((await f.api('/traffic/config', { mode: 'observe' }, 'PUT')).status, 200);
    const first = (await f.runtime.repository.history()); assert.equal(first.items.length, 2); assert.equal(first.items[1].config.mode, 'off');
    await f.api('/traffic/config', { mode: 'observe' }, 'PUT'); assert.equal((await f.runtime.repository.history()).items.length, 2);
    await f.api('/traffic/config', { requestsPerMinute: 200 }, 'PUT'); assert.equal((await f.runtime.repository.history()).items.length, 3);
    const prior = (await f.api<{ items: { config: unknown }[] }>('/traffic/config/history')).data.items.at(-1)!;
    await f.api('/traffic/config', prior.config, 'PUT'); assert.equal((await f.runtime.repository.config()).mode, 'off');
    assert.equal((await f.runtime.repository.history()).items.length, 4);
    assert.equal((await f.api('/traffic/config', { mode: 'enforce', enforcementApproved: false }, 'PUT')).status, 400); assert.equal((await f.runtime.repository.history()).items.length, 4);
  } finally { await f.close(); }
});

test('forward-confirmed DNS checks exact service hostnames, matching addresses and expected failures', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'relay-traffic-test-')); const store = (await openStore(folder)); let now = Date.now();
  let hostname = 'crawl-66-249-66-1.googlebot.com'; let address = '66.249.66.1'; let fail = false; let forwards = 0; let extraNames: string[] = [];
  const resolver: CrawlerResolver = {
    async reverse() { if (fail) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); return [hostname, ...extraNames]; },
    async resolve4(host) { forwards++; if (host === 'crawl-timeout.googlebot.com') throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); return [address]; }, async resolve6() { return []; }, cancel() {},
  };
  const intel = new Intelligence(store, { clock: () => now, resolver, fetcher: async () => new Response('', { status: 503 }) });
  const facts = { requestTarget: '/r/test', ip: '66.249.66.1', sourceIp: '66.249.66.1', authority: 'cloudflare-signed' as const, userAgent: 'Googlebot/2.1', accept: null, language: null, platformHint: null, edge: { verifiedBot: null, score: null, category: null, ja4: null } };
  try {
    const verified = await intel.enrich(facts); assert.equal(verified.status, 'verified'); assert.equal(verified.method, 'forward-confirmed-dns'); assert.equal(verified.match, hostname);
    now += 1000; assert.equal(intel.identify(facts).checkedAt, verified.checkedAt);
    now += 61000; hostname = 'crawl-66-249-66-1.googlebot.com.evil.example'; const before = forwards;
    const suffix = await intel.enrich(facts); assert.equal(suffix.status, 'unverified'); assert.equal(forwards, before);
    now += 61000; hostname = 'crawl-66-249-66-1.googlebot.com'; address = '8.8.8.8'; assert.equal((await intel.enrich(facts)).reason, 'forward-address-mismatch');
    now += 61000; fail = true; assert.equal((await intel.enrich(facts)).status, 'unknown');
    now += 61000; fail = false; hostname = 'crawl-timeout.googlebot.com'; extraNames = ['crawl-mismatch.googlebot.com']; assert.equal((await intel.enrich(facts)).status, 'unknown');
    now += 61000; hostname = 'not-google.example'; extraNames = ['a.example', 'b.example', 'c.example', 'crawl-66-249-66-1.googlebot.com']; const limited = await intel.enrich(facts); assert.equal(limited.reason, 'reverse-coverage-limited'); assert.deepEqual(limited.checks.at(-1)!.coverage, { examined: 4, total: 5 });
  } finally { await intel.close(); (await store.db.close()); assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir())); rmSync(folder, { recursive: true }); }
});

test('shutdown retains late feed work until cleanup finishes and never writes a late revision', async () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'relay-traffic-test-')); const store = (await openStore(folder));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let starts = 0;
  const runtime = new TrafficRuntime(store, { fetcher: async () => { starts++; await gate; return new Response(JSON.stringify({ prefixes: [{ ipv4Prefix: '66.249.66.0/24' }] })); } });
  try {
    await runtime.ready;
    const refresh = runtime.intelligence.refresh(); await Promise.resolve(); assert.equal(starts, 2);
    const closing = runtime.close(); assert.equal(runtime.close(), closing);
    let done = false; void closing.then(() => { done = true; }); await new Promise<void>(r => setImmediate(r)); assert.equal(done, false);
    release(); await Promise.all([refresh, closing]); assert.equal(done, true);
    assert.equal((await store.db.prepare("SELECT count(*) n FROM relay.intelligence_revisions").get())!.n, 0);
  } finally { release(); await runtime.close(); (await store.db.close()); assert.equal(path.dirname(path.resolve(folder)), path.resolve(tmpdir())); rmSync(folder, { recursive: true }); }
});

test('replay capacity never discards live ownership and releases expired entries', () => {
  let now = Date.now(); const key = randomBytes(32).toString('hex'); const audience = 'https://capacity.example.test'; const verifier = new EdgeVerifier({ audience, keys: { primary: key } }, () => now);
  const req = { headers: { 'user-agent': 'Test' }, method: 'GET', url: '/r/test', socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage;
  const body = Buffer.alloc(0);
  function verify(nonce: string) {
    const signed = signEnvelope({ version: 1, keyId: 'primary', audience, timestamp: now, nonce, method: 'GET', target: '/r/test', headersHash: headersHash(req.headers), bodyHash: createHash('sha256').update(body).digest('hex'), ip: '8.8.8.8', edge: { verifiedBot: null, score: null, category: null, ja4: null } }, key);
    req.headers['x-relay-envelope'] = signed.payload; req.headers['x-relay-signature'] = signed.signature; return verifier.verify(req, body);
  }
  const first = randomUUID(); assert.equal(verify(first).ok, true);
  for (let i = 1; i < 16384; i++) assert.equal(verify(randomUUID()).ok, true);
  const exhausted = verify(randomUUID()); assert.ok(!exhausted.ok); assert.equal(exhausted.error.kind, 'capacity');
  const replay = verify(first); assert.ok(!replay.ok); assert.equal(replay.error.kind, 'unauthorized');
  now += 61001; assert.equal(verify(randomUUID()).ok, true);
});

test('traffic API methods, collection bounds and durable-write failures fail before partial accounting', async () => {
  const f = await fixture({ feeds: true }); try {
    await f.setup(); await f.api('/traffic/config', { mode: 'observe' }, 'PUT');
    for (const [route, method, allow] of [['/traffic/status', 'POST', 'GET'], ['/traffic/config', 'POST', 'PUT'], ['/traffic/model/evaluate', 'PUT', 'POST'], ['/traffic/requests', 'DELETE', 'GET']] as const) {
      const response = await fetch(f.base + '/api' + route, { method, body: '{' }); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), allow);
    }
    const asset = await fetch(f.base + '/t/collector.js', { method: 'POST' }); assert.equal(asset.status, 405); assert.equal(asset.headers.get('allow'), 'GET, HEAD');
    const big = await f.signed(`/t/events/${randomUUID()}`, { method: 'POST', raw: 'x'.repeat(32769), headers: { 'content-type': 'application/json' } }); assert.equal(big.status, 413);
    const policiesBefore = (await f.store.db.prepare("SELECT count(*) n FROM relay.traffic_policies").get())!.n;
    await f.store.db.exec("CREATE FUNCTION relay.fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated write failure'; END $$; CREATE TRIGGER simulate_full_disk BEFORE INSERT ON relay.traffic_requests FOR EACH ROW EXECUTE FUNCTION relay.fail_write();");
    const failed = await fetch(f.base + '/r/observed', { redirect: 'manual' }); assert.equal(failed.status, 503);
    const failedCrawler = await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1' }); assert.equal(failedCrawler.status, 503); assert.equal(failedCrawler.headers.get('set-cookie'), null);
    assert.equal((await f.store.db.prepare("SELECT count(*) n FROM relay.crawler_requests").get())!.n, 0);
    assert.equal((await f.store.campaigns())[0].clicks, 0); assert.equal((await f.runtime.repository.summary(30)).total, 0); assert.equal((await f.store.db.prepare("SELECT count(*) n FROM relay.traffic_policies").get())!.n, policiesBefore);
    await f.store.db.exec('DROP TRIGGER simulate_full_disk ON relay.traffic_requests; DROP FUNCTION relay.fail_write();');
    assert.equal((await f.signed('/r/observed')).status, 302);
    assert.equal((await f.api('/traffic/config', { networks: [{ cidr: '8.8.8.8/32', kind: 'deny', note: '', unexpected: 'data' }] }, 'PUT')).status, 400);
  } finally { await f.close(); }
});

test('crawler evidence survives restart and retains cited feed revisions until detail expiry', async () => {
  let now = Date.now(); const f = await fixture({ feeds: true, clock: () => now }); try {
    const { campaignId } = await f.setup();
    const response = await f.signed('/r/observed', { ua: 'Googlebot/2.1', ip: '66.249.66.1' }); assert.equal(response.headers.get('location'), 'https://example.org/legacy-crawler');
    (await f.store.db.prepare("INSERT INTO relay.crawler_requests(id,campaign_id,provider,user_agent,destination_url,source,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)").run('legacy', campaignId, 'meta', 'facebot', 'https://example.org/old', '', new Date(now - 40 * 86400000).toISOString()));
    const reopened = (await openStore(f.folder)); const runtime = new TrafficRuntime(reopened, { networkEnabled: false, clock: () => now });
    await runtime.ready;
    try {
      assert.equal(runtime.intelligence.identify({ requestTarget: '/r/observed', ip: '66.249.66.1', sourceIp: '66.249.66.1', authority: 'socket', userAgent: 'Googlebot/2.1', accept: null, language: null, platformHint: null, edge: { verifiedBot: null, score: null, category: null, ja4: null } }).status, 'verified');
      assert.equal(JSON.parse(String((await reopened.db.prepare("SELECT identity FROM relay.crawler_requests WHERE id!=$1").get('legacy'))!.identity)).revision, 'simulated-common');
    } finally { await runtime.close(); (await reopened.db.close()); }
    // A newer revision must not cause evidence cited by an off-mode route to disappear.
    (await f.store.db.prepare("UPDATE relay.intelligence_revisions SET expires_at=$1 WHERE revision=$2").run(new Date(now - 40 * 86400000).toISOString(), 'simulated-common'));
    (await f.store.db.prepare("INSERT INTO relay.intelligence_revisions VALUES($1,$2,$3,$4,$5,$6)").run('supporting-common', 'common', feedSources.common, new Date(now - 41 * 86400000).toISOString(), new Date(now - 40 * 86400000).toISOString(), '["66.249.68.0/24"]'));
    const routed = (await f.store.db.prepare("SELECT id,identity FROM relay.crawler_requests WHERE identity IS NOT NULL").get())!;
    const proof = JSON.parse(String(routed.identity)); proof.checks.push({ ...proof.checks[0], revision: 'supporting-common', outcome: 'not-matched', match: null });
    (await f.store.db.prepare("UPDATE relay.crawler_requests SET identity=$1 WHERE id=$2").run(JSON.stringify(proof), routed.id));
    (await f.store.db.prepare("INSERT INTO relay.intelligence_revisions VALUES($1,$2,$3,$4,$5,$6)").run('new-common', 'common', feedSources.common, new Date(now + 1).toISOString(), new Date(now + 3600000).toISOString(), '["66.249.67.0/24"]'));
    (await f.runtime.repository.maintain(now)); assert.ok((await f.store.db.prepare("SELECT revision FROM relay.intelligence_revisions WHERE revision=$1").get('simulated-common')));
    assert.ok((await f.store.db.prepare("SELECT revision FROM relay.intelligence_revisions WHERE revision=$1").get('supporting-common')));
    now += 31 * 86400000; (await f.runtime.repository.maintain(now));
    assert.equal((await f.store.db.prepare("SELECT count(*) n FROM relay.crawler_requests WHERE identity IS NOT NULL").get())!.n, 0);
    assert.equal((await f.store.db.prepare("SELECT revision FROM relay.intelligence_revisions WHERE revision=$1").get('simulated-common')), undefined);
    assert.equal((await f.store.db.prepare("SELECT revision FROM relay.intelligence_revisions WHERE revision=$1").get('supporting-common')), undefined);
    assert.equal((await f.store.db.prepare("SELECT identity FROM relay.crawler_requests WHERE id=$1").get('legacy'))!.identity, null);
  } finally { await f.close(); }
});

test('Worker creates an envelope accepted by the real ingress and overwrites forged incoming claims (simulated Cloudflare)', async () => {
  const f = await fixture(); const originalFetch = globalThis.fetch;
  try {
    await f.setup(); await f.api('/traffic/config', { mode: 'observe' }, 'PUT');
    let forwarded: Response | null = null;
    globalThis.fetch = async (input, init) => { const u = new URL(String(input)); forwarded = await originalFetch(f.publicBase + u.pathname + u.search, init); return forwarded; };
    const request = new Request(f.audience + '/r/observed', { headers: { 'user-agent': 'Mozilla/5.0', accept: 'text/html', 'cf-connecting-ip': '8.8.8.8', 'cf-verified-bot': 'true', 'x-relay-envelope': 'forged', 'x-relay-signature': 'forged' } });
    Object.defineProperty(request, 'cf', { value: {} });
    const response = await worker.fetch(request, { PUBLIC_ORIGIN: f.audience, ORIGIN_URL: 'https://origin.example.test', RELAY_EDGE_KEY: f.key, RELAY_EDGE_KEY_ID: 'primary' });
    assert.equal(response.status, 302); const row = (await f.runtime.repository.list({ days: 30, limit: 1, offset: 0 })).items[0]; assert.equal(row.context.edge.verifiedBot, null); assert.equal(row.context.ip, '8.8.8.8');
    assert.equal((await worker.fetch(new Request(f.audience + '/api/bootstrap'), { PUBLIC_ORIGIN: f.audience, ORIGIN_URL: 'https://origin.example.test', RELAY_EDGE_KEY: f.key, RELAY_EDGE_KEY_ID: 'primary' })).status, 404);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});
