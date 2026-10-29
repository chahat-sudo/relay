import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database, databaseUrl } from '../server/database.ts';

test('transaction work and rollback retain one connection, including nested workflows', async () => {
  const calls: string[] = []; let acquired = 0; let released = 0;
  const db = new Database({
    async acquire() { acquired++; return { async query(sql) { calls.push(sql); return { rows: [], changes: 0 }; }, release() { released++; } }; },
    async close() {},
  });
  await assert.rejects(db.transaction(async () => {
    await db.prepare('SELECT $1').get(1);
    await db.transaction(async () => { await db.prepare('SELECT $1').get(2); });
    throw new Error('workflow failed');
  }), /workflow failed/);
  assert.equal(acquired, 1); assert.equal(released, 1); assert.equal(calls.at(-1), 'ROLLBACK');
  await db.close();
});

test('failed cleanup remains retryable while new work stays closed; database configuration fails closed', async () => {
  let attempts = 0;
  const db = new Database({ async acquire() { throw new Error('must not acquire'); }, async close() { if (++attempts === 1) throw new Error('cleanup failed'); } });
  const closing = db.close(); assert.equal(db.close(), closing); await assert.rejects(closing, /cleanup failed/);
  await assert.rejects(db.prepare('SELECT 1').get(), /shutting down/); await db.close(); assert.equal(attempts, 2);
  assert.equal(databaseUrl(undefined).ok, false); assert.equal(databaseUrl('https://example.test').ok, false);
  assert.equal(databaseUrl('postgresql://postgres.ref:password@aws-0.pooler.supabase.com:6543/postgres').ok, false);
});
