import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import { handleAsNodeRequest } from 'cloudflare:node';
import { createApp } from '../server/app.ts';
import { openRemoteStore, type Store } from '../server/store.ts';
import { TrafficRuntime } from '../server/traffic/runtime.ts';
import { publicRoute } from '../shared/public-routes.ts';
import { signedTrackingRequest, type CloudflareRequest } from './worker.ts';

export interface AppEnvironment {
  ASSETS: Fetcher;
  BACKEND: DurableObjectNamespace;
  RELAY_PUBLIC_ORIGIN: string;
  DATABASE_URL?: string;
  HYPERDRIVE?: Hyperdrive;
  RELAY_WORKSPACE_KEY: string;
  RELAY_ADMIN_USER: string;
  RELAY_ADMIN_PASSWORD: string;
}

function origin(env: AppEnvironment) {
  const url = new URL(env.RELAY_PUBLIC_ORIGIN);
  if (url.protocol !== 'https:' || url.origin !== env.RELAY_PUBLIC_ORIGIN) throw new Error('Configure a canonical HTTPS RELAY_PUBLIC_ORIGIN.');
  return url.origin;
}
function workspaceKey(env: AppEnvironment) {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(env.RELAY_WORKSPACE_KEY ?? '')) throw new Error('Configure the original base64 workspace key.');
  const key = Buffer.from(env.RELAY_WORKSPACE_KEY, 'base64');
  if (key.length !== 32 || key.toString('base64') !== env.RELAY_WORKSPACE_KEY) throw new Error('Invalid workspace key.');
  return key;
}
function ingressKey(env: AppEnvironment) { return createHmac('sha256', workspaceKey(env)).update('relay:cloudflare-ingress:v1').digest('hex'); }
function publicPath(path: string) {
  return Boolean(publicRoute(path)) || path === '/postback' || path === '/site' || path.startsWith('/site/') || /^\/example\/(a|b)$/.test(path);
}
function backendPath(path: string) { return publicPath(path) || path === '/api' || path.startsWith('/api/'); }
function unavailable() {
  return Response.json({ error: 'Relay backend unavailable. Configure Worker secrets and verify the database connection.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
function authentication(request: Request, env: AppEnvironment): Response | null {
  if (!env.RELAY_ADMIN_USER || env.RELAY_ADMIN_USER.includes(':') || !env.RELAY_ADMIN_PASSWORD || env.RELAY_ADMIN_PASSWORD.length < 24) return unavailable();
  const expected = createHash('sha256').update(`${env.RELAY_ADMIN_USER}:${env.RELAY_ADMIN_PASSWORD}`).digest();
  const header = request.headers.get('authorization') ?? '';
  let supplied = '';
  if (/^Basic [A-Za-z0-9+/]+=*$/i.test(header) && header.length < 4096) supplied = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const actual = createHash('sha256').update(supplied).digest();
  if (supplied && timingSafeEqual(expected, actual)) return null;
  return new Response('Sign in to your Relay workspace.', { status: 401, headers: {
    'WWW-Authenticate': 'Basic realm="Relay workspace", charset="UTF-8"',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  } });
}

export default {
  async fetch(request: CloudflareRequest, env: AppEnvironment): Promise<Response> {
    let expected: string;
    try { expected = origin(env); } catch { return unavailable(); }
    const url = new URL(request.url);
    if (url.origin !== expected) return new Response('Unknown application origin.', { status: 403 });
    if (!publicPath(url.pathname)) {
      const rejected = authentication(request, env); if (rejected) return rejected;
    }
    if (!backendPath(url.pathname)) {
      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers); headers.set('Cache-Control', 'private, no-store');
      headers.set('X-Content-Type-Options', 'nosniff'); headers.set('Referrer-Policy', 'same-origin');
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
      return new Response(response.body, { status: response.status, headers });
    }
    try {
      // The binding is private. Never route admin requests through a public origin.
      const backend = env.BACKEND.get(env.BACKEND.idFromName('workspace'));
      if (publicRoute(url.pathname)) {
        const signed = await signedTrackingRequest(request, { PUBLIC_ORIGIN: expected, ORIGIN_URL: expected, RELAY_EDGE_KEY: ingressKey(env), RELAY_EDGE_KEY_ID: 'worker' });
        if (signed instanceof Response) return signed;
        return await backend.fetch(signed);
      }
      return await backend.fetch(request);
    } catch { return unavailable(); }
  },
};

type Backend = { store: Store; traffic: TrafficRuntime; admin: Server; tracking: Server; adminPort: number; trackingPort: number };
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP adapter did not allocate a port.');
  return address.port;
}
function close(server: Server) { return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

/** One workspace owner retains rate windows, replay markers and crawler caches. */
export class RelayBackend {
  private state: DurableObjectState;
  private env: AppEnvironment;
  private backend: Promise<Backend> | undefined;
  private failedSetup: { store: Store; traffic?: TrafficRuntime; servers: Server[] } | undefined;
  constructor(state: DurableObjectState, env: AppEnvironment) { this.state = state; this.env = env; }
  private ready() {
    return this.backend ??= this.initialize().catch(error => { this.backend = undefined; throw error; });
  }
  private async initialize(): Promise<Backend> {
    await this.cleanupFailedSetup();
    const expected = origin(this.env);
    const store = await openRemoteStore(this.env.HYPERDRIVE?.connectionString ?? this.env.DATABASE_URL, workspaceKey(this.env), this.env.HYPERDRIVE ? { hyperdrive: true } : {});
    let traffic: TrafficRuntime | undefined; const servers: Server[] = [];
    try {
      traffic = new TrafficRuntime(store, { periodicMaintenance: false, edge: { audience: expected, keys: { worker: ingressKey(this.env) } } });
      await traffic.ready;
      const admin = createApp(store, '', traffic, { origin: expected, serveFiles: false }); servers.push(admin);
      const tracking = traffic.createPublicServer({}); servers.push(tracking);
      const adminPort = await listen(admin); const trackingPort = await listen(tracking);
      await this.state.storage.setAlarm(Date.now() + 30 * 60000);
      this.state.waitUntil(traffic.intelligence.refresh());
      return { store, traffic, admin, tracking, adminPort, trackingPort };
    } catch (error) {
      this.failedSetup = { store, traffic, servers };
      await this.cleanupFailedSetup(); throw error;
    }
  }
  private async cleanupFailedSetup() {
    const failed = this.failedSetup; if (!failed) return;
    const results = await Promise.allSettled([
      ...failed.servers.filter(server => server.listening).map(close), failed.traffic?.close(),
    ]);
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Backend cleanup must finish before retrying setup.');
    await failed.store.db.close(); this.failedSetup = undefined;
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== origin(this.env)) return new Response('Unknown application origin.', { status: 403 });
    const tracking = Boolean(publicRoute(url.pathname));
    if (!publicPath(url.pathname)) { const rejected = authentication(request, this.env); if (rejected) return rejected; }
    try {
      const backend = await this.ready();
      const headers = new Headers(request.headers); headers.set('host', url.host);
      const response = await handleAsNodeRequest(tracking ? backend.trackingPort : backend.adminPort, new Request(request, { headers }));
      this.state.waitUntil(backend.traffic.settle());
      return response;
    } catch { return unavailable(); }
  }
  async alarm() {
    try { const backend = await this.ready(); await backend.traffic.maintain(); await backend.traffic.settle(); }
    finally { await this.state.storage.setAlarm(Date.now() + 30 * 60000); }
  }
}
