import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { TrafficOperation } from '../../shared/traffic.ts';
import { trafficOperations } from '../../shared/traffic.ts';
import { Problem, text } from '../domain.ts';
import { TrafficRuntime, responseJson } from './runtime.ts';
import { parseBrowser } from './validation.ts';
import { parseIp } from './ip.ts';
import { evaluateModel } from './model.ts';

export function isTrafficOperation(operation: string): operation is TrafficOperation { return (trafficOperations as readonly string[]).includes(operation); }
function integer(raw: string | null, fallback: number, max: number, min = 0) { if (raw === null) return fallback; if (!/^\d+$/.test(raw) || Number(raw) > max || Number(raw) < min) throw new Problem('Invalid traffic paging or date range.'); return Number(raw); }
function choice(raw: string | null, options: string[]) { if (raw !== null && !options.includes(raw)) throw new Problem('Invalid traffic filter.'); return raw ?? undefined; }
export async function trafficAdmin(runtime: TrafficRuntime, operation: TrafficOperation, res: ServerResponse, url: URL, data?: Record<string, unknown>, id?: string) {
  const repo = runtime.repository;
  if (operation === 'traffic.status') return responseJson(res, (await runtime.status()));
  if (operation === 'traffic.config') { (await repo.saveConfig(data)); return responseJson(res, (await runtime.status())); }
  if (operation === 'traffic.history') return responseJson(res, (await repo.history(integer(url.searchParams.get('before'), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 1))));
  if (operation === 'traffic.requests') return responseJson(res, (await repo.list({ limit: integer(url.searchParams.get('limit'), 25, 100, 1), offset: integer(url.searchParams.get('offset'), 0, 100000), days: integer(url.searchParams.get('days'), 30, 365, 1), campaignId: url.searchParams.get('campaignId') ?? undefined, risk: choice(url.searchParams.get('risk'), ['low', 'medium', 'high', 'unknown']), identity: choice(url.searchParams.get('identity'), ['verified', 'unverified', 'unknown']), collection: choice(url.searchParams.get('collection'), ['not-requested', 'pending', 'complete', 'partial', 'expired', 'failed']), reason: url.searchParams.has('reason') ? text(url.searchParams.get('reason'), 'Reason', 100) : undefined })));
  if (operation === 'traffic.detail') return responseJson(res, (await repo.detail(text(id, 'Request ID', 80))));
  if (operation === 'traffic.summary') return responseJson(res, (await repo.summary(integer(url.searchParams.get('days'), 30, 365, 1), url.searchParams.get('campaignId') ?? '')));
  if (operation === 'traffic.refresh') { await runtime.intelligence.refresh(true); return responseJson(res, (await runtime.status())); }
  if (operation === 'traffic.maintenance') return responseJson(res, (await repo.maintain()));
  if (operation === 'traffic.model') return responseJson(res, (await evaluateModel(runtime.store)));
  if (!data) throw new Problem('Missing request data.');
  if (operation === 'traffic.labels') {
    const requestId = text(data.requestId, 'Request ID', 80); if (!(await repo.get(requestId))) throw new Problem('Traffic request not found.', 404);
    if (data.label !== 'legitimate' && data.label !== 'abusive') throw new Problem('Choose legitimate or abusive.');
    const provenance = text(data.provenance, 'Independent label evidence', 1000); if (provenance.length < 10) throw new Problem('Describe the independent evidence for this label.');
    (await runtime.store.db.prepare("INSERT INTO relay.traffic_labels(id,request_id,label,provenance,created_at) VALUES($1,$2,$3,$4,$5)").run(randomUUID(), requestId, data.label, provenance, new Date().toISOString()));
    return responseJson(res, (await repo.detail(requestId)));
  }
  if (operation !== 'traffic.simulate') throw new Problem('Unknown traffic operation.', 404);
  const userAgent = text(data.userAgent, 'User agent', 8192, true); const ip = data.ip === null || data.ip === undefined || data.ip === '' ? null : parseIp(data.ip);
  if (ip && !ip.ok) throw new Problem(ip.error.message);
  const browser = data.browser === null || data.browser === undefined ? null : parseBrowser(data.browser); if (browser && !browser.ok) throw new Problem(browser.error.message);
  const rate = data.rateCount === undefined ? null : Number(data.rateCount); if (rate !== null && (!Number.isInteger(rate) || rate < 0 || rate > 1000000)) throw new Problem('Invalid simulated rate.');
  return responseJson(res, (await runtime.simulate({ requestTarget: '/synthetic', ip: ip && ip.ok ? ip.value.text : null, sourceIp: ip && ip.ok ? String(data.ip) : null, authority: 'socket', userAgent, accept: 'text/html', language: null, platformHint: null, edge: { verifiedBot: null, score: null, category: null, ja4: null } }, rate, browser && browser.ok ? browser.value : null)));
}
