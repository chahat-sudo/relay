import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

test('Cloudflare runtime serves authenticated assets and PostgreSQL APIs, and signed public tracking retains rate state (simulated Cloudflare and feeds)', { timeout: 90000 }, async () => {
  const pg = await PGlite.create();
  let socket; let mf;
  const origin = 'https://relay.chahat.workers.dev';
  const password = 'runtime-test-only-password-123456';
  const key = randomBytes(32);
  try {
    await pg.exec(readFileSync(new URL('../supabase/migrations/20261029094245_relay_postgres_storage.sql', import.meta.url), 'utf8'));
    await pg.query('INSERT INTO relay.workspace_state VALUES($1,$2,NULL,$3)', ['default', createHash('sha256').update(key).digest('hex'), new Date().toISOString()]);
    socket = new PGLiteSocketServer({ db: pg, port: 0, host: '127.0.0.1', maxConnections: 5 });
    await socket.start();
    mf = new Miniflare(convertV4MiniflareOptions({ workers: [{
      name: 'relay', modules: true, scriptPath: '.wrangler/test-bundle/app-worker.js', compatibilityDate: '2026-10-01',
      bindings: { RELAY_WORKSPACE_KEY: key.toString('base64'), RELAY_ADMIN_USER: 'owner', RELAY_ADMIN_PASSWORD: password, RELAY_PUBLIC_ORIGIN: origin },
      hyperdrives: { HYPERDRIVE: `postgresql://postgres:postgres@${socket.getServerConn()}/postgres` },
      durableObjects: { BACKEND: { className: 'RelayBackend', useSQLite: true } },
      assets: { directory: 'dist', binding: 'ASSETS', run_worker_first: true, routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true }, assetConfig: { not_found_handling: 'single-page-application' } },
      outboundService: async request => new Response(JSON.stringify(new URL(request.url).pathname.endsWith('/chat/completions') ? { choices: [{ message: { content: JSON.stringify({ title: 'Worker draft', excerpt: 'Runtime verification', body: 'A simulated provider draft for review.' }) } }] } : { prefixes: [{ ipv4Prefix: '66.249.66.0/24' }] }), { headers: { 'Content-Type': 'application/json' } }),
    }], log: new Log(LogLevel.WARN) }));
    const authorization = 'Basic ' + Buffer.from(`owner:${password}`).toString('base64');
    const api = (path, body, method = 'POST', extra = {}) => mf.dispatchFetch(origin + '/api' + path, { method: body === undefined ? 'GET' : method, headers: { authorization, 'Content-Type': 'application/json', 'X-Relay-Request': '1', Origin: origin, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await mf.dispatchFetch(origin + '/')).status, 401);
    assert.equal((await mf.dispatchFetch(origin + '/api/bootstrap')).status, 401);
    assert.equal((await mf.dispatchFetch(origin + '/api/bootstrap', { headers: { authorization: 'Basic Zm9yZ2Vk' } })).status, 401);
    assert.equal((await mf.dispatchFetch('https://other.example/api/bootstrap', { headers: { authorization } })).status, 403);
    const page = await mf.dispatchFetch(origin + '/', { headers: { authorization } });
    assert.equal(page.status, 200); assert.match(await page.text(), /<!doctype html>/i); assert.match(page.headers.get('Cache-Control'), /no-store/);
    const boot = await api('/bootstrap'); assert.equal(boot.status, 200); assert.deepEqual((await boot.json()).campaigns, []);
    assert.equal((await api('/settings', { siteName: 'Worker publication', siteDescription: 'Runtime test', aiBaseUrl: 'https://provider.example/v1', aiModel: 'test-model', apiKey: 'test-provider-credential' }, 'PUT')).status, 200);
    assert.equal((await api('/articles/generate', { topic: 'Runtime test', brief: '' })).status, 200);
    const afterDraft = await (await api('/bootstrap')).json(); assert.equal(afterDraft.articles[0].status, 'draft'); assert.equal(afterDraft.settings.hasApiKey, true); assert.ok(!JSON.stringify(afterDraft).includes('test-provider-credential'));
    const published = await api('/articles', { title: 'Published on Workers', slug: 'worker-article', excerpt: 'A runtime test', body: 'Published text', status: 'published', campaignId: '', cta: '', }); assert.equal(published.status, 200);
    const site = await mf.dispatchFetch(origin + '/site/worker-article'); assert.equal(site.status, 200); assert.match(await site.text(), /Published text/);
    const denied = await api('/destinations', { name: 'Forbidden', url: 'https://example.com', status: 'active', dailyCap: 0 }, 'POST', { Origin: 'https://evil.example' }); assert.equal(denied.status, 403);
    const destination = await api('/destinations', { name: 'Worker destination', url: 'https://example.com/offer', status: 'active', dailyCap: 0 });
    assert.equal(destination.status, 200); const destinationId = (await destination.json()).id;
    const campaign = await api('/campaigns', { name: 'Worker campaign', slug: 'worker-test', source: 'test', status: 'active', costPerClick: 0.25, fallbackId: '', rules: [{ id: 'one', name: 'All visits', source: '', device: '', enabled: true, targets: [{ destinationId, weight: 100 }] }], crawlerRouting: { enabled: true, providers: ['google'], url: 'https://example.com/crawler' } });
    assert.equal(campaign.status, 200);
    const config = await api('/traffic/config', { mode: 'enforce', enforcementApproved: true, requestsPerMinute: 10, highRiskAction: 'throttle' }, 'PUT'); assert.equal(config.status, 200);
    const visit = (method = 'GET', headers = {}) => mf.dispatchFetch(origin + '/r/worker-test', { method, redirect: 'manual', headers: { 'cf-connecting-ip': '8.8.8.8', 'User-Agent': 'Mozilla/5.0', Accept: 'text/html', 'x-relay-envelope': 'forged', 'x-relay-signature': 'forged', ...headers } });
    assert.equal((await visit('HEAD')).status, 200);
    for (let i = 0; i < 10; i++) { const response = await visit(); assert.equal(response.status, 302, await response.text()); assert.match(response.headers.get('Location'), /example.com\/offer\?click_id=/); }
    assert.equal((await visit()).status, 429);
    const report = await api('/summary?days=90'); assert.equal(report.status, 200); const summary = await report.json(); assert.equal(summary.clicks, 10); assert.equal(summary.cost, 2.5);
    const log = await (await api('/traffic/requests')).json(); assert.ok(log.items.every(row => row.context.authority === 'cloudflare-signed' && row.context.ip === '8.8.8.8'));
    const refresh = await api('/traffic/intelligence/refresh', {}); assert.equal(refresh.status, 200); const refreshed = await refresh.json(); assert.ok(refreshed.intelligence.every(feed => feed.fresh), JSON.stringify(refreshed.intelligence));
    const crawler = await visit('GET', { 'cf-connecting-ip': '66.249.66.1', 'User-Agent': 'Googlebot/2.1' }); assert.equal(crawler.status, 302); assert.equal(crawler.headers.get('Location'), 'https://example.com/crawler');
    assert.equal((await (await api('/summary?days=90')).json()).clicks, 10);
    assert.equal((await api('/missing')).status, 404);
    assert.equal((await api('/settings', {}, 'PATCH')).status, 405);
    assert.equal((await api('/summary?days=90')).headers.get('Content-Type').includes('application/json'), true);
  } finally {
    await mf?.dispose(); await socket?.stop(); await pg.close();
  }
});
