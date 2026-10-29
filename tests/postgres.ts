import { PGlite } from '@electric-sql/pglite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { Database, type DatabaseDriver } from '../server/database.ts';
import { initializeSchema } from '../server/database-schema.ts';
import { createStore } from '../server/store.ts';

type Engine = { pg: PGlite; references: number; tail: Promise<void> };
const engines = new Map<string, Promise<Engine>>();
/** An embedded PostgreSQL engine, not a SQL mock. Does not establish Supabase network behavior. */
export async function openTestDatabase(directory: string) {
  const root = path.resolve(directory); mkdirSync(root, { recursive: true });
  let pending = engines.get(root);
  if (!pending) {
    pending = PGlite.create(path.join(root, 'postgres')).then(pg => ({ pg, references: 0, tail: Promise.resolve() }));
    engines.set(root, pending);
  }
  const engine = await pending; engine.references++;
  const driver: DatabaseDriver = {
    async acquire() {
      const previous = engine.tail; let release!: () => void;
      engine.tail = new Promise<void>(r => { release = r; }); await previous;
      return {
        async query(sql, values = []) {
          if (values.length) { const result = await engine.pg.query(sql, values); return { rows: result.rows, changes: result.affectedRows ?? 0 }; }
          const result = (await engine.pg.exec(sql)).at(-1); return { rows: result?.rows ?? [], changes: result?.affectedRows ?? 0 };
        },
        release() { release(); },
      };
    },
    async close() {
      engine.references--;
      if (!engine.references) { await engine.tail; await engine.pg.close(); engines.delete(root); }
    },
  };
  return new Database(driver);
}
export async function openTestStore(directory: string) {
  const db = await openTestDatabase(directory);
  await initializeSchema(db);
  const keyFile = path.join(directory, '.local-key');
  if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
  const key = readFileSync(keyFile);
  await db.prepare('INSERT INTO relay.workspace_state VALUES($1,$2,NULL,$3) ON CONFLICT DO NOTHING').run('default', createHash('sha256').update(key).digest('hex'), new Date().toISOString());
  return createStore(db, key);
}
