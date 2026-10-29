import { isIP } from 'node:net';
import type { Result } from '../../shared/traffic.ts';

export interface Ip { text: string; family: 4 | 6; value: bigint; }
export interface Network { source: string; family: 4 | 6; value: bigint; mask: bigint; }
export function parseIp(raw: unknown): Result<Ip> {
  if (typeof raw !== 'string' || raw.length > 45 || raw.includes('%') || !isIP(raw)) return { ok: false, error: { kind: 'invalid', message: 'Expected a single IPv4 or IPv6 address.' } };
  if (isIP(raw) === 4) return { ok: true, value: { text: raw, family: 4, value: raw.split('.').reduce((n, x) => (n << 8n) + BigInt(x), 0n) } };
  const text = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  const [left, right] = text.split('::');
  const a = left ? left.split(':') : []; const b = right ? right.split(':') : [];
  const parts = text.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
  const value = parts.reduce((n, x) => (n << 16n) + BigInt(`0x${x}`), 0n);
  if (value >> 32n === 65535n) {
    const v4 = value & 0xffffffffn; const mapped = [24n, 16n, 8n, 0n].map(s => Number((v4 >> s) & 255n)).join('.');
    return { ok: true, value: { text: mapped, family: 4, value: v4 } };
  }
  return { ok: true, value: { text, family: 6, value } };
}
export function parseNetwork(raw: unknown): Result<Network> {
  if (typeof raw !== 'string' || raw.length > 49) return { ok: false, error: { kind: 'invalid', message: 'Invalid CIDR network.' } };
  const parts = raw.split('/'); const ip = parseIp(parts[0]);
  if (!ip.ok || parts.length > 2 || (parts.length === 2 && !/^\d{1,3}$/.test(parts[1]))) return { ok: false, error: { kind: 'invalid', message: 'Invalid CIDR network.' } };
  const bits = ip.value.family === 4 ? 32 : 128; const prefix = parts.length === 2 ? Number(parts[1]) : bits;
  if (prefix > bits) return { ok: false, error: { kind: 'invalid', message: 'CIDR prefix exceeds address width.' } };
  const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return { ok: true, value: { source: raw, family: ip.value.family, value: ip.value.value & mask, mask } };
}
export function contains(network: Network, ip: Ip) { return network.family === ip.family && (ip.value & network.mask) === network.value; }
const nonPublic = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3', '::/128', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8', '2001:db8::/32'].map(x => { const p = parseNetwork(x); if (!p.ok) throw new Error(p.error.message); return p.value; });
export function isPublic(ip: Ip) { return !nonPublic.some(n => contains(n, ip)); }
