import { canonicalHeaders, signedHeaders } from '../shared/edge.ts';
import { publicRoute } from '../shared/public-routes.ts';

export interface EdgeEnvironment { PUBLIC_ORIGIN: string; ORIGIN_URL: string; RELAY_EDGE_KEY: string; RELAY_EDGE_KEY_ID: string; }
interface CloudflareRequest extends Request {
  cf?: { botManagement?: { verifiedBot?: boolean; score?: number; ja4?: string }; verifiedBotCategory?: string };
}
async function digest(value: Uint8Array | string) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)), x => x.toString(16).padStart(2, '0')).join('');
}
async function readBody(request: Request) {
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.length; if (size > 32768) throw new Error('Payload exceeds the collection budget.'); chunks.push(result.value); } } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}
export default {
  async fetch(request: CloudflareRequest, env: EdgeEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const route = publicRoute(url.pathname);
    if (!route) return new Response('Public endpoint not found.', { status: 404 });
    if (!route.methods.includes(request.method)) return new Response('Method not allowed.', { status: 405, headers: { Allow: route.methods.join(', ') } });
    let upstream: URL;
    try {
      upstream = new URL(env.ORIGIN_URL);
      if (upstream.origin !== env.ORIGIN_URL || upstream.protocol !== 'https:' || url.origin !== env.PUBLIC_ORIGIN || env.RELAY_EDGE_KEY.length < 32 || !/^[a-z0-9-]{1,40}$/.test(env.RELAY_EDGE_KEY_ID)) throw new Error();
    } catch { return new Response('Tracking ingress is not configured.', { status: 503 }); }
    if (!request.cf || !request.headers.has('cf-connecting-ip')) return new Response('Cloudflare client context is unavailable.', { status: 503 });
    let body: Uint8Array; try { body = request.method === 'POST' ? await readBody(request) : new Uint8Array(); } catch { return new Response('Collection payload is too large.', { status: 413 }); }
    const headers = new Headers(request.headers);
    headers.delete('host'); headers.delete('content-length');
    headers.delete('x-relay-envelope'); headers.delete('x-relay-signature');
    for (const name of signedHeaders) if (!headers.has(name)) headers.set(name, '');
    // Only use the IPv6 companion when Cloudflare supplied a Class E pseudo IPv4.
    const connectingIp = request.headers.get('cf-connecting-ip')!;
    const pseudo = /^\d+\./.test(connectingIp) && Number(connectingIp.split('.')[0]) >= 240;
    const ip = pseudo ? request.headers.get('cf-connecting-ipv6') : connectingIp;
    if (!ip) return new Response('Original client IP is unavailable.', { status: 503 });
    const management = request.cf.botManagement;
    const envelope = {
      version: 1, keyId: env.RELAY_EDGE_KEY_ID, audience: env.PUBLIC_ORIGIN, timestamp: Date.now(), nonce: crypto.randomUUID(),
      method: request.method, target: url.pathname + url.search,
      headersHash: await digest(canonicalHeaders(name => headers.get(name))), bodyHash: await digest(body), ip,
      edge: { verifiedBot: typeof management?.verifiedBot === 'boolean' ? management.verifiedBot : null, score: typeof management?.score === 'number' && management.score >= 1 && management.score <= 99 ? management.score : null, category: request.cf.verifiedBotCategory ?? null, ja4: management?.ja4 ?? null },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const payload = btoa(Array.from(bytes, x => String.fromCharCode(x)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.RELAY_EDGE_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))), x => x.toString(16).padStart(2, '0')).join('');
    headers.set('x-relay-envelope', payload); headers.set('x-relay-signature', signature);
    upstream.pathname = url.pathname; upstream.search = url.search;
    try { return await fetch(upstream, { method: request.method, headers, body: request.method === 'POST' ? body as BodyInit : undefined, redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
    catch { return new Response('Tracking origin is unavailable.', { status: 502, headers: { 'Cache-Control': 'no-store' } }); }
  },
};
