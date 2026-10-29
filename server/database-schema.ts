import { readFileSync } from 'node:fs';
import type { Database } from './database.ts';

export const schemaContract = 'relay-postgres-v1';
export const schemaSql = () => readFileSync(new URL('../supabase/migrations/20261029094245_relay_postgres_storage.sql', import.meta.url), 'utf8');
export async function initializeSchema(db: Database) {
  await db.transaction(async () => {
    const schema = await db.prepare("SELECT to_regnamespace('relay')::text AS name").get();
    if (schema?.name !== null) {
      const version = await db.prepare('SELECT version,contract FROM relay.schema_migrations ORDER BY version DESC LIMIT 1').get();
      if (version?.version !== 1 || version.contract !== schemaContract) throw new Error('The existing relay schema is not a recognized migration target. No tables were changed.');
      return;
    }
    await db.exec(schemaSql());
  });
}

export const importTables = [
  { name: 'destinations', columns: ['id','name','url','status','daily_cap','created_at'], key: 'id', integers: ['daily_cap'], since: 1 },
  { name: 'campaigns', columns: ['id','name','slug','source','status','cost_cents','fallback_id','rules','postback_token','created_at','crawler_routing'], key: 'id', integers: ['cost_cents'], since: 1 },
  { name: 'clicks', columns: ['id','campaign_id','destination_id','rule_name','visitor_hash','device','source','external_id','cost_cents','created_at'], key: 'id', integers: ['cost_cents'], since: 1 },
  { name: 'conversions', columns: ['id','click_id','campaign_id','transaction_id','revenue_cents','status','created_at'], key: 'id', integers: ['revenue_cents'], since: 1 },
  { name: 'articles', columns: ['id','title','slug','excerpt','body','status','campaign_id','cta','origin','created_at','updated_at','published_at'], key: 'id', integers: [], since: 1 },
  { name: 'settings', columns: ['key','value'], key: 'key', integers: [], since: 1 },
  { name: 'crawler_requests', columns: ['id','campaign_id','provider','user_agent','destination_url','source','created_at','identity'], key: 'id', integers: [], since: 2 },
  { name: 'traffic_policies', columns: ['id','policy'], key: 'id', integers: [], since: 3 },
  { name: 'traffic_config_history', columns: ['sequence','policy_id','changed_at','raw_config'], key: 'sequence', integers: ['sequence'], since: 3 },
  { name: 'traffic_requests', columns: ['id','campaign_id','click_id','source','external_id','created_at','context','destination_url','actual_action','mode','cost_cents','collection','session_key','policy_id','rate_count'], key: 'id', integers: ['cost_cents','rate_count'], since: 3 },
  { name: 'traffic_assessments', columns: ['sequence','request_id','created_at','assessment'], key: 'sequence', integers: ['sequence'], since: 3 },
  { name: 'traffic_observations', columns: ['id','request_id','kind','created_at','schema_version','facts'], key: 'id', integers: ['schema_version'], since: 3 },
  { name: 'telemetry_sessions', columns: ['request_id','token_hash','origin','expires_at','completed_at','payload_hash'], key: 'request_id', integers: [], since: 3 },
  { name: 'intelligence_revisions', columns: ['revision','service','source','fetched_at','expires_at','ranges'], key: 'revision', integers: [], since: 3 },
  { name: 'traffic_labels', columns: ['id','request_id','label','provenance','created_at','sequence'], key: 'id', integers: ['sequence'], since: 3 },
  { name: 'traffic_challenges', columns: ['token_hash','request_id','expires_at','completed_at'], key: 'token_hash', integers: [], since: 3 },
  { name: 'traffic_actions', columns: ['id','request_id','action','created_at','reason'], key: 'id', integers: [], since: 3 },
] as const;
export type ImportTable = typeof importTables[number];
