import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { RequestFacts, Result } from '../../shared/traffic.ts';
import { parseIp } from './ip.ts';
import { record } from './validation.ts';
import { canonicalHeaders } from '../../shared/edge.ts';

export interface EdgeEnvelope {
  version: 1; keyId: string; audience: string; timestamp: number; nonce: string;
  method: string; target: string; headersHash: string; bodyHash: string; ip: string;
  edge: RequestFacts['edge'];
}
export interface EdgeOptions { audience: string; keys: Record<string, string>; }
export function headersHash(headers: IncomingMessage['headers']) {
  return createHash('sha256').update(canonicalHeaders(k => typeof headers[k] === 'string' ? headers[k] as string : null)).digest('hex');
}
export function signEnvelope(envelope: EdgeEnvelope, secret: string) {
  const payload = Buffer.from(JSON.stringify(envelope)).toString('base64url');
  return { payload, signature: createHmac('sha256', secret).update(payload).digest('hex') };
}
export function socketFacts(req: IncomingMessage): RequestFacts {
  const sourceIp = req.socket.remoteAddress ?? null; const parsed = parseIp(sourceIp);
  return {
    requestTarget: req.url ?? '/',
    ip: parsed.ok ? parsed.value.text : null, sourceIp, authority: 'socket',
    userAgent: String(req.headers['user-agent'] ?? ''), accept: typeof req.headers.accept === 'string' ? req.headers.accept : null,
    language: typeof req.headers['accept-language'] === 'string' ? req.headers['accept-language'] : null,
    platformHint: typeof req.headers['sec-ch-ua-platform'] === 'string' ? req.headers['sec-ch-ua-platform'] : null,
    edge: { verifiedBot: null, score: null, category: null, ja4: null },
  };
}
export class EdgeVerifier {
  private seen = new Map<string, number>();
  private nextPrune = 0;
  readonly options: EdgeOptions;
  private clock: () => number;
  constructor(options: EdgeOptions, clock = Date.now) {
    this.options = options; this.clock = clock;
    if (!options.audience || Object.keys(options.keys).length < 1 || Object.values(options.keys).some(k => k.length < 32)) throw new Error('Ingress needs an audience and signing keys of at least 32 characters.');
  }
  verify(req: IncomingMessage, body: Buffer): Result<RequestFacts, { kind: 'unauthorized' | 'capacity'; message: string }> {
    const bad = (message = 'Invalid or missing authenticated edge context.'): Result<never, { kind: 'unauthorized'; message: string }> => ({ ok: false, error: { kind: 'unauthorized', message } });
    const payload = req.headers['x-relay-envelope']; const signature = req.headers['x-relay-signature'];
    if (typeof payload !== 'string' || payload.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(payload) || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return bad();
    let e: unknown; try { e = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return bad(); }
    if (!record(e) || e.version !== 1 || typeof e.keyId !== 'string' || !Object.hasOwn(this.options.keys, e.keyId)) return bad();
    const expected = createHmac('sha256', this.options.keys[e.keyId]).update(payload).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return bad();
    const now = this.clock();
    if (e.audience !== this.options.audience || typeof e.timestamp !== 'number' || !Number.isSafeInteger(e.timestamp) || Math.abs(now - e.timestamp) > 60000 || typeof e.nonce !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(e.nonce)) return bad();
    if (e.method !== req.method || e.target !== req.url || e.headersHash !== headersHash(req.headers) || e.bodyHash !== createHash('sha256').update(body).digest('hex')) return bad();
    const ip = parseIp(e.ip); if (!ip.ok || !record(e.edge)) return bad();
    const edge = e.edge;
    if (edge.verifiedBot !== null && typeof edge.verifiedBot !== 'boolean') return bad();
    if (edge.score !== null && (typeof edge.score !== 'number' || !Number.isInteger(edge.score) || edge.score < 1 || edge.score > 99)) return bad();
    for (const k of ['category', 'ja4']) if (edge[k] !== null && (typeof edge[k] !== 'string' || (edge[k] as string).length > 100)) return bad();
    if (now >= this.nextPrune || this.seen.size >= 16384) { for (const [key, expiry] of this.seen) if (expiry <= now) this.seen.delete(key); this.nextPrune = now + 1000; }
    const nonce = `${e.keyId}:${e.nonce}`; if (this.seen.has(nonce)) return bad('Edge request has already been used.');
    // Never evict a live replay marker to make room for another request.
    if (this.seen.size >= 16384) return { ok: false, error: { kind: 'capacity', message: 'Ingress replay capacity reached. Retry later.' } };
    this.seen.set(nonce, e.timestamp + 60001);
    return { ok: true, value: { ...socketFacts(req), ip: ip.value.text, sourceIp: e.ip as string, authority: 'cloudflare-signed', edge: edge as unknown as RequestFacts['edge'] } };
  }
}
