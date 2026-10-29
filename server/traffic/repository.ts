import { createHash, randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import type { SqlValue } from '../database.ts';
import type { Assessment, BrowserFacts, CollectionState, RequestFacts, TrafficConfig, TrafficRecord, TrafficSummary } from '../../shared/traffic.ts';
import { defaultTrafficConfig } from '../../shared/traffic.ts';
import { parseBrowser, parseConfig } from './validation.ts';
import { Problem, transactional } from '../domain.ts';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export interface StoredRequest extends TrafficRecord { sessionKey: string; policy: TrafficConfig; rateCount: number | null; }
export function trafficRepository(store: Store) {
  const { db } = store;
  let configSource: string | null = null; let configCache = defaultTrafficConfig;
  const policyIds = new WeakMap<TrafficConfig, string>();
  const policies = new Map<string, TrafficConfig>();
  function policyVersion(config: TrafficConfig) { let id = policyIds.get(config); if (!id) { id = hash(JSON.stringify(config)); policyIds.set(config, id); } return id; }
  async function config(): Promise<TrafficConfig> {
    const source = await store.getSetting('traffic_config', '{}'); if (source === configSource) return configCache;
    let input: unknown; try { input = JSON.parse(source); } catch { throw new Problem('Stored traffic settings cannot be decoded. Restore a valid settings backup.', 503); }
    const parsed = parseConfig(input); if (!parsed.ok) throw new Problem(`Stored traffic settings are invalid: ${parsed.error.message}`, 503);
    configSource = source; configCache = parsed.value; return configCache;
  }
  async function saveConfig(value: unknown) {
    return transactional(store, async () => {
      const current = await config(); const parsed = parseConfig(value, current); if (!parsed.ok) throw new Problem(parsed.error.message);
      const next = JSON.stringify(parsed.value); if (next === JSON.stringify(current)) return current;
      const at = new Date().toISOString();
      if (!await db.prepare('SELECT 1 FROM relay.traffic_config_history LIMIT 1').get()) {
        await db.prepare('INSERT INTO relay.traffic_policies VALUES($1,$2) ON CONFLICT DO NOTHING').run(policyVersion(current), JSON.stringify(current));
        await db.prepare('INSERT INTO relay.traffic_config_history(policy_id,changed_at,raw_config) VALUES($1,$2,$3)').run(policyVersion(current), at, await store.getSetting('traffic_config', '{}'));
      }
      await db.prepare('INSERT INTO relay.traffic_policies VALUES($1,$2) ON CONFLICT DO NOTHING').run(policyVersion(parsed.value), next);
      await db.prepare('INSERT INTO relay.traffic_config_history(policy_id,changed_at,raw_config) VALUES($1,$2,$3)').run(policyVersion(parsed.value), at, next);
      await store.setSetting('traffic_config', next); return parsed.value;
    });
  }
  async function appendAssessment(requestId: string, assessment: Assessment) { await db.prepare('INSERT INTO relay.traffic_assessments(request_id,created_at,assessment) VALUES($1,$2,$3)').run(requestId, assessment.assessedAt, JSON.stringify(assessment)); }
  async function action(requestId: string, actual: TrafficRecord['actualAction'], at: string, reason: string) { await db.prepare('INSERT INTO relay.traffic_actions VALUES($1,$2,$3,$4,$5)').run(randomUUID(), requestId, actual, at, reason); }
  async function insert(request: StoredRequest) {
    await db.prepare('INSERT INTO relay.traffic_policies VALUES($1,$2) ON CONFLICT DO NOTHING').run(request.policyVersion, JSON.stringify(request.policy));
    await db.prepare('INSERT INTO relay.traffic_requests VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)').run(request.id, request.campaignId, request.clickId, request.source, request.externalId, request.createdAt, JSON.stringify(request.context), request.destinationUrl, request.actualAction, request.mode, Math.round(request.estimatedCost * 100), request.collection, request.sessionKey, request.policyVersion, request.rateCount);
    await appendAssessment(request.id, request.assessment); await action(request.id, request.actualAction, request.createdAt, request.mode === 'observe' ? 'observation-only' : 'initial-policy');
    await db.prepare('INSERT INTO relay.traffic_observations VALUES($1,$2,$3,$4,$5,$6)').run(randomUUID(), request.id, 'network', request.createdAt, 1, JSON.stringify({ rateCount: request.rateCount, authority: request.context.authority }));
  }
  const select = `SELECT r.*,c.name campaign_name,a.assessment,p.policy FROM relay.traffic_requests r JOIN relay.campaigns c ON c.id=r.campaign_id JOIN relay.traffic_policies p ON p.id=r.policy_id JOIN relay.traffic_assessments a ON a.sequence=(SELECT max(a2.sequence) FROM relay.traffic_assessments a2 WHERE a2.request_id=r.id)`;
  function storedPolicy(version: string, source: string): TrafficConfig {
    let policy = policies.get(version);
    if (!policy) { const parsed = parseConfig(JSON.parse(source)); if (!parsed.ok) throw new Problem('Stored traffic policy is invalid.', 503); policy = parsed.value; if (policies.size >= 64) policies.delete(policies.keys().next().value!); policies.set(version, policy); }
    return policy;
  }
  function decode(row: Record<string, unknown>): StoredRequest {
    const version = String(row.policy_id); const policy = storedPolicy(version, String(row.policy));
    return { id: String(row.id), campaignId: String(row.campaign_id), campaignName: String(row.campaign_name), clickId: row.click_id === null ? null : String(row.click_id), source: String(row.source), externalId: String(row.external_id), createdAt: String(row.created_at), destinationUrl: row.destination_url === null ? null : String(row.destination_url), actualAction: row.actual_action as TrafficRecord['actualAction'], mode: row.mode as TrafficConfig['mode'], estimatedCost: Number(row.cost_cents) / 100, policyVersion: version, collection: row.collection as CollectionState, context: JSON.parse(String(row.context)) as RequestFacts, assessment: JSON.parse(String(row.assessment)) as Assessment, sessionKey: String(row.session_key), policy, rateCount: row.rate_count === null ? null : Number(row.rate_count) };
  }
  async function history(before = Number.MAX_SAFE_INTEGER) {
    const rows = await db.prepare('SELECT h.sequence,h.changed_at,h.policy_id,p.policy FROM relay.traffic_config_history h JOIN relay.traffic_policies p ON p.id=h.policy_id WHERE h.sequence<$1 ORDER BY h.sequence DESC LIMIT 10').all(before);
    return { items: rows.map(r => ({ sequence: Number(r.sequence), changedAt: String(r.changed_at), policyVersion: String(r.policy_id), config: storedPolicy(String(r.policy_id), String(r.policy)) })), nextBefore: rows.length === 10 ? Number(rows.at(-1)!.sequence) : null };
  }
  async function get(id: string): Promise<StoredRequest | null> { const row = await db.prepare(select + ' WHERE r.id=$1').get(id); return row ? decode(row) : null; }
  function publicRecord(row: StoredRequest): TrafficRecord { const { sessionKey, policy, rateCount, ...rest } = row; return rest; }
  async function list(filters: { campaignId?: string; risk?: string; identity?: string; collection?: string; reason?: string; limit: number; offset: number; days: number }) {
    const clauses = ['r.created_at>=$1']; const params: SqlValue[] = [new Date(Date.now() - filters.days * 86400000).toISOString()];
    const add = (column: string, value: string) => { params.push(value); clauses.push(`${column}=$${params.length}`); };
    if (filters.campaignId) add('r.campaign_id', filters.campaignId);
    if (filters.risk) add("(a.assessment::jsonb->>'risk')", filters.risk);
    if (filters.identity) add("(a.assessment::jsonb #>> '{identity,status}')", filters.identity);
    if (filters.collection) add('r.collection', filters.collection);
    if (filters.reason) { params.push(filters.reason); clauses.push(`EXISTS(SELECT 1 FROM jsonb_array_elements_text(a.assessment::jsonb->'reasons') reason WHERE reason.value=$${params.length})`); }
    const where = ' WHERE ' + clauses.join(' AND ');
    const total = Number((await db.prepare(`SELECT count(*) n FROM (${select + where}) matches`).get(...params))!.n);
    const items = (await db.prepare(select + where + ` ORDER BY r.created_at DESC,r.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`).all(...params, filters.limit, filters.offset)).map(row => publicRecord(decode(row)));
    return { items, total, nextOffset: filters.offset + items.length < total ? filters.offset + items.length : null };
  }
  async function detail(id: string) {
    const r = await get(id); if (!r) throw new Problem('Traffic request not found.', 404);
    return {
      request: publicRecord(r), policy: r.policy,
      assessments: (await db.prepare('SELECT created_at,assessment FROM relay.traffic_assessments WHERE request_id=$1 ORDER BY sequence DESC LIMIT 100').all(id)).map(a => JSON.parse(String(a.assessment)) as Assessment),
      observations: (await db.prepare('SELECT kind,created_at,facts FROM relay.traffic_observations WHERE request_id=$1 ORDER BY created_at DESC LIMIT 20').all(id)).map(o => ({ kind: String(o.kind), createdAt: String(o.created_at), facts: JSON.parse(String(o.facts)) as unknown })),
      actions: await db.prepare('SELECT action,created_at,reason FROM relay.traffic_actions WHERE request_id=$1 ORDER BY created_at,id').all(id),
      labels: await db.prepare('SELECT label,provenance,created_at FROM relay.traffic_labels WHERE request_id=$1 ORDER BY sequence').all(id),
    };
  }
  async function browser(id: string): Promise<BrowserFacts | null> {
    const row = await db.prepare("SELECT facts FROM relay.traffic_observations WHERE request_id=$1 AND kind='browser' ORDER BY created_at DESC LIMIT 1").get(id);
    if (!row) return null; const parsed = parseBrowser(JSON.parse(String(row.facts))); if (!parsed.ok) throw new Problem('Stored browser observation is malformed.', 503); return parsed.value;
  }
  async function summary(days: number, campaignId = ''): Promise<TrafficSummary> {
    const clauses = ' WHERE r.created_at>=$1' + (campaignId ? ' AND r.campaign_id=$2' : '');
    const params = [new Date(Date.now() - days * 86400000).toISOString(), ...(campaignId ? [campaignId] : [])];
    const r = (await db.prepare(`SELECT count(*) total,
      count(*) FILTER(WHERE a.assessment::jsonb->>'risk'='unknown') unknown_count,
      count(*) FILTER(WHERE a.assessment::jsonb #>> '{identity,status}'='verified') verified,
      count(*) FILTER(WHERE a.assessment::jsonb->>'risk'='high') high_risk,
      count(*) FILTER(WHERE a.assessment::jsonb->>'risk' IN ('low','medium') AND a.assessment::jsonb #>> '{identity,status}'!='verified' AND coalesce(r.context::jsonb #>> '{edge,verifiedBot}','false')!='true') qualifying,
      count(*) FILTER(WHERE a.assessment::jsonb #>> '{identity,status}'='verified' OR a.assessment::jsonb->>'risk'='high' OR r.context::jsonb #>> '{edge,verifiedBot}'='true') excluded,
      count(*) FILTER(WHERE r.collection IN ('complete','partial')) collected,
      count(*) FILTER(WHERE r.collection!='not-requested') requested,coalesce(sum(r.cost_cents),0) cost,
      count(*) FILTER(WHERE a.assessment::jsonb->>'recommendedAction'!='allow') would_act,
      count(*) FILTER(WHERE r.actual_action!='allow') restricted
      FROM relay.traffic_requests r JOIN relay.traffic_assessments a ON a.sequence=(SELECT max(sequence) FROM relay.traffic_assessments WHERE request_id=r.id)${clauses}`).get(...params))!;
    return { total: Number(r.total), qualifying: Number(r.qualifying), excluded: Number(r.excluded), unknown: Number(r.unknown_count), verifiedCrawlers: Number(r.verified), highRisk: Number(r.high_risk), collected: Number(r.collected), requested: Number(r.requested), estimatedCost: Number(r.cost) / 100, wouldAct: Number(r.would_act), actualRestricted: Number(r.restricted) };
  }
  async function maintain(now = Date.now()) {
    return transactional(store, async () => {
      const c = await config(); const at = new Date(now).toISOString(); const cutoff = new Date(now - c.retentionDays * 86400000).toISOString();
      await db.prepare("UPDATE relay.traffic_requests SET collection='expired' WHERE collection='pending' AND id IN(SELECT request_id FROM relay.telemetry_sessions WHERE expires_at<=$1 AND completed_at IS NULL)").run(at);
      await db.prepare("UPDATE relay.traffic_requests SET context=jsonb_set(jsonb_set(context::jsonb,'{ip}','null'),'{sourceIp}','null')::text WHERE created_at<$1 AND context::jsonb->>'ip' IS NOT NULL").run(new Date(now - c.rawIpDays * 86400000).toISOString());
      const removed = (await db.prepare('DELETE FROM relay.traffic_requests WHERE created_at<$1').run(cutoff)).changes;
      await db.prepare('DELETE FROM relay.crawler_requests WHERE identity IS NOT NULL AND created_at<$1').run(cutoff);
      await db.prepare('DELETE FROM relay.traffic_config_history WHERE changed_at<$1 AND sequence!=(SELECT max(sequence) FROM relay.traffic_config_history)').run(cutoff);
      await db.prepare('DELETE FROM relay.traffic_policies WHERE id NOT IN(SELECT policy_id FROM relay.traffic_requests) AND id NOT IN(SELECT policy_id FROM relay.traffic_config_history)').run();
      await db.prepare(`WITH cited(revision) AS (
        SELECT value #>> '{}' FROM relay.traffic_assessments a CROSS JOIN LATERAL jsonb_path_query(a.assessment::jsonb,'$.identity.**.revision') evidence(value)
        UNION SELECT value #>> '{}' FROM relay.crawler_requests r CROSS JOIN LATERAL jsonb_path_query(r.identity::jsonb,'$.**.revision') evidence(value)
      ) DELETE FROM relay.intelligence_revisions WHERE expires_at<$1 AND revision NOT IN(SELECT revision FROM cited WHERE revision IS NOT NULL)
        AND revision NOT IN(SELECT revision FROM relay.intelligence_revisions i WHERE fetched_at=(SELECT max(fetched_at) FROM relay.intelligence_revisions WHERE service=i.service))`).run(cutoff);
      return { removed, maintainedAt: at };
    });
  }
  return { config, saveConfig, history, policyVersion, insert, appendAssessment, action, get, publicRecord, list, detail, browser, summary, maintain };
}
export type TrafficRepository = ReturnType<typeof trafficRepository>;
