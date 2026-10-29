import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store.ts';
import { Problem, chooseRoute, deviceFrom, escapeHtml, resolveTraffic, transactional } from '../domain.ts';
import type { Assessment, BrowserFacts, IdentityEvidence, RequestFacts, TrafficConfig, TrafficStatus } from '../../shared/traffic.ts';
import { EdgeVerifier, socketFacts, type EdgeOptions } from './context.ts';
import { Intelligence, type IntelligenceOptions } from './intelligence.ts';
import { assess } from './classify.ts';
import { hash, trafficRepository, type StoredRequest } from './repository.ts';
import { contains, isPublic, parseIp, parseNetwork, type Network } from './ip.ts';
import { parseBrowser } from './validation.ts';
import { collectorScript } from './collector.ts';
import { publicRoute } from '../../shared/public-routes.ts';

export interface TrafficRuntimeOptions extends IntelligenceOptions { edge?: EdgeOptions; }
function cookie(req: IncomingMessage, name: string) { return String(req.headers.cookie ?? '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='))?.slice(name.length + 1) ?? ''; }
export function responseJson(res: ServerResponse, data: unknown, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
export async function readPublicBody(req: IncomingMessage) {
  if (Number(req.headers['content-length']) > 32768) throw new Problem('Collection payload exceeds the 32 KiB budget.', 413);
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { length += chunk.length; if (length > 32768) throw new Problem('Collection payload exceeds the 32 KiB budget.', 413); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
function html(res: ServerResponse, title: string, body: string, code = 200) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font:17px/1.6 system-ui;background:#f4f6f7;color:#173139;margin:0}main{max-width:560px;margin:12vh auto;padding:28px}button{background:#087b6b;color:white;border:0;padding:14px 24px;border-radius:7px;font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #173139;outline-offset:4px}h1{line-height:1.2}a{color:#087b6b}</style></head><body><main>${body}</main></body></html>`);
}
export class TrafficRuntime {
  readonly repository;
  readonly intelligence;
  readonly edge: EdgeVerifier | null;
  private clock: () => number;
  private rates = new Map<string, { start: number; count: number }>();
  private nextRatePrune = 0;
  private compiledPolicy: TrafficConfig | null = null;
  private networks: { network: Network; kind: 'deny' | 'hosting' | 'proxy' }[] = [];
  private jobs = new Set<Promise<void>>();
  private closed = false;
  private closing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval>;
  readonly store: Store;
  readonly options: TrafficRuntimeOptions;
  constructor(store: Store, options: TrafficRuntimeOptions = {}) {
    this.store = store; this.options = options;
    this.repository = trafficRepository(store); this.clock = options.clock ?? Date.now;
    this.intelligence = new Intelligence(store, options); this.edge = options.edge ? new EdgeVerifier(options.edge, this.clock) : null;
    this.timer = setInterval(() => { if (!this.closed) this.background(this.maintain()); }, 60000); this.timer.unref();
  }
  get ready() { return this.intelligence.ready; }
  private async maintain() {
    const config = await this.repository.config();
    if (this.closed || (config.mode === 'off' && !await this.store.db.prepare("SELECT 1 FROM relay.campaigns WHERE status='active' AND (crawler_routing::jsonb->>'enabled')='true' LIMIT 1").get())) return;
    await this.repository.maintain(this.clock());
    if (!this.closed) await this.intelligence.refresh();
  }
  async status(): Promise<TrafficStatus> {
    return { config: (await this.repository.config()), intelligence: this.intelligence.status(), publicIngress: { configured: this.edge !== null, audience: this.options.edge?.audience ?? null }, model: { state: 'not-trained', reason: 'Runtime inference is disabled. Independent labels and a passing offline evaluation are required.' } };
  }
  private background(work: Promise<unknown>) {
    const job = work.then(() => {}, error => { if (!this.closed) console.error('Traffic background work failed:', error instanceof Error ? error.message : 'unknown failure'); }).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
  }
  private networkKinds(facts: RequestFacts, config: TrafficConfig) {
    if (this.compiledPolicy !== config) {
      this.networks = config.networks.map(n => { const p = parseNetwork(n.cidr); if (!p.ok) throw new Problem('Stored network rule is invalid.', 503); return { network: p.value, kind: n.kind }; }); this.compiledPolicy = config;
    }
    const ip = parseIp(facts.ip); return ip.ok ? this.networks.filter(n => contains(n.network, ip.value)).map(n => n.kind) : [];
  }
  assessment(facts: RequestFacts, config: TrafficConfig, rate: number | null, browser: BrowserFacts | null = null, identity = this.intelligence.identify(facts)): Assessment {
    return assess(facts, identity, config, rate, browser, this.clock(), this.networkKinds(facts, config));
  }
  private rate(facts: RequestFacts, req: IncomingMessage) {
    const ip = parseIp(facts.ip); const visitor = cookie(req, 'relay_visitor');
    const identifier = ip.ok && isPublic(ip.value) ? `ip:${ip.value.text}` : /^[a-f0-9]{32}$/.test(visitor) ? `cookie:${visitor}` : null;
    if (!identifier) return { key: randomUUID(), count: null };
    const key = createHmac('sha256', this.store.key).update(identifier).digest('hex'); const now = this.clock();
    if (now >= this.nextRatePrune || this.rates.size >= 8192) { for (const [k, v] of this.rates) if (v.start + 60000 <= now) this.rates.delete(k); this.nextRatePrune = now + 1000; }
    let entry = this.rates.get(key); if (entry && entry.start + 60000 <= now) { this.rates.delete(key); entry = undefined; }
    if (!entry) { if (this.rates.size >= 8192) return { key, count: null }; entry = { start: now, count: 0 }; this.rates.set(key, entry); }
    return { key, count: ++entry.count };
  }
  private enrich(facts: RequestFacts, initial: IdentityEvidence, request: StoredRequest | null) {
    if (initial.claimedProvider !== 'google' || initial.status === 'verified' || this.jobs.size >= 128) return;
    this.background(this.intelligence.enrich(facts).then(async identity => {
      const { checkedAt: checkedNow, ...meaningful } = identity; const { checkedAt: checkedBefore, ...previous } = initial;
      if (!request || this.closed || JSON.stringify(meaningful) === JSON.stringify(previous)) return;
      const current = (await this.repository.get(request.id)); if (!current) return;
      (await this.repository.appendAssessment(request.id, this.assessment(current.context, current.policy, current.rateCount, (await this.repository.browser(request.id)), identity)));
    }));
  }
  async track(req: IncomingMessage, res: ServerResponse, url: URL, facts = socketFacts(req)) {
    await this.ready;
    if (this.closed) throw new Problem('Tracking service is shutting down.', 503);
    const config = (await this.repository.config());
    const route = publicRoute(url.pathname); if (!route || route.kind !== 'tracking') throw new Problem('Tracking link not found.', 404);
    const campaign = (await this.store.campaignConfig('slug', route.slug)); if (!campaign) throw new Problem('Campaign not found.', 404);
    if (campaign.status !== 'active') throw new Problem('This campaign is paused.', 410);
    if (facts.userAgent.length > 8192) throw new Problem('User agent is too long.');
    const source = url.searchParams.get('source') ?? campaign.source; if (source.length > 200) throw new Problem('Source is too long.');
    const externalId = url.searchParams.get('external_id') ?? ''; if (externalId.length > 500) throw new Problem('External ID is too long.');
    const device = deviceFrom(facts.userAgent);
    // Only the intelligence owner can establish current origin proof. Never reparse a claim to select a route.
    let identity = this.intelligence.identify(facts);
    res.setHeader('Vary', 'User-Agent');
    if (req.method === 'HEAD') {
      const destinations = await this.store.routingDestinations(campaign);
      resolveTraffic(campaign, destinations, { source, device, identity: this.intelligence.identify(facts) });
      res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    const rate = config.mode === 'off' ? { key: '', count: null } : this.rate(facts, req);
    let assessment = config.mode === 'off' ? null : this.assessment(facts, config, rate.count, null, identity);
    let actual = config.mode === 'enforce' && config.enforcementApproved ? assessment!.recommendedAction : 'allow';
    const timestamp = new Date(this.clock()).toISOString(); const requestId = randomUUID();
    const existing = cookie(req, 'relay_visitor'); const visitor = /^[a-f0-9]{32}$/.test(existing) ? existing : randomBytes(16).toString('hex');
    const cookieFlags = url.protocol === 'https:' ? '; Secure' : '';
    const responseCookies: string[] = [];
    let recorded: StoredRequest | null = null; let challengeToken: string | null = null;
    const target = (await this.durable(async () => {
      // All eligibility and accounting decisions stay together, after asynchronous work.
      const current = (await this.store.campaignConfig('id', campaign.id))!;
      if (current.status !== 'active') throw new Problem('This campaign is paused.', 410);
      const destinations = await this.store.routingDestinations(current);
      // Database waits must not turn expired cached origin proof into a crawler route.
      identity = this.intelligence.identify(facts);
      assessment = config.mode === 'off' ? null : this.assessment(facts, config, rate.count, null, identity);
      actual = config.mode === 'enforce' && config.enforcementApproved ? assessment!.recommendedAction : 'allow';
      let destination: string | null = null; let clickId: string | null = null; let collection: StoredRequest['collection'] = 'not-requested'; let crawler = false;
      if (actual === 'allow') {
        const selected = resolveTraffic(current, destinations, { source, device, identity });
        if (selected.kind === 'crawler') {
          (await this.store.db.prepare("INSERT INTO relay.crawler_requests(id,campaign_id,provider,user_agent,destination_url,source,created_at,identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").run(requestId, current.id, selected.provider, facts.userAgent, selected.url, source, timestamp, JSON.stringify(selected.identity)));
          destination = selected.url; crawler = true;
        } else {
          clickId = randomUUID(); const visitorHash = createHash('sha256').update(this.store.key).update(visitor).digest('hex');
          (await this.store.db.prepare("INSERT INTO relay.clicks VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").run(clickId, current.id, selected.destination.id, selected.ruleName, visitorHash, device, source, externalId, Math.round(current.costPerClick * 100), timestamp));
          const u = new URL(selected.destination.url); u.searchParams.set('click_id', clickId); u.searchParams.set('campaign', current.slug);
          if (config.mode !== 'off' && config.collectBrowser && config.ownedOrigins.includes(u.origin) && !u.searchParams.has('relay_request')) { u.searchParams.set('relay_request', requestId); collection = 'pending'; }
          destination = u.href;
          if (existing !== visitor) responseCookies.push(`relay_visitor=${visitor}; Path=/; HttpOnly; SameSite=Lax${cookieFlags}`);
        }
      }
      if (config.mode !== 'off') {
        recorded = { id: requestId, campaignId: current.id, campaignName: current.name, clickId, source, externalId, createdAt: timestamp, destinationUrl: destination, actualAction: actual, mode: config.mode, estimatedCost: crawler ? 0 : current.costPerClick, policyVersion: this.repository.policyVersion(config), context: facts, collection, assessment: assessment!, sessionKey: rate.key, policy: config, rateCount: rate.count };
        (await this.repository.insert(recorded));
        if (collection === 'pending') {
          const token = randomBytes(32).toString('hex'); const origin = new URL(destination!).origin;
          (await this.store.db.prepare("INSERT INTO relay.telemetry_sessions VALUES($1,$2,$3,$4,NULL,NULL)").run(requestId, hash(token), origin, new Date(this.clock() + 120000).toISOString()));
          responseCookies.push(`relay_collection=${token}; Path=/t/events/${requestId}; HttpOnly; SameSite=${url.protocol === 'https:' ? 'None; Secure' : 'Lax'}; Max-Age=120`);
        }
        if (actual === 'challenge') { challengeToken = randomBytes(32).toString('hex'); (await this.store.db.prepare("INSERT INTO relay.traffic_challenges VALUES($1,$2,$3,NULL)").run(hash(challengeToken), requestId, new Date(this.clock() + 120000).toISOString())); }
      }
      return destination;
    }));
    if (responseCookies.length) res.setHeader('Set-Cookie', responseCookies);
    if (recorded || campaign.crawlerRouting.enabled) this.enrich(facts, identity, recorded);
    if (actual === 'challenge') {
      html(res, 'Continue to your destination', `<h1>Continue to your destination</h1><p>This link received an unusual volume or pattern of requests. You can continue below. This step does not verify that you are human.</p><form method="post" action="/t/challenge"><input type="hidden" name="token" value="${challengeToken}"><button type="submit">Continue</button></form>`); return;
    }
    if (actual === 'throttle') { res.setHeader('Retry-After', '60'); html(res, 'Please try again shortly', '<h1>Please try again shortly.</h1><p>This link is receiving too many requests. Wait a minute, then try again.</p>', 429); return; }
    if (actual === 'deny') { html(res, 'Request restricted', '<h1>This request was restricted.</h1><p>The link owner’s traffic policy restricted this request.</p>', 403); return; }
    res.writeHead(302, { Location: target!, 'Cache-Control': 'no-store' }); res.end();
  }
  async handleCollection(req: IncomingMessage, res: ServerResponse, url: URL, raw?: Buffer): Promise<boolean> {
    const route = publicRoute(url.pathname); if (!route || route.kind === 'tracking') return false;
    if (!route.methods.includes(req.method ?? '')) { res.setHeader('Allow', route.methods.join(', ')); throw new Problem('Method not allowed.', 405); }
    if (route.kind === 'asset') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public,max-age=300', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' }); res.end(collectorScript); return true;
    }
    if (route.kind === 'challenge') {
      const bytes = raw ?? await readPublicBody(req);
      if (req.headers.origin !== url.origin) throw new Problem('Invalid continuation origin.', 403);
      const token = new URLSearchParams(bytes.toString('utf8')).get('token') ?? '';
      (await this.continueChallenge(req, res, token)); return true;
    }
    if (route.kind !== 'events') return false;
    const requestId = route.requestId;
    const row = (await this.store.db.prepare("SELECT * FROM relay.telemetry_sessions WHERE request_id=$1").get(requestId));
    if (!row) throw new Problem('Collection session not found.', 404);
    const config = (await this.repository.config());
    if (config.mode === 'off' || !config.collectBrowser || req.headers.origin !== row.origin || !config.ownedOrigins.includes(String(row.origin))) throw new Problem('This origin cannot submit observations.', 403);
    res.setHeader('Access-Control-Allow-Origin', String(row.origin)); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' }); res.end(); return true; }
    const token = cookie(req, 'relay_collection');
    if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(String(row.token_hash)))) throw new Problem('Invalid collection session.', 403);
    if (Date.parse(String(row.expires_at)) <= this.clock()) { (await this.store.db.prepare("UPDATE relay.traffic_requests SET collection='expired' WHERE id=$1 AND collection='pending'").run(requestId)); throw new Problem('Collection session expired.', 410); }
    if (!String(req.headers['content-type']).startsWith('application/json')) throw new Problem('Submit JSON browser observations.', 415);
    const bytes = raw ?? await readPublicBody(req); let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Problem('Invalid UTF-8 JSON observations.'); }
    const parsed = parseBrowser(input); if (!parsed.ok) throw new Problem(parsed.error.message);
    const digest = hash(JSON.stringify(parsed.value));
    const duplicate = await this.durable(async () => {
      const current = await this.store.db.prepare('SELECT * FROM relay.telemetry_sessions WHERE request_id=$1').get(requestId);
      if (!current || Date.parse(String(current.expires_at)) <= this.clock()) throw new Problem('Collection session expired.', 410);
      if (current.completed_at) { if (current.payload_hash !== digest) throw new Problem('This session already has different observations.', 409); return true; }
      const request = (await this.repository.get(requestId)); if (!request) throw new Problem('Traffic request not found.', 404);
      const at = new Date(this.clock()).toISOString();
      (await this.store.db.prepare("INSERT INTO relay.traffic_observations VALUES($1,$2,$3,$4,$5,$6)").run(randomUUID(), request.id, 'browser', at, 1, JSON.stringify(parsed.value)));
      const collection = parsed.value.errors.length || Object.entries(parsed.value).some(([k, v]) => k !== 'elapsedMs' && v === null) ? 'partial' : 'complete';
      (await this.store.db.prepare("UPDATE relay.traffic_requests SET collection=$1 WHERE id=$2").run(collection, request.id));
      (await this.store.db.prepare("UPDATE relay.telemetry_sessions SET completed_at=$1,payload_hash=$2 WHERE request_id=$3").run(at, digest, request.id));
      (await this.repository.appendAssessment(request.id, this.assessment(request.context, request.policy, request.rateCount, parsed.value, request.assessment.identity)));
      return false;
    });
    responseJson(res, { duplicate }); return true;
  }
  private async continueChallenge(req: IncomingMessage, res: ServerResponse, token: string) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Problem('Invalid continuation.', 403);
    const visitorCookie = cookie(req, 'relay_visitor'); const visitor = /^[a-f0-9]{32}$/.test(visitorCookie) ? visitorCookie : randomBytes(16).toString('hex');
    const location = (await this.durable(async () => {
      const row = await this.store.db.prepare('SELECT * FROM relay.traffic_challenges WHERE token_hash=$1').get(hash(token));
      if (!row || Date.parse(String(row.expires_at)) <= this.clock()) throw new Problem('Continuation expired. Open the original link again.', 410);
      const request = (await this.repository.get(String(row.request_id))); if (!request) throw new Problem('Traffic request not found.', 404);
      const campaign = (await this.store.campaignConfig('id', request.campaignId)); if (!campaign || campaign.status !== 'active') throw new Problem('This campaign is paused.', 410);
      if (row.completed_at && request.destinationUrl) return request.destinationUrl;
      const decision = chooseRoute(campaign, (await this.store.routingDestinations(campaign)), { source: request.source, device: deviceFrom(request.context.userAgent) });
      const clickId = randomUUID(); const at = new Date(this.clock()).toISOString();
      (await this.store.db.prepare("INSERT INTO relay.clicks VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)").run(clickId, campaign.id, decision.destination.id, decision.ruleName, createHash('sha256').update(this.store.key).update(visitor).digest('hex'), deviceFrom(request.context.userAgent), request.source, request.externalId, Math.round(request.estimatedCost * 100), at));
      const u = new URL(decision.destination.url); u.searchParams.set('click_id', clickId); u.searchParams.set('campaign', campaign.slug);
      (await this.store.db.prepare("UPDATE relay.traffic_requests SET click_id=$1,destination_url=$2,actual_action='allow' WHERE id=$3").run(clickId, u.href, request.id));
      (await this.store.db.prepare("UPDATE relay.traffic_challenges SET completed_at=$1 WHERE token_hash=$2").run(at, hash(token)));
      (await this.repository.action(request.id, 'allow', at, 'manual-continuation-not-human-verification')); return u.href;
    }));
    const secure = this.options.edge?.audience.startsWith('https:') ? '; Secure' : '';
    if (visitor !== visitorCookie) res.setHeader('Set-Cookie', `relay_visitor=${visitor}; Path=/; HttpOnly; SameSite=Lax${secure}`);
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' }); res.end();
  }
  async simulate(facts: RequestFacts, rate: number | null = null, browser: BrowserFacts | null = null) {
    const result = this.assessment(facts, (await this.repository.config()), rate, browser, this.intelligence.unknown(facts, 'synthetic-simulation-not-origin-proof'));
    return { synthetic: true as const, assessment: result };
  }
  private async durable<T>(work: () => Promise<T>): Promise<T> {
    try { return (await transactional(this.store, work)); }
    catch (error) { if (error instanceof Problem) throw error; throw new Problem('The tracking record could not be committed. Retry later.', 503); }
  }
  createPublicServer() {
    if (!this.edge || !this.options.edge) throw new Error('Configure authenticated edge ingress before starting the public listener.');
    const origin = this.options.edge.audience;
    const server = http.createServer({ maxHeaderSize: 16384 }, async (req, res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
      try {
        const url = new URL(req.url ?? '/', origin);
        if (url.origin !== origin) throw new Problem('Invalid public request origin.', 403);
        const route = publicRoute(url.pathname);
        if (!route) throw new Problem('Public endpoint not found.', 404);
        if (!route.methods.includes(req.method ?? '')) { res.setHeader('Allow', route.methods.join(', ')); throw new Problem('Method not allowed.', 405); }
        const bytes = req.method === 'POST' ? await readPublicBody(req) : Buffer.alloc(0);
        const verified = this.edge!.verify(req, bytes); if (!verified.ok) throw new Problem(verified.error.message, verified.error.kind === 'capacity' ? 503 : 403);
        if (route.kind === 'tracking') (await this.track(req, res, url, verified.value)); else await this.handleCollection(req, res, url, bytes);
      } catch (error) { const problem = error instanceof Problem ? error : new Problem('Tracking service could not complete this request.', 503); responseJson(res, { error: problem.message }, problem.status); }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000; return server;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.timer);
    this.closing = (async () => { await this.intelligence.close(); await Promise.allSettled([...this.jobs]); this.rates.clear(); })();
    return this.closing;
  }
}
