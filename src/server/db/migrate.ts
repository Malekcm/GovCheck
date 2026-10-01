import fs from 'node:fs';
import path from 'node:path';
import type { Db } from './index';

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Forward-only, idempotent migration runner. Each file in /migrations is applied
 * once, in lexical order, inside a transaction, and recorded in schema_migrations.
 */
export async function runMigrations(db: Db, migrationsDir: string): Promise<MigrationResult> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
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
    await db.tx(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    });
    result.applied.push(version);
  }
  return result;
}
