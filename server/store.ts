import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Campaign, Destination, Article, Rule, Settings } from '../shared/types.ts';

export function openStore(directory: string) {
  mkdirSync(directory, { recursive: true });
  const hadDatabase = existsSync(path.join(directory, 'relay.sqlite'));
  const db = new DatabaseSync(path.join(directory, 'relay.sqlite'));
  const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
  if (version > 2) { db.close(); throw new Error('This database belongs to a newer Relay version. Use the matching application.'); }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS destinations(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','paused')),daily_cap INTEGER NOT NULL CHECK(daily_cap>=0),created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,source TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','paused')),cost_cents INTEGER NOT NULL,fallback_id TEXT REFERENCES destinations(id),rules TEXT NOT NULL,postback_token TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS clicks(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),destination_id TEXT NOT NULL REFERENCES destinations(id),rule_name TEXT NOT NULL,visitor_hash TEXT NOT NULL,device TEXT NOT NULL,source TEXT NOT NULL,external_id TEXT NOT NULL,cost_cents INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS clicks_campaign_date ON clicks(campaign_id,created_at);
    CREATE INDEX IF NOT EXISTS clicks_destination_date ON clicks(destination_id,created_at);
    CREATE TABLE IF NOT EXISTS conversions(id TEXT PRIMARY KEY,click_id TEXT NOT NULL REFERENCES clicks(id),campaign_id TEXT NOT NULL REFERENCES campaigns(id),transaction_id TEXT NOT NULL,revenue_cents INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('approved','rejected')),created_at TEXT NOT NULL,UNIQUE(campaign_id,transaction_id));
    CREATE TABLE IF NOT EXISTS articles(id TEXT PRIMARY KEY,title TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,excerpt TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','published')),campaign_id TEXT REFERENCES campaigns(id),cta TEXT NOT NULL,origin TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,published_at TEXT);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  if (version < 2) {
    if (hadDatabase) {
      const backup = path.join(directory, `backup-before-crawler-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`);
      db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const columns = db.prepare('PRAGMA table_info(campaigns)').all();
      if (!columns.some(c => c.name === 'crawler_routing')) db.exec(`ALTER TABLE campaigns ADD COLUMN crawler_routing TEXT NOT NULL DEFAULT '{"enabled":false,"url":"","providers":["google","meta"]}'`);
      db.exec(`CREATE TABLE IF NOT EXISTS crawler_requests(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES campaigns(id),provider TEXT NOT NULL CHECK(provider IN ('google','meta')),user_agent TEXT NOT NULL,destination_url TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS crawler_requests_campaign_date ON crawler_requests(campaign_id,created_at);
        PRAGMA user_version=2; COMMIT;`);
    } catch (e) { db.exec('ROLLBACK'); db.close(); throw e; }
  }
  const keyFile = path.join(directory, '.local-key');
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = readFileSync(keyFile);
  if (key.length !== 32) throw new Error('The local encryption key is invalid. Preserve the data folder and restore its key.');
  const getSetting = (name: string, fallback = '') => (db.prepare('SELECT value FROM settings WHERE key=?').get(name)?.value as string | undefined) ?? fallback;
  const setSetting = (name: string, value: string) => db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(name, value);
  function secret() {
    const encrypted = getSetting('ai_key');
    if (!encrypted) return '';
    const [iv, tag, payload] = encrypted.split('.').map(x => Buffer.from(x, 'hex'));
    const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString();
  }
  function saveSecret(value: string) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    setSetting('ai_key', [iv, cipher.getAuthTag(), body].map(x => x.toString('hex')).join('.'));
  }
  const destinationRows = () => db.prepare(`SELECT d.*, (SELECT count(*) FROM clicks c WHERE c.destination_id=d.id AND c.created_at>=date('now')) AS clicks_today FROM destinations d ORDER BY d.created_at DESC`).all().map(r => ({ id: r.id, name: r.name, url: r.url, status: r.status, dailyCap: r.daily_cap, createdAt: r.created_at, clicksToday: r.clicks_today }) as unknown as Destination);
  const campaignRows = () => db.prepare(`SELECT c.*, (SELECT count(*) FROM clicks k WHERE k.campaign_id=c.id) clicks,(SELECT count(*) FROM conversions v WHERE v.campaign_id=c.id AND v.status='approved') conversions,(SELECT coalesce(sum(revenue_cents),0) FROM conversions v WHERE v.campaign_id=c.id AND v.status='approved') revenue,(SELECT coalesce(sum(cost_cents),0) FROM clicks k WHERE k.campaign_id=c.id) cost FROM campaigns c ORDER BY created_at DESC`).all().map(r => ({ id: r.id, name: r.name, slug: r.slug, source: r.source, status: r.status, costPerClick: Number(r.cost_cents) / 100, fallbackId: r.fallback_id ?? '', rules: JSON.parse(String(r.rules)) as Rule[], crawlerRouting: JSON.parse(String(r.crawler_routing)), postbackToken: r.postback_token, createdAt: r.created_at, clicks: r.clicks, conversions: r.conversions, revenue: Number(r.revenue) / 100, cost: Number(r.cost) / 100 }) as Campaign);
  const articleRows = () => db.prepare('SELECT * FROM articles ORDER BY updated_at DESC').all().map(r => ({ id: r.id, title: r.title, slug: r.slug, excerpt: r.excerpt, body: r.body, status: r.status, campaignId: r.campaign_id ?? '', cta: r.cta, origin: r.origin, createdAt: r.created_at, updatedAt: r.updated_at, publishedAt: r.published_at }) as Article);
  const settings = (): Settings => ({ siteName: getSetting('site_name', 'The Relay Journal'), siteDescription: getSetting('site_description', 'Ideas, field notes, and useful reads.'), aiBaseUrl: getSetting('ai_base_url', 'http://127.0.0.1:11434/v1'), aiModel: getSetting('ai_model', ''), hasApiKey: Boolean(getSetting('ai_key')) });
  return { db, key, getSetting, setSetting, secret, saveSecret, destinations: destinationRows, campaigns: campaignRows, articles: articleRows, settings };
}
export type Store = ReturnType<typeof openStore>;
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
