import fs from 'node:fs';
import type { AppDeps } from './app';
import { loadConfig, type AppConfig } from './config';
import { ensureConnectors, ensureEngines } from './connectors/registry';
import { createDb } from './db';
import { runMigrations } from './db/migrate';
import { FetchHttpClient, userAgent } from './lib/http';
import { createLogger } from './lib/logger';
import { budgetFor } from './pipeline/budget';
import { recoverInterruptedRuns } from './pipeline/sync';
import { runSeed } from './seed';

/** Load .env (if present) without overriding variables already set in the environment. */
export function loadEnvFile(path = '.env') {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** Create all server dependencies: config, database (migrated + seeded), HTTP client, budgets. */
export async function bootstrap(overrides: Partial<AppConfig> = {}): Promise<AppDeps> {
  loadEnvFile();
  const config = { ...loadConfig(), ...overrides };
  const log = createLogger('goi');
  const db = await createDb(config);
  const migrations = await runMigrations(db, config.migrationsDir);
  if (migrations.applied.length) log.info(`Applied migrations: ${migrations.applied.join(', ')}`);
  await runSeed(db);
  await ensureConnectors(db, config);
  await ensureEngines(db);
  const interrupted = await recoverInterruptedRuns(db);
  if (interrupted) log.warn(`Marked ${interrupted} interrupted sync run(s) as failed.`);
  const http = new FetchHttpClient({ userAgent: userAgent(config.contactEmail) });
  return { db, config, http, log, budget: budgetFor(db, config) };
}
