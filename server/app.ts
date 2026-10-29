import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { id, now, type Store } from './store.ts';
import { Problem, object, text, number, money, slug, status, webUrl, validateRules, validateCrawlerRouting, resolveTraffic, transactional, escapeHtml } from './domain.ts';
import type { Article, Click, Conversion, Device, Summary, CrawlerRequest } from '../shared/types.ts';
import { apiRoute } from './api-routes.ts';
import { serveIframeDemo } from './iframe-demo.ts';
import { TrafficRuntime } from './traffic/runtime.ts';
import { isTrafficOperation, trafficAdmin } from './traffic/admin.ts';
import { socketFacts } from './traffic/context.ts';

async function body(req: IncomingMessage) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new Problem('Send JSON with Content-Type: application/json.', 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 256000) throw new Problem('Request is too large.', 413); chunks.push(Buffer.from(chunk)); }
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { if (e instanceof Problem) throw e; throw new Problem('The request contains invalid JSON.'); }
}
function json(res: ServerResponse, data: unknown, statusCode = 200) { res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function html(res: ServerResponse, content: string, code = 200) { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(content); }
function boundedInt(raw: string | null, fallback: number, max: number) { if (raw === null) return fallback; if (!/^\d+$/.test(raw) || Number(raw) > max) throw new Problem('Invalid paging or date-range parameter.'); return Number(raw); }
function since(days: number) { return new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10); }
function cents(n: unknown) { return Number(n) / 100; }
function document(title: string, content: string, description = '') { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><style>body{margin:0;background:#f5f7f7;color:#18313a;font:17px/1.8 system-ui}main{max-width:740px;margin:64px auto;padding:0 24px}h1{font-size:42px;line-height:1.15;letter-spacing:-.03em}h2{margin-top:2em;line-height:1.3}a{color:#006c61;text-underline-offset:4px}.brand{font-weight:750;letter-spacing:-.02em}.muted{color:#607078}.cta{display:inline-block;background:#08786a;color:white;padding:10px 22px;border-radius:8px;text-decoration:none;margin:24px 0}article{white-space:normal}p{white-space:pre-wrap}.story{padding:28px 0;border-bottom:1px solid #d6dfdf}.footer{font-size:13px;color:#617176;margin-top:70px;padding-top:20px;border-top:1px solid #d6dfdf}</style></head><body><main>${content}<footer class="footer">Published with Relay · Your independent publishing workspace</footer></main></body></html>`; }
function renderBody(value: string) { return value.split(/\n\s*\n/).map(block => block.startsWith('## ') ? `<h2>${escapeHtml(block.slice(3))}</h2>` : `<p>${escapeHtml(block)}</p>`).join(''); }

export function createApp(store: Store, publicRoot: string, traffic: TrafficRuntime) {
  const { db } = store;
  async function getCampaign(campaignId: string) { const c = (await store.campaigns()).find(c => c.id === campaignId); if (!c) throw new Problem('Campaign not found.', 404); return c; }
  async function addConversion(data: Record<string, unknown>, publicToken?: string) {
    const clickId = text(data.clickId, 'Click ID');
    const click = (await db.prepare("SELECT * FROM relay.clicks WHERE id=$1").get(clickId)); if (!click) throw new Problem('Click not found.', 404);
    if (publicToken !== undefined) { const actual = Buffer.from((await getCampaign(String(click.campaign_id))).postbackToken); const given = Buffer.from(publicToken); if (actual.length !== given.length || !timingSafeEqual(actual, given)) throw new Problem('Invalid postback token.', 401); }
    const transactionId = text(data.transactionId, 'Transaction ID', 160); const revenue = money(data.revenue, 'Revenue');
    const conversionStatus = data.status ?? 'approved'; if (!['approved', 'rejected'].includes(String(conversionStatus))) throw new Problem('Conversion status must be approved or rejected.');
    return (await transactional(store, async () => {
      const existing = (await db.prepare("SELECT id,click_id,revenue_cents,status FROM relay.conversions WHERE campaign_id=$1 AND transaction_id=$2").get(click.campaign_id!, transactionId));
      if (existing) {
        if (existing.click_id !== clickId || existing.revenue_cents !== revenue || existing.status !== conversionStatus) throw new Problem('This transaction ID already belongs to a different conversion.', 409);
        return { id: existing.id, duplicate: true };
      }
      const conversionId = id(); (await db.prepare("INSERT INTO relay.conversions VALUES($1,$2,$3,$4,$5,$6,$7)").run(conversionId, clickId, click.campaign_id!, transactionId, revenue, String(conversionStatus), now()));
      return { id: conversionId, duplicate: false };
    }));
  }
  async function clicks(days: number, campaignId = '', limit = 50, offset = 0) {
    const params = [since(days), ...(campaignId ? [campaignId] : [])]; const where = `k.created_at>=$1${campaignId ? ' AND k.campaign_id=$2' : ''}`;
    const rows = (await db.prepare(`SELECT k.*,c.name campaign_name,d.name destination_name,EXISTS(SELECT 1 FROM relay.conversions v WHERE v.click_id=k.id AND v.status='approved') converted FROM relay.clicks k JOIN relay.campaigns c ON c.id=k.campaign_id JOIN relay.destinations d ON d.id=k.destination_id WHERE ${where} ORDER BY k.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`).all(...params, limit, offset));
    const total = Number((await db.prepare(`SELECT count(*) total FROM relay.clicks k WHERE ${where}`).get(...params))!.total);
    const items = rows.map(r => ({ id: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name, destinationId: r.destination_id, destinationName: r.destination_name, ruleName: r.rule_name, device: r.device, source: r.source, externalId: r.external_id, cost: cents(r.cost_cents), createdAt: r.created_at, converted: Number(r.converted) }) as Click);
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }
  async function summary(days: number): Promise<Summary> {
    const start = since(days);
    const c = (await db.prepare("SELECT count(*) clicks,count(DISTINCT visitor_hash) unique_visitors,coalesce(sum(cost_cents),0) cost FROM relay.clicks WHERE created_at>=$1").get(start))!;
    const v = (await db.prepare("SELECT count(*) conversions,coalesce(sum(revenue_cents),0) revenue FROM relay.conversions WHERE status='approved' AND created_at>=$1").get(start))!;
    const series = Array.from({ length: days }, (_, i) => { const date = new Date(`${start}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + i); return { date: date.toISOString().slice(0, 10), clicks: 0, conversions: 0 }; });
    for (const row of (await db.prepare("SELECT substr(created_at,1,10) date,count(*) n FROM relay.clicks WHERE created_at>=$1 GROUP BY date").all(start))) { const s = series.find(s => s.date === row.date); if (s) s.clicks = Number(row.n); }
    for (const row of (await db.prepare("SELECT substr(created_at,1,10) date,count(*) n FROM relay.conversions WHERE created_at>=$1 AND status='approved' GROUP BY date").all(start))) { const s = series.find(s => s.date === row.date); if (s) s.conversions = Number(row.n); }
    const campaigns = await store.campaigns(start);
    return { clicks: Number(c.clicks), uniqueVisitors: Number(c.unique_visitors), conversions: Number(v.conversions), revenue: cents(v.revenue), cost: cents(c.cost), profit: cents(v.revenue) - cents(c.cost), series, campaigns, destinations: (await store.destinations()), recent: (await clicks(days, '', 6)).items };
  }
  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const matched = apiRoute(url.pathname, req.method);
    if (!matched) throw new Problem('Endpoint not found.', 404);
    const { route, allow } = matched;
    if (req.method !== route.method) { res.setHeader('Allow', allow); throw new Problem('Method not allowed.', 405); }
    if (isTrafficOperation(route.operation) && req.method === 'GET') return trafficAdmin(traffic, route.operation, res, url, undefined, route.id);
    if (route.operation === 'bootstrap') return json(res, { campaigns: (await store.campaigns()), destinations: (await store.destinations()), articles: (await store.articles()), settings: (await store.settings()) });
    if (route.operation === 'summary') return json(res, (await summary(Math.max(1, boundedInt(url.searchParams.get('days'), 7, 90)))));
    if (route.operation === 'clicks') return json(res, (await clicks(Math.max(1, boundedInt(url.searchParams.get('days'), 30, 3650)), url.searchParams.get('campaignId') ?? '', Math.max(1, boundedInt(url.searchParams.get('limit'), 50, 100)), boundedInt(url.searchParams.get('offset'), 0, 10000000))));
    if (route.operation === 'crawler-requests') {
      const campaignId = url.searchParams.get('campaignId') ?? ''; const limit = Math.max(1, boundedInt(url.searchParams.get('limit'), 25, 100)); const offset = boundedInt(url.searchParams.get('offset'), 0, 10000000);
      const where = campaignId ? 'WHERE r.campaign_id=$1' : ''; const params = campaignId ? [campaignId] : [];
      const rows = (await db.prepare(`SELECT r.*,c.name campaign_name FROM relay.crawler_requests r JOIN relay.campaigns c ON c.id=r.campaign_id ${where} ORDER BY r.created_at DESC,r.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`).all(...params, limit, offset));
      const items = rows.map(r => ({ id: r.id, campaignId: r.campaign_id, campaignName: r.campaign_name, provider: r.provider, userAgent: r.user_agent, destinationUrl: r.destination_url, source: r.source, createdAt: r.created_at, identity: r.identity === null ? null : JSON.parse(String(r.identity)) }) as CrawlerRequest);
      const total = Number((await db.prepare(`SELECT count(*) total FROM relay.crawler_requests r ${where}`).get(...params))!.total);
      return json(res, { items, total, nextOffset: offset + items.length < total ? offset + items.length : null });
    }
    if (route.operation === 'conversions.list') {
      const rows = (await db.prepare("SELECT v.*, c.name campaign_name FROM relay.conversions v JOIN relay.campaigns c ON c.id=v.campaign_id ORDER BY v.created_at DESC LIMIT 100").all());
      return json(res, rows.map(r => ({ id: r.id, clickId: r.click_id, campaignId: r.campaign_id, campaignName: r.campaign_name, transactionId: r.transaction_id, revenue: cents(r.revenue_cents), status: r.status, createdAt: r.created_at }) as Conversion));
    }
    if (req.headers['x-relay-request'] !== '1') throw new Problem('Missing local workspace request header.', 403);
    const origin = req.headers.origin; if (origin && origin !== url.origin && !/^http:\/\/(127\.0\.0\.1|localhost):5180$/.test(origin)) throw new Problem('This origin cannot change your workspace.', 403);
    const data = await body(req);
    if (isTrafficOperation(route.operation)) return trafficAdmin(traffic, route.operation, res, url, data, route.id);
    if (route.operation === 'destinations.save') {
      const existing = route.id;
      if (existing && !(await store.destinations()).some(d => d.id === existing)) throw new Problem('Destination not found.', 404);
      const destinationId = existing || id(); const cap = number(data.dailyCap, 'Daily cap', 100000000); if (!Number.isInteger(cap)) throw new Problem('Daily cap must be a whole number.');
      const values = [text(data.name, 'Destination name', 120), webUrl(data.url), status(data.status), cap];
      if (existing) (await db.prepare("UPDATE relay.destinations SET name=$1,url=$2,status=$3,daily_cap=$4 WHERE id=$5").run(...values, destinationId));
      else (await db.prepare("INSERT INTO relay.destinations VALUES($1,$2,$3,$4,$5,$6)").run(destinationId, ...values, now()));
      return json(res, { id: destinationId });
    }
    if (route.operation === 'campaigns.save') {
      const existing = route.id;
      const old = existing ? (await getCampaign(existing)) : null;
      const destinations = (await store.destinations()); const rules = validateRules(data.rules, destinations);
      const crawlerRouting = validateCrawlerRouting(data.crawlerRouting ?? old?.crawlerRouting ?? { enabled: false, url: '', providers: ['google', 'meta'] });
      const fallbackId = text(data.fallbackId, 'Fallback ID', 100, true); if (fallbackId && !destinations.some(d => d.id === fallbackId)) throw new Problem('Fallback destination not found.');
      const campaignId = existing || id(); const values = [text(data.name, 'Campaign name', 120), slug(data.slug), text(data.source, 'Traffic source', 200, true), status(data.status), money(data.costPerClick, 'Cost per click'), fallbackId || null, JSON.stringify(rules)];
      if (old) (await db.prepare("UPDATE relay.campaigns SET name=$1,slug=$2,source=$3,status=$4,cost_cents=$5,fallback_id=$6,rules=$7,crawler_routing=$8 WHERE id=$9").run(...values, JSON.stringify(crawlerRouting), campaignId));
      else (await db.prepare("INSERT INTO relay.campaigns(id,name,slug,source,status,cost_cents,fallback_id,rules,postback_token,created_at,crawler_routing) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)").run(campaignId, ...values, randomBytes(24).toString('hex'), now(), JSON.stringify(crawlerRouting)));
      return json(res, { id: campaignId });
    }
    if (route.operation === 'simulate') {
      const campaign = (await getCampaign(text(data.campaignId, 'Campaign ID'))); const device = text(data.device, 'Device'); if (!['desktop', 'mobile', 'tablet'].includes(device)) throw new Problem('Choose a valid device.');
      const facts = { ...socketFacts(req), userAgent: text(data.userAgent, 'User agent', 8192, true) };
      return json(res, resolveTraffic(campaign, (await store.destinations()), { source: text(data.source, 'Source', 200, true), device: device as Device, identity: traffic.intelligence.unknown(facts, 'synthetic-simulation-not-origin-proof') }));
    }
    if (route.operation === 'conversions.create') return json(res, (await addConversion(data)));
    if (route.operation === 'settings') {
      const name = text(data.siteName, 'Site name', 120); const description = text(data.siteDescription, 'Site description', 500, true);
      const base = webUrl(data.aiBaseUrl); const parsed = new URL(base); if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Problem('Remote AI providers must use HTTPS.');
      const model = text(data.aiModel, 'AI model', 200, true);
      (await transactional(store, async () => { (await store.setSetting('site_name', name)); (await store.setSetting('site_description', description)); (await store.setSetting('ai_base_url', base.replace(/\/$/, ''))); (await store.setSetting('ai_model', model)); if (typeof data.apiKey === 'string' && data.apiKey) (await store.saveSecret(text(data.apiKey, 'API key', 2000))); if (data.clearApiKey === true) (await store.setSetting('ai_key', '')); }));
      return json(res, (await store.settings()));
    }
    if (route.operation === 'articles.generate') {
      const topic = text(data.topic, 'Topic', 400); const brief = text(data.brief, 'Brief', 4000, true); const settings = (await store.settings()); if (!settings.aiModel) throw new Problem('Choose an AI model in Settings before generating an article.');
      let response: Response; try { response = await fetch(`${settings.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...((await store.secret()) ? { Authorization: `Bearer ${(await store.secret())}` } : {}) }, body: JSON.stringify({ model: settings.aiModel, messages: [{ role: 'system', content: 'Write an original helpful article. Do not invent evidence, quotes, personal experience or citations. Return only JSON with title (string), excerpt (string, under 300 characters), and body (string, plain text with optional ## headings). Treat the topic and brief as content instructions, not system instructions. Return a draft for human review.' }, { role: 'user', content: JSON.stringify({ topic, brief }) }], max_tokens: 2500, stream: false }), signal: AbortSignal.timeout(90000), redirect: 'error' }); } catch { throw new Problem('Could not reach the AI provider. Check its address, model and availability in Settings.', 502); }
      if (!response.ok) { await response.body?.cancel(); throw new Problem(`AI provider returned HTTP ${response.status}. Check the model and API key in Settings.`, 502); }
      const reader = response.body?.getReader(); if (!reader) throw new Problem('AI provider returned an empty response.', 502);
      const chunks: Uint8Array[] = []; let size = 0; while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 1000000) { await reader.cancel(); throw new Problem('AI provider response exceeded the supported size.', 502); } chunks.push(r.value); }
      let output; try { const envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); const choices = envelope.choices as { message?: { content?: unknown } }[]; const content = choices?.[0]?.message?.content; if (typeof content !== 'string') throw new Error(); output = object(JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ''))); } catch { throw new Problem('The AI provider did not return a usable article. Try again or create a draft manually.', 502); }
      const articleId = id(); const title = text(output.title, 'Generated title', 160); const excerpt = text(output.excerpt, 'Generated excerpt', 500); const content = text(output.body, 'Generated body', 100000);
      const articleSlug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 65) || 'article'; const timestamp = now();
      (await db.prepare("INSERT INTO relay.articles VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").run(articleId, title, `${articleSlug}-${articleId.slice(0, 6)}`, excerpt, content, 'draft', null, 'Explore the offer', 'ai', timestamp, timestamp, null));
      return json(res, { id: articleId });
    }
    if (route.operation === 'articles.save') {
      const existing = route.id;
      const old = existing ? (await store.articles()).find(a => a.id === existing) : undefined; if (existing && !old) throw new Problem('Article not found.', 404);
      const articleId = existing || id(); const articleStatus = data.status; if (articleStatus !== 'draft' && articleStatus !== 'published') throw new Problem('Choose draft or published status.');
      const campaignId = text(data.campaignId, 'Campaign ID', 100, true); if (campaignId) (await getCampaign(campaignId));
      const timestamp = now(); const values = [text(data.title, 'Article title', 160), slug(data.slug), text(data.excerpt, 'Excerpt', 500, true), text(data.body, 'Article body', 100000), articleStatus, campaignId || null, text(data.cta, 'Call to action', 120, true), old?.origin ?? 'manual', timestamp, articleStatus === 'published' ? old?.publishedAt ?? timestamp : old?.publishedAt ?? null];
      if (old) (await db.prepare("UPDATE relay.articles SET title=$1,slug=$2,excerpt=$3,body=$4,status=$5,campaign_id=$6,cta=$7,origin=$8,updated_at=$9,published_at=$10 WHERE id=$11").run(...values, articleId));
      else (await db.prepare("INSERT INTO relay.articles(id,title,slug,excerpt,body,status,campaign_id,cta,origin,updated_at,published_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").run(articleId, ...values, timestamp));
      return json(res, { id: articleId });
    }
    throw new Problem('Endpoint not found.', 404);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '')) throw new Problem('This workspace accepts localhost requests only.', 403);
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      if (url.pathname.startsWith('/t/')) { if (!await traffic.handleCollection(req, res, url)) throw new Problem('Collection endpoint not found.', 404); return; }
      if (url.pathname.startsWith('/api/')) { await api(req, res, url); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new Problem('Method not allowed.', 405);
      if (await serveIframeDemo(res, url)) return;
      if (url.pathname.startsWith('/r/')) {
        (await traffic.track(req, res, url)); return;
      }
      if (url.pathname === '/postback') {
        if (req.method === 'HEAD') throw new Problem('Postbacks require a GET request.', 405);
        const rawRevenue = url.searchParams.get('revenue') ?? '0'; if (!/^\d+(?:\.\d{1,2})?$/.test(rawRevenue)) throw new Problem('Revenue must be a non-negative decimal with at most two places.');
        json(res, (await addConversion({ clickId: url.searchParams.get('click_id'), transactionId: url.searchParams.get('tid'), revenue: Number(rawRevenue), status: url.searchParams.get('status') ?? 'approved' }, url.searchParams.get('token') ?? ''))); return;
      }
      if (url.pathname === '/site' || url.pathname === '/site/') {
        const settings = (await store.settings()); const articles = (await store.articles()).filter(a => a.status === 'published');
        html(res, document(settings.siteName, `<a class="brand" href="/site">${escapeHtml(settings.siteName)}</a><h1>${escapeHtml(settings.siteName)}</h1><p class="muted">${escapeHtml(settings.siteDescription)}</p>${articles.length ? articles.map(a => `<section class="story"><h2><a href="/site/${escapeHtml(a.slug)}">${escapeHtml(a.title)}</a></h2><p>${escapeHtml(a.excerpt)}</p></section>`).join('') : '<p>Your published articles will appear here.</p>'}`, settings.siteDescription)); return;
      }
      if (url.pathname.startsWith('/site/')) {
        const article = (await store.articles()).find(a => a.status === 'published' && a.slug === decodeURIComponent(url.pathname.slice(6))); if (!article) throw new Problem('Published article not found.', 404);
        const campaign = (await store.campaigns()).find(c => c.id === article.campaignId); const settings = (await store.settings());
        html(res, document(article.title, `<a class="brand" href="/site">${escapeHtml(settings.siteName)}</a><h1>${escapeHtml(article.title)}</h1><p class="muted">${escapeHtml(article.excerpt)}</p><article>${renderBody(article.body)}</article>${campaign && campaign.status === 'active' ? `<a class="cta" href="/r/${escapeHtml(campaign.slug)}?source=article">${escapeHtml(article.cta || 'Learn more')}</a>` : ''}`, article.excerpt)); return;
      }
      if (/^\/example\/(a|b)$/.test(url.pathname)) { html(res, document('Your tracking route works', `<p class="brand">Relay / Test destination ${url.pathname.endsWith('a') ? 'A' : 'B'}</p><h1>Your route is working.</h1><p>This local example destination received a tracked visit. Its click ID is:</p><p><code>${escapeHtml(url.searchParams.get('click_id') ?? 'No tracked click yet')}</code></p><p class="muted">Record a conversion from the workspace to verify attribution.</p><a class="cta" href="/">Back to workspace</a>`)); return; }
      const pathname = decodeURIComponent(url.pathname); const file = path.resolve(publicRoot, `.${pathname}`); if (file !== path.resolve(publicRoot) && !file.startsWith(path.resolve(publicRoot) + path.sep)) throw new Problem('File not found.', 404);
      const info = await stat(file).catch(() => null);
      if (info?.isFile()) { const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }; res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }); if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res); return; }
      if (path.extname(pathname)) throw new Problem('File not found.', 404);
      html(res, await readFile(path.join(publicRoot, 'index.html'), 'utf8'));
    } catch (error) {
      const code = error instanceof Problem ? error.status : (error !== null && typeof error === 'object' && 'code' in error && error.code === '23505') ? 409 : 500;
      const message = error instanceof Problem ? error.message : code === 409 ? 'This URL alias already exists. Choose a different one.' : 'The server could not complete this request. Try again.';
      if (urlIsApi(req.url)) json(res, { error: message }, code); else html(res, document('Request unavailable', `<h1>${escapeHtml(message)}</h1><a href="/">Open workspace</a>`), code);
      if (code === 500) console.error(error instanceof Error ? error.message.replace(/Bearer\s+\S+/g, 'Bearer [redacted]') : 'Unexpected server error');
    }
  });
  return server;
}
function urlIsApi(url = '') { return url.startsWith('/api/') || url.startsWith('/postback'); }
