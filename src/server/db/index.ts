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

type DbConfig = Pick<AppConfig, 'databaseUrl' | 'pgliteDir'> &
  Partial<Pick<AppConfig, 'databaseSslCaFile' | 'databaseSslCaPem' | 'databaseSslCaBase64' | 'databaseSslAllowUnverified' | 'databasePoolMax'>>;

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/**
 * Resolve the CA certificate used to verify the database server. Sources, in order:
 * DATABASE_SSL_CA_PEM (the certificate text), DATABASE_SSL_CA_BASE64 (the same text,
 * base64-encoded on one line — easiest for GitHub/Render secrets), DATABASE_SSL_CA_FILE.
 * Returns where it came from so startup logs can say so without printing it.
 */
export function resolveCaCertificate(config: DbConfig): { ca: string; source: 'pem' | 'base64' | 'file' } | null {
  if (config.databaseSslCaPem) {
    // Secrets UIs sometimes turn newlines into literal "\n".
    const pem = config.databaseSslCaPem.replace(/\\n/g, '\n').trim();
    if (!PEM_RE.test(pem)) throw new Error('DATABASE_SSL_CA_PEM does not contain a PEM certificate (expected -----BEGIN CERTIFICATE-----).');
    return { ca: pem, source: 'pem' };
  }
  if (config.databaseSslCaBase64) {
    const decoded = Buffer.from(config.databaseSslCaBase64.replace(/\s+/g, ''), 'base64').toString('utf8').trim();
    if (!PEM_RE.test(decoded)) throw new Error('DATABASE_SSL_CA_BASE64 did not decode to a PEM certificate. Encode the whole .crt file, e.g. `base64 -w0 prod-ca-2021.crt`.');
    return { ca: decoded, source: 'base64' };
  }
  if (config.databaseSslCaFile) return { ca: fs.readFileSync(config.databaseSslCaFile, 'utf8'), source: 'file' };
  return null;
}

/**
 * TLS for remote Postgres. Certificates are verified by default. Supabase signs with its
 * own CA: supply it through DATABASE_SSL_CA_PEM / DATABASE_SSL_CA_BASE64 / DATABASE_SSL_CA_FILE.
 * DATABASE_SSL_ALLOW_UNVERIFIED=true is an explicit, documented opt-out (not recommended).
 */
export function sslOptions(config: DbConfig): pg.PoolConfig['ssl'] {
  const url = config.databaseUrl ?? '';
  if (isLocalDatabaseUrl(url) || /sslmode=disable/.test(url)) return undefined;
  const ca = resolveCaCertificate(config);
  if (ca) return { ca: ca.ca, rejectUnauthorized: true };
  if (config.databaseSslAllowUnverified) return { rejectUnauthorized: false };
  return true;
}

export function isLocalDatabaseUrl(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(url).hostname);
  } catch {
    return /localhost|127\.0\.0\.1/.test(url);
  }
}

/** A log-safe description of the database target: host, port and database name only — never credentials. */
export function describeDatabaseUrl(url: string | undefined): string {
  if (!url) return 'embedded PGlite';
  try {
    const u = new URL(url);
    return `PostgreSQL at ${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname || ''}`;
  } catch {
    return 'PostgreSQL (unparseable DATABASE_URL)';
  }
}

/** How the database connection is secured (labels only — never the certificate or URL). */
export function describeTls(config: DbConfig): string {
  try {
    const ssl = sslOptions(config);
    if (ssl === undefined) return 'local connection (no TLS)';
    const ca = resolveCaCertificate(config);
    if (ca) return `TLS verified with custom CA (${ca.source === 'file' ? 'DATABASE_SSL_CA_FILE' : ca.source === 'pem' ? 'DATABASE_SSL_CA_PEM' : 'DATABASE_SSL_CA_BASE64'})`;
    if (typeof ssl === 'object' && ssl.rejectUnauthorized === false) return 'TLS WITHOUT certificate verification (DATABASE_SSL_ALLOW_UNVERIFIED=true)';
    return 'TLS verified with system CAs';
  } catch (err) {
    return `TLS misconfigured: ${(err as Error).message}`;
  }
}

/**
 * node-postgres treats sslmode=require/verify-* in the URL as "build my own TLS config",
 * which would silently replace the verified CA configured above. Strip those parameters so
 * the explicit `ssl` option is always the one in force.
 */
export function stripSslParams(url: string): string {
  try {
    const u = new URL(url);
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) {
      if (k === 'sslmode' && u.searchParams.get(k) === 'disable') continue;
      u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return url;
  }
}

export async function createDb(config: DbConfig, opts: { memory?: boolean } = {}): Promise<Db> {
  if (config.databaseUrl && !opts.memory) {
    const pool = new pg.Pool({
      connectionString: stripSslParams(config.databaseUrl),
      max: config.databasePoolMax ?? 8,
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
