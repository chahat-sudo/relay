import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDatabase, databaseUrl } from '../server/database.ts';
import { importSqlite } from '../server/sqlite-import.ts';

const configured = databaseUrl(process.env.DATABASE_URL);
if (!configured.ok) throw new Error(configured.error.message);
const root = fileURLToPath(new URL('../', import.meta.url));
// Keep the source offline for the entire import and until PostgreSQL-backed Relay is started.
for (const port of [4180, 4181]) {
  try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) }); throw new Error(`Stop the Relay listener on port ${port} before migrating.`); }
  catch (error) { if (error instanceof Error && error.message.startsWith('Stop the Relay')) throw error; }
}
const url = new URL(configured.value);
const expectedProject = new URL(process.env.VITE_SUPABASE_URL ?? '').hostname.split('.')[0];
if (!(url.hostname === `db.${expectedProject}.supabase.co` || decodeURIComponent(url.username).endsWith(`.${expectedProject}`))) throw new Error('DATABASE_URL does not identify the configured Supabase project. No connection was made.');
const parent = path.join(root, 'data/migration-backups'); mkdirSync(parent, { recursive: true });
const backupDirectory = path.join(parent, `sqlite-to-supabase-${Date.now()}`);
const ca = process.env.RELAY_DATABASE_CA_FILE ? readFileSync(process.env.RELAY_DATABASE_CA_FILE, 'utf8') : undefined;
const db = connectDatabase(configured.value, { migration: true, ca });
try {
  const result = await importSqlite(db, path.join(root, 'data/relay.sqlite'), path.join(root, 'data/.local-key'), backupDirectory);
  console.log(JSON.stringify({ verified: result.verified, duplicate: result.duplicate, tables: result.tables.map(t => ({ table: t.table, rows: t.rows })), manifest: path.join(backupDirectory, 'manifest.json') }, null, 2));
} catch {
  throw new Error('Supabase migration did not finish. The SQLite source and available snapshots remain intact. Check connection access, target schema and source compatibility before retrying.');
} finally { await db.close(); }
