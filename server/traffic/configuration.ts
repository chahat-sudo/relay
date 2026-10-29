import type { EdgeOptions } from './context.ts';
import { record } from './validation.ts';

export function ingressConfiguration(env: { RELAY_PUBLIC_ORIGIN?: string; RELAY_EDGE_KEYS?: string; RELAY_TRACKING_PORT?: string }): { edge?: EdgeOptions; port: number } {
  const port = Number(env.RELAY_TRACKING_PORT ?? '4181');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 4180) throw new Error('RELAY_TRACKING_PORT must be an available port between 1024 and 65535, separate from 4180.');
  if (!env.RELAY_PUBLIC_ORIGIN && !env.RELAY_EDGE_KEYS) return { port };
  if (!env.RELAY_PUBLIC_ORIGIN || !env.RELAY_EDGE_KEYS) throw new Error('Set both RELAY_PUBLIC_ORIGIN and RELAY_EDGE_KEYS to enable ingress.');
  const u = new URL(env.RELAY_PUBLIC_ORIGIN);
  if (u.origin !== env.RELAY_PUBLIC_ORIGIN || u.protocol !== 'https:') throw new Error('RELAY_PUBLIC_ORIGIN must be an exact HTTPS origin without a path.');
  let keys: unknown; try { keys = JSON.parse(env.RELAY_EDGE_KEYS); } catch { throw new Error('RELAY_EDGE_KEYS must contain a JSON object of signing keys.'); }
  if (!record(keys) || Object.keys(keys).length < 1 || Object.keys(keys).length > 2 || Object.entries(keys).some(([k, v]) => !/^[a-z0-9-]{1,40}$/.test(k) || typeof v !== 'string' || v.length < 32 || v.length > 256)) throw new Error('Configure one or two named signing keys of 32–256 characters.');
  return { edge: { audience: u.origin, keys: keys as Record<string, string> }, port };
}
