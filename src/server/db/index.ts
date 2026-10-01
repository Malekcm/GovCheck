import fs from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import type { AppConfig } from '../config';

/**
 * Minimal database abstraction so the exact same SQL runs on Supabase/PostgreSQL
 * (via node-postgres) and on embedded PGlite (local development & tests).
 *
 * Conventions:
 *  - Always use $1..$n placeholders.
 *  - JSON/JSONB parameters must be passed through `json()` (explicit JSON string).
 *  - Arrays are passed as JS arrays and cast in SQL (e.g. $1::text[]).
 */
export interface Db {
  readonly kind: 'postgres' | 'pglite';
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

const NUMERIC_OID = 1700;
const INT8_OID = 20;
const DATE_OID = 1082;

// ---------------------------------------------------------------------------
// node-postgres
// ---------------------------------------------------------------------------
pg.types.setTypeParser(NUMERIC_OID, (v) => (v === null ? null : Number.parseFloat(v)));
pg.types.setTypeParser(INT8_OID, (v) => (v === null ? null : Number.parseInt(v, 10)));
pg.types.setTypeParser(DATE_OID, (v) => v); // keep dates as YYYY-MM-DD strings

class PgClientDb implements Db {
  readonly kind = 'postgres' as const;
  constructor(private client: pg.PoolClient) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.client.query(sql, params as any[]);
    return res.rows as T[];
  }
  async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    // Already inside a transaction: use a savepoint so nested work stays atomic.
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
    await this.client.query(`SAVEPOINT ${sp}`);
    try {
      const out = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${sp}`);
      return out;
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      throw err;
    }
  }
  async close(): Promise<void> {
    /* owned by pool */
  }
}

class PgPoolDb implements Db {
  readonly kind = 'postgres' as const;
  constructor(private pool: pg.Pool) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(sql, params as any[]);
    return res.rows as T[];
  }
  async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(new PgClientDb(client));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// PGlite (embedded)
// ---------------------------------------------------------------------------
type PgliteLike = Pick<PGlite, 'query' | 'exec'>;

const pgliteParsers = {
  [NUMERIC_OID]: (v: string) => Number.parseFloat(v),
  [INT8_OID]: (v: string) => Number.parseInt(v, 10),
  [DATE_OID]: (v: string) => v,
};

class PgliteDb implements Db {
  readonly kind = 'pglite' as const;
  constructor(
    private conn: PgliteLike,
    private root: PGlite | null,
  ) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.conn.query<T>(sql, params as any[], { parsers: pgliteParsers });
    return res.rows;
  }
  async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }
  async exec(sql: string): Promise<void> {
    await this.conn.exec(sql);
  }
  async tx<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (!this.root) {
      // nested: PGlite transactions are not re-entrant, run inline
      return fn(this);
    }
    return this.root.transaction(async (t) => fn(new PgliteDb(t as unknown as PgliteLike, null)));
  }
  async close(): Promise<void> {
    if (this.root) await this.root.close();
  }
}

type DbConfig = Pick<AppConfig, 'databaseUrl' | 'pgliteDir'> & Partial<Pick<AppConfig, 'databaseSslCaFile' | 'databaseSslAllowUnverified'>>;

/**
 * TLS for remote Postgres. Certificates are verified by default. Supabase signs with its
 * own CA: download it from the Supabase dashboard and set DATABASE_SSL_CA_FILE.
 * DATABASE_SSL_ALLOW_UNVERIFIED=true is an explicit, documented opt-out.
 */
function sslOptions(config: DbConfig): pg.PoolConfig['ssl'] {
  const url = config.databaseUrl ?? '';
  if (/localhost|127\.0\.0\.1/.test(url) || /sslmode=disable/.test(url)) return undefined;
  if (config.databaseSslCaFile) return { ca: fs.readFileSync(config.databaseSslCaFile, 'utf8') };
  if (config.databaseSslAllowUnverified) return { rejectUnauthorized: false };
  return true;
}

export async function createDb(config: DbConfig, opts: { memory?: boolean } = {}): Promise<Db> {
  if (config.databaseUrl && !opts.memory) {
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 15_000,
      ssl: sslOptions(config),
    });
    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
    return new PgPoolDb(pool);
  }
  if (opts.memory) {
    const mem = await PGlite.create();
    return new PgliteDb(mem, mem);
  }
  fs.mkdirSync(config.pgliteDir, { recursive: true });
  const db = await PGlite.create(config.pgliteDir);
  return new PgliteDb(db, db);
}
