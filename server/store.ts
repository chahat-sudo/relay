import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import type { Campaign, CampaignConfig, Destination, Article, Rule, Settings } from '../shared/types.ts';
import { Database, connectDatabase, databaseUrl } from './database.ts';

export function createStore(db: Database, key: Buffer) {
  if (key.length !== 32) throw new Error('The local encryption key is invalid. Restore the original .local-key.');
  const getSetting = async (name: string, fallback = '') => String((await db.prepare('SELECT value FROM relay.settings WHERE key=$1').get(name))?.value ?? fallback);
  const setSetting = async (name: string, value: string) => db.prepare('INSERT INTO relay.settings VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, value);
  async function secret() {
    const encrypted = await getSetting('ai_key'); if (!encrypted) return '';
    const [iv, tag, payload] = encrypted.split('.').map(x => Buffer.from(x, 'hex'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString();
  }
  async function saveSecret(value: string) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    await setSetting('ai_key', [iv, cipher.getAuthTag(), body].map(x => x.toString('hex')).join('.'));
  }
  const parseDestination = (r: Record<string, unknown>): Destination => ({ id: String(r.id), name: String(r.name), url: String(r.url), status: r.status as Destination['status'], dailyCap: Number(r.daily_cap), createdAt: String(r.created_at), clicksToday: Number(r.clicks_today) });
  const destinationRows = async () => (await db.prepare(`SELECT d.*, (SELECT count(*) FROM relay.clicks c WHERE c.destination_id=d.id AND c.created_at>=to_char(current_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD')) AS clicks_today FROM relay.destinations d ORDER BY d.created_at DESC`).all()).map(parseDestination);
  function parseCampaign(r: Record<string, unknown>): CampaignConfig {
    return { id: String(r.id), name: String(r.name), slug: String(r.slug), source: String(r.source), status: r.status as CampaignConfig['status'], costPerClick: Number(r.cost_cents) / 100, fallbackId: r.fallback_id === null ? '' : String(r.fallback_id), rules: JSON.parse(String(r.rules)) as Rule[], crawlerRouting: JSON.parse(String(r.crawler_routing)), postbackToken: String(r.postback_token), createdAt: String(r.created_at) };
  }
  const campaignRows = async (since: string | null = null) => (await db.prepare(`SELECT c.*, (SELECT count(*) FROM relay.clicks k WHERE k.campaign_id=c.id AND ($1::text IS NULL OR k.created_at>=$1)) clicks,(SELECT count(*) FROM relay.conversions v WHERE v.campaign_id=c.id AND v.status='approved' AND ($1::text IS NULL OR v.created_at>=$1)) conversions,(SELECT coalesce(sum(revenue_cents),0) FROM relay.conversions v WHERE v.campaign_id=c.id AND v.status='approved' AND ($1::text IS NULL OR v.created_at>=$1)) revenue,(SELECT coalesce(sum(cost_cents),0) FROM relay.clicks k WHERE k.campaign_id=c.id AND ($1::text IS NULL OR k.created_at>=$1)) cost FROM relay.campaigns c ORDER BY created_at DESC`).all(since)).map(r => ({ ...parseCampaign(r), clicks: Number(r.clicks), conversions: Number(r.conversions), revenue: Number(r.revenue) / 100, cost: Number(r.cost) / 100 }) satisfies Campaign);
  async function campaignConfig(by: 'id' | 'slug', value: string): Promise<CampaignConfig | null> {
    const row = await db.prepare(`SELECT * FROM relay.campaigns WHERE ${by === 'id' ? 'id' : 'slug'}=$1`).get(value); return row ? parseCampaign(row) : null;
  }
  async function routingDestinations(campaign: CampaignConfig): Promise<Destination[]> {
    const ids = [...new Set([...campaign.rules.flatMap(r => r.targets.map(t => t.destinationId)), ...(campaign.fallbackId ? [campaign.fallbackId] : [])])];
    if (!ids.length) return [];
    return (await db.prepare(`SELECT d.*,(SELECT count(*) FROM relay.clicks c WHERE c.destination_id=d.id AND c.created_at>=to_char(current_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD')) clicks_today FROM relay.destinations d WHERE d.id IN (SELECT jsonb_array_elements_text($1::jsonb))`).all(JSON.stringify(ids))).map(parseDestination);
  }
  const articleRows = async () => (await db.prepare('SELECT * FROM relay.articles ORDER BY updated_at DESC').all()).map(r => ({ id: r.id, title: r.title, slug: r.slug, excerpt: r.excerpt, body: r.body, status: r.status, campaignId: r.campaign_id ?? '', cta: r.cta, origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at, publishedAt: r.published_at }) as Article);
  const settings = async (): Promise<Settings> => ({ siteName: await getSetting('site_name', 'The Relay Journal'), siteDescription: await getSetting('site_description', 'Ideas, field notes, and useful reads.'), aiBaseUrl: await getSetting('ai_base_url', 'http://127.0.0.1:11434/v1'), aiModel: await getSetting('ai_model', ''), hasApiKey: Boolean(await getSetting('ai_key')) });
  return { db, key, getSetting, setSetting, secret, saveSecret, destinations: destinationRows, campaigns: campaignRows, campaignConfig, routingDestinations, articles: articleRows, settings };
}

export async function openStore(directory: string, connectionString: unknown = process.env.DATABASE_URL) {
  const parsed = databaseUrl(connectionString); if (!parsed.ok) throw new Error(parsed.error.message);
  const key = readFileSync(path.join(directory, '.local-key'));
  const ca = process.env.RELAY_DATABASE_CA_FILE ? readFileSync(process.env.RELAY_DATABASE_CA_FILE, 'utf8') : undefined;
  const db = connectDatabase(parsed.value, { ca });
  try {
    const state = await db.prepare('SELECT key_digest FROM relay.workspace_state WHERE id=$1').get('default');
    if (!state || state.key_digest !== createHash('sha256').update(key).digest('hex')) throw new Error('The PostgreSQL workspace is not initialized with this encryption key. Run the migration or restore its original .local-key.');
    return createStore(db, key);
  } catch (error) { await db.close(); throw error; }
}
export type Store = ReturnType<typeof createStore>;
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
