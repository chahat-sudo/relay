import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openStore } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { chooseRoute, validateRules, money } from '../server/domain.ts';
import type { Campaign, Bootstrap, Summary } from '../shared/types.ts';

async function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), 'relay-test-')); const store = openStore(folder); const server = createApp(store, path.join(folder, 'public'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test port'); const base = `http://127.0.0.1:${address.port}`;
  async function req<T = Record<string, unknown>>(url: string, data?: unknown, method = 'POST') { const response = await fetch(base + url, data === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json', 'X-Relay-Request': '1' }, body: JSON.stringify(data) }); return { status: response.status, data: await response.json() as T }; }
  const destination = async (name: string, dailyCap = 0) => (await req<{ id: string }>('/api/destinations', { name, url: 'https://example.com/offer', status: 'active', dailyCap })).data.id;
  async function campaign(a: string, b?: string) { const r = await req<{ id: string }>('/api/campaigns', { name: 'Test campaign', slug: 'test-route', source: 'newsletter', status: 'active', costPerClick: 0.25, fallbackId: b ?? '', rules: [{ id: 'rule-one', name: 'Primary split', source: '', device: '', enabled: true, targets: [{ destinationId: a, weight: 70 }, ...(b ? [{ destinationId: b, weight: 30 }] : [])] }] }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.id; }
  async function close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.db.close(); const resolved = path.resolve(folder); assert.equal(path.dirname(resolved), path.resolve(tmpdir())); assert.ok(path.basename(resolved).startsWith('relay-test-')); rmSync(resolved, { recursive: true }); }
  return { folder, store, server, base, req, destination, campaign, close };
}

test('real click → attribution → idempotent conversion → reports, with cap fallback', async () => {
  const f = await fixture(); try {
    const a = await f.destination('Primary', 1); const b = await f.destination('Fallback'); const campaignId = await f.campaign(a, b);
    const c = f.store.campaigns()[0]; c.rules[0].targets = [{ destinationId: a, weight: 100 }]; await f.req(`/api/campaigns/${campaignId}`, c, 'PUT');
    const first = await fetch(`${f.base}/r/test-route?source=paid&external_id=original`, { redirect: 'manual', headers: { 'User-Agent': 'Example Mobile' } }); assert.equal(first.status, 302); const target = new URL(first.headers.get('location')!); const clickId = target.searchParams.get('click_id')!; assert.ok(clickId); assert.equal(target.hostname, 'example.com');
    const second = await fetch(`${f.base}/r/test-route`, { redirect: 'manual' }); assert.equal(second.status, 302); const logged = (await f.req<{ items: { destinationId: string; ruleName: string }[] }>('/api/clicks')).data; assert.equal(logged.items.length, 2); assert.ok(logged.items.some(k => k.destinationId === b && k.ruleName === 'Fallback'));
    const conversion = { clickId, transactionId: 'order-123', revenue: 12.5, status: 'approved' }; assert.equal((await f.req('/api/conversions', conversion)).data.duplicate, false); assert.equal((await f.req('/api/conversions', conversion)).data.duplicate, true); assert.equal((await f.req('/api/conversions', { ...conversion, revenue: 13 })).status, 409);
    const report = (await f.req<Summary>('/api/summary?days=7')).data; assert.equal(report.clicks, 2); assert.equal(report.conversions, 1); assert.equal(report.revenue, 12.5); assert.equal(report.cost, .5); assert.equal(report.profit, 12); assert.equal(report.series.reduce((s, r) => s + r.clicks, 0), 2);
    const bad = await f.req(`/postback?click_id=${clickId}&tid=second&revenue=1&token=wrong`); assert.equal(bad.status, 401);
    const good = await f.req(`/postback?click_id=${clickId}&tid=second&revenue=1&token=${c.postbackToken}`); assert.equal(good.status, 200);
    await f.req(`/api/campaigns/${campaignId}`, { ...c, status: 'paused' }, 'PUT'); assert.equal((await fetch(`${f.base}/r/test-route`, { redirect: 'manual' })).status, 410);
  } finally { await f.close(); }
});

test('simulation does not record events; selection, filters and payload validation are explicit', async () => {
  const f = await fixture(); try {
    const a = await f.destination('A'); const b = await f.destination('B'); const campaignId = await f.campaign(a, b); const c = f.store.campaigns()[0]; const ds = f.store.destinations();
    assert.equal(chooseRoute(c, ds, { source: '', device: 'desktop' }, () => 0).destination.id, a); assert.equal(chooseRoute(c, ds, { source: '', device: 'desktop' }, () => 99).destination.id, b);
    c.rules[0].device = 'mobile'; c.rules[0].source = 'paid'; assert.equal(chooseRoute(c, ds, { source: 'other', device: 'mobile' }, () => 0).fallback, true);
    const sim = await f.req('/api/simulate', { campaignId, source: '', device: 'desktop' }); assert.equal(sim.status, 200); assert.equal((await f.req<Summary>('/api/summary')).data.clicks, 0);
    assert.throws(() => money(-1, 'Revenue')); assert.throws(() => money(.001, 'Cost')); assert.throws(() => validateRules([{ ...c.rules[0], targets: [{ destinationId: a, weight: 1 }, { destinationId: a, weight: 2 }] }], ds));
    const response = await fetch(`${f.base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(response.status, 403);
    const invalid = await f.req('/api/destinations', { name: 'Invalid', url: 'javascript:alert(1)', status: 'active', dailyCap: 0 }); assert.equal(invalid.status, 400);
  } finally { await f.close(); }
});

test('articles stay private as drafts; published text is escaped and campaign CTA is tracked', async () => {
  const f = await fixture(); try {
    const a = await f.destination('A'); const campaignId = await f.campaign(a); const article = { title: 'Original article', slug: 'original-article', excerpt: 'Helpful introduction', body: 'Hello <script>alert(1)</script>\n\n## A heading\n\nUseful facts.', status: 'draft', campaignId, cta: 'Read the offer' };
    const made = await f.req<{ id: string }>('/api/articles', article); assert.equal(made.status, 200); assert.equal((await fetch(`${f.base}/site/original-article`)).status, 404);
    await f.req(`/api/articles/${made.data.id}`, { ...article, status: 'published' }, 'PUT'); const published = await fetch(`${f.base}/site/original-article`); const html = await published.text(); assert.equal(published.status, 200); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>')); assert.ok(html.includes('/r/test-route?source=article')); assert.ok(html.includes('<h2>A heading</h2>'));
    await f.req(`/api/articles/${made.data.id}`, { ...article, status: 'draft' }, 'PUT'); assert.equal((await fetch(`${f.base}/site/original-article`)).status, 404);
    const reopened = openStore(f.folder); assert.equal(reopened.articles().length, 1); reopened.db.close();
  } finally { await f.close(); }
});

test('AI adapter saves a reviewable draft; provider key is not returned by the API (simulated provider)', async () => {
  const f = await fixture(); let received = false;
  const provider = http.createServer(async (req, res) => { let body = ''; for await (const part of req) body += part; received = JSON.parse(body).model === 'test-model' && req.headers.authorization === 'Bearer test-provider-key'; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'Generated draft', excerpt: 'A test draft.', body: 'Review this generated content.' }) } }] })); });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve)); const port = (provider.address() as { port: number }).port;
  try {
    const updated = await f.req('/api/settings', { siteName: 'My publication', siteDescription: 'Original writing', aiBaseUrl: `http://127.0.0.1:${port}/v1`, aiModel: 'test-model', apiKey: 'test-provider-key' }, 'PUT'); assert.equal(updated.status, 200); assert.ok(!JSON.stringify(updated.data).includes('test-provider-key'));
    const result = await f.req('/api/articles/generate', { topic: 'Test topic', brief: 'Use the adapter.' }); assert.equal(result.status, 200); assert.ok(received); const boot = (await f.req<Bootstrap>('/api/bootstrap')).data; assert.equal(boot.articles[0].status, 'draft'); assert.equal(boot.articles[0].origin, 'ai'); assert.equal(boot.settings.hasApiKey, true); assert.ok(!JSON.stringify(boot).includes('test-provider-key')); assert.ok(!String(f.store.db.prepare("SELECT value FROM settings WHERE key='ai_key'").get()?.value).includes('test-provider-key'));
  } finally { provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); await f.close(); }
});

test('campaign crawler URL is configurable, simulated and logged separately without visitor cost or identity', async () => {
  const f = await fixture(); try {
    const a = await f.destination('Offer'); const campaignId = await f.campaign(a);
    const original = f.store.campaigns()[0]; const crawlerUrl = 'https://example.org/crawler-page?ref=one';
    const config = { ...original, crawlerRouting: { enabled: true, url: crawlerUrl, providers: ['google', 'meta'] } };
    assert.equal((await f.req(`/api/campaigns/${campaignId}`, config, 'PUT')).status, 200);
    const simulated = await f.req('/api/simulate', { campaignId, source: 'ads', device: 'desktop', userAgent: 'AdsBot-Google (+http://www.google.com/adsbot.html)' });
    assert.equal(simulated.data.kind, 'crawler'); assert.equal(simulated.data.evidence, 'user-agent-only'); assert.equal(simulated.data.url, crawlerUrl);
    assert.equal((await f.req<{ total: number }>('/api/crawler-requests')).data.total, 0);
    for (const ua of ['AdsBot-Google (+http://www.google.com/adsbot.html)', 'facebookexternalhit/1.1']) {
      const response = await fetch(`${f.base}/r/test-route?source=ads`, { redirect: 'manual', headers: { 'User-Agent': ua } });
      assert.equal(response.status, 302); assert.equal(response.headers.get('location'), crawlerUrl); assert.equal(response.headers.get('set-cookie'), null); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('vary'), 'User-Agent');
    }
    const log = (await f.req<{ items: { provider: string; userAgent: string; destinationUrl: string }[]; total: number }>('/api/crawler-requests')).data;
    assert.equal(log.total, 2); assert.deepEqual(log.items.map(r => r.provider).sort(), ['google', 'meta']); assert.ok(log.items.every(r => r.destinationUrl === crawlerUrl));
    const report = (await f.req<Summary>('/api/summary')).data; assert.equal(report.clicks, 0); assert.equal(report.cost, 0); assert.equal(report.uniqueVisitors, 0); assert.equal(f.store.destinations()[0].clicksToday, 0);
    const head = await fetch(`${f.base}/r/test-route`, { method: 'HEAD', headers: { 'User-Agent': 'Googlebot/2.1' } }); assert.equal(head.status, 200); assert.equal((await f.req<{ total: number }>('/api/crawler-requests')).data.total, 2);
    const ordinary = await fetch(`${f.base}/r/test-route`, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 Chrome/130.0' } }); assert.equal(ordinary.status, 302); assert.ok(new URL(ordinary.headers.get('location')!).searchParams.has('click_id'));
    assert.equal((await f.req<Summary>('/api/summary')).data.clicks, 1);
    const { crawlerRouting: omitted, ...legacy } = f.store.campaigns()[0];
    assert.equal((await f.req(`/api/campaigns/${campaignId}`, { ...legacy, name: 'Legacy client update' }, 'PUT')).status, 200); assert.equal(f.store.campaigns()[0].crawlerRouting.enabled, true);
    const current = f.store.campaigns()[0];
    assert.equal((await f.req(`/api/campaigns/${campaignId}`, { ...current, crawlerRouting: { ...current.crawlerRouting, url: 'javascript:alert(1)' } }, 'PUT')).status, 400);
    assert.equal((await f.req(`/api/campaigns/${campaignId}`, { ...current, crawlerRouting: { ...current.crawlerRouting, providers: [] } }, 'PUT')).status, 400);
    await f.req(`/api/campaigns/${campaignId}`, { ...current, status: 'paused' }, 'PUT');
    assert.equal((await fetch(`${f.base}/r/test-route`, { redirect: 'manual', headers: { 'User-Agent': 'Googlebot/2.1' } })).status, 410); assert.equal((await f.req<{ total: number }>('/api/crawler-requests')).data.total, 2);
  } finally { await f.close(); }
});

test('disabled or unselected crawler overrides use visitor rules and near-matching tokens do not match', async () => {
  const f = await fixture(); try {
    const a = await f.destination('Offer'); const campaignId = await f.campaign(a); const original = f.store.campaigns()[0];
    const config = { ...original, crawlerRouting: { enabled: false, url: 'https://example.org/crawler', providers: ['google'] } };
    await f.req(`/api/campaigns/${campaignId}`, config, 'PUT');
    const simulate = (userAgent: string) => f.req('/api/simulate', { campaignId, source: '', device: 'desktop', userAgent });
    assert.equal((await simulate('Googlebot/2.1')).data.kind, 'visitor');
    await f.req(`/api/campaigns/${campaignId}`, { ...config, crawlerRouting: { ...config.crawlerRouting, enabled: true } }, 'PUT');
    assert.equal((await simulate('facebookexternalhit/1.1')).data.kind, 'visitor');
    assert.equal((await simulate('NotGooglebot/2.1')).data.kind, 'visitor');
    assert.equal((await simulate('Mozilla/5.0 Google Chrome/130.0')).data.kind, 'visitor');
    assert.equal((await simulate('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).data.kind, 'crawler');
    const reopened = openStore(f.folder); assert.deepEqual(reopened.campaigns()[0].crawlerRouting, { enabled: true, url: 'https://example.org/crawler', providers: ['google'] }); reopened.db.close();
  } finally { await f.close(); }
});

test('v1 upgrade preserves records, creates an original-state backup, and is idempotent', async () => {
  const f = await fixture(); try {
    const a = await f.destination('Existing offer'); const campaignId = await f.campaign(a);
    await fetch(`${f.base}/r/test-route`, { redirect: 'manual' });
    f.store.db.exec('DROP TABLE crawler_requests; ALTER TABLE campaigns DROP COLUMN crawler_routing; PRAGMA user_version=1;');
    const upgraded = openStore(f.folder);
    assert.equal(upgraded.campaigns()[0].id, campaignId); assert.equal(upgraded.campaigns()[0].clicks, 1); assert.equal(upgraded.campaigns()[0].crawlerRouting.enabled, false); assert.equal(upgraded.destinations()[0].id, a);
    const backups = readdirSync(f.folder).filter(p => /^backup-before-crawler-.*\.sqlite$/.test(p)); assert.equal(backups.length, 1);
    const snapshot = new DatabaseSync(path.join(f.folder, backups[0]), { readOnly: true }); assert.equal(snapshot.prepare('PRAGMA user_version').get()!.user_version, 1); assert.equal(snapshot.prepare('SELECT count(*) n FROM clicks').get()!.n, 1); assert.ok(!snapshot.prepare('PRAGMA table_info(campaigns)').all().some(c => c.name === 'crawler_routing')); snapshot.close(); upgraded.db.close();
    const again = openStore(f.folder); assert.equal(again.campaigns()[0].id, campaignId); assert.equal(readdirSync(f.folder).filter(p => /^backup-before-crawler-.*\.sqlite$/.test(p)).length, 1); again.db.close();
  } finally { await f.close(); }
});

test('API method contracts reject unsupported operations before reading bodies or changing records', async () => {
  const f = await fixture(); try {
    const a = await f.destination('Original destination'); const campaignId = await f.campaign(a);
    const article = await f.req<{ id: string }>('/api/articles', { title: 'Original', slug: 'original', excerpt: '', body: 'Draft text', status: 'draft', campaignId: '', cta: '' });
    const before = (await f.req<Bootstrap>('/api/bootstrap')).data;
    const cases: [string, string, string][] = [
      ['/api/destinations', 'PATCH', 'POST'], ['/api/campaigns', 'PATCH', 'POST'], ['/api/articles', 'PATCH', 'POST'],
      [`/api/destinations/${a}`, 'POST', 'PUT'], [`/api/campaigns/${campaignId}`, 'PATCH', 'PUT'], [`/api/articles/${article.data.id}`, 'POST', 'PUT'],
      ['/api/articles/generate', 'PUT', 'POST'], ['/api/settings', 'POST', 'PUT'], ['/api/simulate', 'GET', 'POST'],
      ['/api/bootstrap', 'POST', 'GET'], ['/api/summary', 'PUT', 'GET'], ['/api/clicks', 'DELETE', 'GET'],
      ['/api/crawler-requests', 'POST', 'GET'], ['/api/conversions', 'PUT', 'GET, POST'],
    ];
    for (const [endpoint, method, allow] of cases) {
      // Invalid JSON and no write header must not hide an unsupported method.
      const response = await fetch(f.base + endpoint, { method, ...(method === 'GET' ? {} : { body: '{' }) });
      assert.equal(response.status, 405, `${method} ${endpoint}`);
      assert.equal(response.headers.get('allow'), allow);
      assert.equal((await response.json()).error, 'Method not allowed.');
    }
    const unknown = await fetch(f.base + '/api/unknown', { method: 'POST', body: '{' });
    assert.equal(unknown.status, 404); assert.equal(unknown.headers.get('allow'), null);
    assert.deepEqual((await f.req<Bootstrap>('/api/bootstrap')).data, before);
  } finally { await f.close(); }
});

test('simultaneous visits honor shared daily caps and simultaneous postback retries create one conversion', async () => {
  const f = await fixture(); try {
    const primary = await f.destination('Capped primary', 3); const fallback = await f.destination('Fallback');
    const campaignId = await f.campaign(primary, fallback); const c = f.store.campaigns()[0];
    c.rules[0].targets = [{ destinationId: primary, weight: 100 }];
    assert.equal((await f.req(`/api/campaigns/${campaignId}`, c, 'PUT')).status, 200);
    const visits = await Promise.all(Array.from({ length: 20 }, () => fetch(f.base + '/r/test-route', { redirect: 'manual' })));
    assert.ok(visits.every(r => r.status === 302));
    const destinations = f.store.destinations();
    assert.equal(destinations.find(d => d.id === primary)!.clicksToday, 3);
    assert.equal(destinations.find(d => d.id === fallback)!.clicksToday, 17);
    const clickId = new URL(visits[0].headers.get('location')!).searchParams.get('click_id')!;
    const postback = `/postback?click_id=${clickId}&tid=parallel-order&revenue=8.25&token=${c.postbackToken}`;
    const retries = await Promise.all(Array.from({ length: 12 }, () => f.req(postback)));
    assert.ok(retries.every(r => r.status === 200));
    assert.equal(retries.filter(r => r.data.duplicate === false).length, 1);
    assert.equal(retries.filter(r => r.data.duplicate === true).length, 11);
    const report = (await f.req<Summary>('/api/summary')).data;
    assert.equal(report.clicks, 20); assert.equal(report.conversions, 1); assert.equal(report.revenue, 8.25); assert.equal(report.cost, 5);
  } finally { await f.close(); }
});
