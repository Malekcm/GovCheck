import fs from 'node:fs';
import type { AppDeps } from './app';
import { loadConfig, type AppConfig } from './config';
import { ensureConnectors, ensureEngines } from './connectors/registry';
import { createDb, describeDatabaseUrl, describeTls, resolveCaCertificate } from './db';
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
  if (!config.databaseUrl && config.requireDatabaseUrl) {
    throw new Error(
      'REQUIRE_DATABASE_URL is set but DATABASE_URL is empty. Hosted deployments must use the shared PostgreSQL/Supabase database — ' +
        'the embedded PGlite database would live on the host’s temporary disk and be lost on restart.',
    );
  }
  if (!config.databaseUrl && config.nodeEnv === 'production')
    log.warn('Running in production on the embedded PGlite database. Make sure the data directory is on a persistent volume, or set DATABASE_URL.');
  if (config.nodeEnv === 'production' && !config.appPassword) log.warn('APP_PASSWORD is not set: anyone who knows this URL can use GovCheck. Set APP_PASSWORD on hosted deployments.');
  if (config.nodeEnv === 'production' && config.appPassword && config.sessionSecret === config.appPassword)
    log.warn('SESSION_SECRET is not set; set a long random value so login cookies cannot be forged.');
  if (config.databaseUrl) {
    resolveCaCertificate(config); // validates DATABASE_SSL_CA_* early with a clear message
    log.info(`Database: ${describeDatabaseUrl(config.databaseUrl)} · ${describeTls(config)}`);
  }
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
