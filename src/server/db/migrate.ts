import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './index';

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/** Arbitrary constant identifying GovCheck's migration lock (pg_advisory_xact_lock key). */
const MIGRATION_LOCK_KEY = 7_420_311_901;

/**
 * Forward-only, idempotent migration runner. Each file in /migrations is applied
 * once, in lexical order, inside a transaction, and recorded in schema_migrations.
 *
 * On shared PostgreSQL several processes can start at once (the hosted web app waking up
 * while a GitHub Actions sync starts). Each migration therefore takes a transaction-scoped
 * advisory lock and re-checks schema_migrations before applying, so exactly one process
 * applies it and the others skip it.
 */
/** Migration versions shipped with this build (file names without .sql). */
export function availableMigrations(migrationsDir: string): string[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => f.replace(/\.sql$/, ''));
}

/** Versions recorded in schema_migrations (empty when the table does not exist yet). Read-only. */
export async function appliedMigrations(db: Db): Promise<string[]> {
  const exists = await db.one<{ t: string | null }>(`SELECT to_regclass('schema_migrations')::text AS t`);
  if (!exists?.t) return [];
  return (await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version);
}

export async function runMigrations(db: Db, migrationsDir: string): Promise<MigrationResult> {
  const createTable = () =>
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  // Two processes racing on CREATE TABLE IF NOT EXISTS can collide on the catalog; the loser retries.
  await createTable().catch(() => createTable());
  const done = new Set((await db.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) {
      result.alreadyApplied.push(version);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const applied = await db.tx(async (tx) => {
      if (tx.kind === 'postgres') {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
        if (await tx.one('SELECT 1 FROM schema_migrations WHERE version = $1', [version])) return false;
      }
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      return true;
    });
    (applied ? result.applied : result.alreadyApplied).push(version);
  }
  return result;
}
