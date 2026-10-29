import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openTestDatabase } from './postgres.ts';
import { importSqlite } from '../server/sqlite-import.ts';
import { importTables } from '../server/database-schema.ts';

test('SQLite versions 1–4 import losslessly, verify reruns and refuse overwriting changed targets', async () => {
  for (const version of [1, 2, 3, 4]) {
    const folder = mkdtempSync(path.join(tmpdir(), 'relay-import-test-'));
    const sourceFile = path.join(folder, 'source.sqlite'); const keyFile = path.join(folder, '.local-key');
    writeFileSync(keyFile, randomBytes(32)); const source = new DatabaseSync(sourceFile);
    source.exec(readFileSync(new URL('./fixtures/sqlite-v4.sql', import.meta.url), 'utf8'));
    source.prepare('INSERT INTO destinations VALUES(?,?,?,?,?,?)').run('destination', 'Original', 'https://example.test/?source=original', 'active', 10, '2026-10-01T00:00:00.000Z');
    source.prepare('INSERT INTO settings VALUES(?,?)').run('source-evidence', '  preserve whitespace and https://example.test/a%2Fb  ');
    source.exec('PRAGMA foreign_keys=OFF');
    for (const table of [...importTables].reverse()) if (table.since > version) source.exec(`DROP TABLE ${table.name}`);
    if (version < 2) source.exec('ALTER TABLE campaigns DROP COLUMN crawler_routing');
    if (version === 2 || version === 3) source.exec('ALTER TABLE crawler_requests DROP COLUMN identity');
    source.exec(`PRAGMA user_version=${version}`); source.close();
    const before = readFileSync(sourceFile); const db = await openTestDatabase(path.join(folder, 'target'));
    try {
      const first = await importSqlite(db, sourceFile, keyFile, path.join(folder, 'backup-one'));
      assert.equal(first.verified, true); assert.equal(first.duplicate, false); assert.equal(first.tables.find(t => t.table === 'destinations')!.rows, 1);
      assert.equal((await db.prepare('SELECT value FROM relay.settings WHERE key=$1').get('source-evidence'))!.value, '  preserve whitespace and https://example.test/a%2Fb  ');
      const second = await importSqlite(db, sourceFile, keyFile, path.join(folder, 'backup-two')); assert.equal(second.duplicate, true);
      await db.prepare('UPDATE relay.destinations SET name=$1').run('Changed after cutover');
      await assert.rejects(importSqlite(db, sourceFile, keyFile, path.join(folder, 'backup-three')), /verification failed/);
      assert.deepEqual(readFileSync(sourceFile), before); assert.deepEqual(readFileSync(path.join(folder, 'backup-one/.local-key')), readFileSync(keyFile));
      await db.exec('SET ROLE relay_backend');
      assert.equal((await db.prepare('SELECT count(*) n FROM relay.destinations').get())!.n, 1);
      await assert.rejects(db.prepare('DELETE FROM relay.workspace_state').run(), /permission denied/);
    } finally {
      await db.close(); const resolved = path.resolve(folder); assert.equal(path.dirname(resolved), path.resolve(tmpdir())); assert.ok(path.basename(resolved).startsWith('relay-import-test-')); rmSync(resolved, { recursive: true });
    }
  }
});
