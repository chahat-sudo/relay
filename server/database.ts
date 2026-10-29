import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types } from 'pg';
import type { Result } from '../shared/traffic.ts';

export type SqlValue = string | number | boolean | null;
export type Row = Record<string, SqlValue>;
export interface QueryResult { rows: unknown[]; changes: number; }
export interface DatabaseConnection {
  query(sql: string, values?: SqlValue[]): Promise<QueryResult>;
  release(discard?: boolean): void;
}
export interface DatabaseDriver {
  acquire(): Promise<DatabaseConnection>;
  close(): Promise<void>;
}

function rows(value: unknown[]): Row[] {
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Database returned a malformed row.');
    for (const field of Object.values(row)) {
      if (field !== null && typeof field !== 'string' && typeof field !== 'number' && typeof field !== 'boolean') throw new Error('Database returned an unsupported field type.');
      if (typeof field === 'number' && !Number.isFinite(field)) throw new Error('Database returned a non-finite number.');
    }
    return row as Row;
  });
}

/** Owns connections and transaction context. All SQL uses PostgreSQL syntax and $n parameters. */
export class Database {
  private context = new AsyncLocalStorage<DatabaseConnection>();
  private closing: Promise<void> | null = null;
  private stopped = false;
  readonly driver: DatabaseDriver;
  constructor(driver: DatabaseDriver) { this.driver = driver; }
  private async query(sql: string, values: SqlValue[] = []): Promise<QueryResult> {
    const active = this.context.getStore();
    if (active) return active.query(sql, values);
    if (this.stopped) throw new Error('Database is shutting down.');
    const connection = await this.driver.acquire();
    try { return await connection.query(sql, values); } finally { connection.release(); }
  }
  prepare(sql: string) {
    return {
      all: async (...values: SqlValue[]) => rows((await this.query(sql, values)).rows),
      get: async (...values: SqlValue[]) => rows((await this.query(sql, values)).rows)[0],
      run: async (...values: SqlValue[]) => ({ changes: (await this.query(sql, values)).changes }),
    };
  }
  async exec(sql: string): Promise<void> { await this.query(sql); }
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    if (this.stopped) throw new Error('Database is shutting down.');
    const connection = await this.driver.acquire(); let discard = false;
    try {
      await connection.query('BEGIN');
      // One workspace owns routing/accounting. Re-read eligibility after acquiring the shared lock.
      await connection.query('SELECT pg_advisory_xact_lock(734982, 1)');
      const result = await this.context.run(connection, work);
      await connection.query('COMMIT'); return result;
    } catch (error) {
      try { await connection.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally { connection.release(discard); }
  }
  close(): Promise<void> {
    this.stopped = true;
    return this.closing ??= this.driver.close().catch(error => { this.closing = null; throw error; });
  }
}

export function databaseUrl(value: unknown): Result<string> {
  if (typeof value !== 'string' || !value) return { ok: false, error: { kind: 'invalid', message: 'Set DATABASE_URL to the Supabase PostgreSQL direct or session-pooler connection string in .env.' } };
  let url: URL; try { url = new URL(value); } catch { return { ok: false, error: { kind: 'invalid', message: 'DATABASE_URL must be a valid PostgreSQL connection string.' } }; }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password) return { ok: false, error: { kind: 'invalid', message: 'DATABASE_URL must include a PostgreSQL host, user and password.' } };
  if (url.hostname.endsWith('.pooler.supabase.com') && url.port === '6543') return { ok: false, error: { kind: 'invalid', message: 'Use the Supabase session pooler on port 5432 for this persistent Node server.' } };
  return { ok: true, value };
}

export function connectDatabase(connectionString: string, options: { migration?: boolean; ca?: string } = {}) {
  const parsed = databaseUrl(connectionString); if (!parsed.ok) throw new Error(parsed.error.message);
  const url = new URL(parsed.value); const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) url.searchParams.delete(key);
  const integer = (text: string) => { const n = Number(text); if (!Number.isSafeInteger(n)) throw new Error('Database integer exceeds the supported exact-number range.'); return n; };
  const pool = new Pool({
    connectionString: url.href, max: 5, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000,
    statement_timeout: options.migration ? 30000 : 10000,
    ssl: local ? false : { rejectUnauthorized: true, ...(options.ca ? { ca: options.ca } : {}) },
    types: { getTypeParser: (oid, format) => oid === 20 ? integer : types.getTypeParser(oid, format) },
    application_name: options.migration ? 'relay-migration' : 'relay',
  });
  const initialized = new WeakSet<object>();
  pool.on('error', () => { console.error('An idle PostgreSQL connection failed; the pool will replace it.'); });
  return new Database({
    async acquire() {
      const client = await pool.connect();
      try {
        if (!options.migration && !initialized.has(client)) { await client.query('SET ROLE relay_backend'); initialized.add(client); }
      } catch (error) { client.release(true); throw error; }
      return {
        async query(sql, values = []) {
          const result = await client.query(sql, values);
          const last = Array.isArray(result) ? result.at(-1) : result;
          return { rows: last?.rows ?? [], changes: last?.rowCount ?? 0 };
        },
        release(discard) { client.release(discard); },
      };
    },
    close: () => pool.end(),
  });
}
