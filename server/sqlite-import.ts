import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { importTables, initializeSchema, type ImportTable } from './database-schema.ts';
import type { Database, Row, SqlValue } from './database.ts';

type TableEvidence = { table: string; rows: number; sha256: string };
function value(raw: unknown): SqlValue {
  if (typeof raw === 'bigint') return raw.toString();
  if (raw === null || typeof raw === 'string' || (typeof raw === 'number' && Number.isSafeInteger(raw))) return raw;
  throw new Error('Unsupported SQLite field. No value was coerced or discarded.');
}
function canonical(table: ImportTable, row: Row) {
  return JSON.stringify(table.columns.map(column => {
    const field = row[column];
    if (field === undefined) throw new Error(`Missing source field: ${table.name}.${column}`);
    return field !== null && (table.integers as readonly string[]).includes(column) ? ['integer', String(field)] : ['value', field];
  })) + '\n';
}
function sourceRows(source: DatabaseSync, table: ImportTable, version: number) {
  if (version < table.since) return [][Symbol.iterator]() as IterableIterator<Row>;
  const columns = source.prepare(`PRAGMA table_info("${table.name}")`).all().map(c => String(c.name));
  if (!columns.length) throw new Error(`Expected SQLite table is missing: ${table.name}`);
  if (columns.some(c => !(table.columns as readonly string[]).includes(c))) throw new Error(`Unexpected columns in ${table.name}; refusing a lossy import.`);
  const expressions = table.columns.map(column => {
    if (columns.includes(column)) return `"${column}"`;
    if (table.name === 'campaigns' && column === 'crawler_routing' && version < 2) return `'${JSON.stringify({ enabled: false, url: '', providers: ['google', 'meta'] })}' AS crawler_routing`;
    if (table.name === 'crawler_requests' && column === 'identity' && version < 4) return 'NULL AS identity';
    if (table.name === 'traffic_labels' && column === 'sequence') return 'rowid AS sequence';
    throw new Error(`Expected SQLite column is missing: ${table.name}.${column}`);
  });
  const statement = source.prepare(`SELECT ${expressions.join(',')} FROM "${table.name}" ORDER BY "${table.key}"`); statement.setReadBigInts(true);
  return (function* () { for (const row of statement.iterate()) yield Object.fromEntries(Object.entries(row).map(([k, v]) => [k, value(v)])); })();
}
function sourceEvidence(source: DatabaseSync, version: number): TableEvidence[] {
  return importTables.map(table => {
    const digest = createHash('sha256'); let rows = 0;
    for (const row of sourceRows(source, table, version)) { digest.update(canonical(table, row)); rows++; }
    return { table: table.name, rows, sha256: digest.digest('hex') };
  });
}
async function verify(db: Database, expected: TableEvidence[]) {
  for (const table of importTables) {
    const digest = createHash('sha256'); let count = 0;
    const order = (table.integers as readonly string[]).includes(table.key) ? table.key : `${table.key} COLLATE "C"`;
    while (true) {
      const rows = await db.prepare(`SELECT ${table.columns.join(',')} FROM relay.${table.name} ORDER BY ${order} LIMIT 200 OFFSET $1`).all(count);
      for (const row of rows) { digest.update(canonical(table, row)); count++; }
      if (rows.length < 200) break;
    }
    const evidence = expected.find(e => e.table === table.name)!;
    if (count !== evidence.rows || digest.digest('hex') !== evidence.sha256) throw new Error(`Import verification failed for ${table.name}. No cutover is allowed.`);
  }
}
/** Imports only into an empty workspace; reruns verify an identical import instead of overwriting data. */
export async function importSqlite(db: Database, sourcePath: string, keyPath: string, backupDirectory: string) {
  const key = readFileSync(keyPath); if (key.length !== 32) throw new Error('The original .local-key must be exactly 32 bytes.');
  mkdirSync(backupDirectory, { recursive: false });
  const snapshot = path.join(backupDirectory, 'relay.sqlite');
  const live = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    const sourceVersion = Number(live.prepare('PRAGMA user_version').get()!.user_version);
    if (![1, 2, 3, 4].includes(sourceVersion)) throw new Error('Unrecognized SQLite schema version; the source was not modified.');
    const before = live.prepare('PRAGMA data_version').get()!.data_version;
    await backup(live, snapshot);
    copyFileSync(keyPath, path.join(backupDirectory, '.local-key'));
    if (live.prepare('PRAGMA data_version').get()!.data_version !== before) throw new Error('SQLite changed while taking the snapshot. Stop all writers before retrying.');
    const source = new DatabaseSync(snapshot, { readOnly: true });
    try {
      const unknown = source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().filter(r => !importTables.some(t => t.name === r.name));
      if (unknown.length) throw new Error('The source contains unrecognized tables. Review them before migrating; no tables were discarded.');
      if (source.prepare('PRAGMA foreign_key_check').get()) throw new Error('SQLite has unresolved foreign-key violations; the snapshot is retained for review.');
      const tables = sourceEvidence(source, sourceVersion); const sourceDigest = createHash('sha256').update(JSON.stringify(tables)).digest('hex');
      const keyDigest = createHash('sha256').update(key).digest('hex');
      await initializeSchema(db);
      let duplicate = false;
      await db.transaction(async () => {
        const state = await db.prepare('SELECT key_digest,import_digest FROM relay.workspace_state WHERE id=$1').get('default');
        if (state) {
          if (state.import_digest !== sourceDigest || state.key_digest !== keyDigest) throw new Error('The target already contains another workspace or a different source revision. Nothing was overwritten.');
          await verify(db, tables); duplicate = true; return;
        }
        for (const table of importTables) if (Number((await db.prepare(`SELECT count(*) n FROM relay.${table.name}`).get())!.n)) throw new Error('The target relay schema is not empty; refusing to merge or overwrite records.');
        for (const table of importTables) {
          let batch: Row[] = []; let bytes = 0;
          const flush = async () => {
            if (!batch.length) return;
            const values: SqlValue[] = [];
            const groups = batch.map(row => '(' + table.columns.map(column => { values.push(row[column]); return '$' + values.length; }).join(',') + ')');
            await db.prepare(`INSERT INTO relay.${table.name}(${table.columns.join(',')}) VALUES ${groups.join(',')}`).run(...values);
            batch = []; bytes = 0;
          };
          for (const row of sourceRows(source, table, sourceVersion)) {
            const size = Buffer.byteLength(canonical(table, row));
            if (batch.length >= 100 || bytes + size > 1024 * 1024) await flush();
            batch.push(row); bytes += size;
          }
          await flush();
        }
        for (const table of ['traffic_assessments', 'traffic_config_history', 'traffic_labels']) await db.prepare(`SELECT setval(pg_get_serial_sequence('relay.${table}','sequence'),coalesce((SELECT max(sequence) FROM relay.${table}),1),(SELECT count(*)>0 FROM relay.${table}))::text`).get();
        await verify(db, tables);
        if (live.prepare('PRAGMA data_version').get()!.data_version !== before) throw new Error('SQLite changed during import. PostgreSQL changes were rolled back; stop all writers and retry.');
        await db.prepare('INSERT INTO relay.workspace_state VALUES($1,$2,$3,$4)').run('default', keyDigest, sourceDigest, new Date().toISOString());
      });
      const report = { source: path.resolve(sourcePath), snapshot: path.resolve(snapshot), sourceVersion, sourceDigest, duplicate, verified: true, tables, completedAt: new Date().toISOString() };
      writeFileSync(path.join(backupDirectory, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      return report;
    } finally { source.close(); }
  } finally { live.close(); }
}
