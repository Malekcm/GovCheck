import path from 'node:path';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  appBaseUrl: string;
  /** Postgres connection string (Supabase). When absent an embedded PGlite database is used. */
  databaseUrl?: string;
  databaseSslCaFile?: string;
  databaseSslAllowUnverified: boolean;
  pgliteDir: string;
  migrationsDir: string;
  samApiKey?: string;
  /** Daily request ceiling shared by every SAM.gov API call (personal non-federal keys: 10/day). */
  samDailyRequestLimit: number;
  samDownloadDocuments: boolean;
  samBulkLookbackDays: number;
  samBulkMaxRecordsPerRun: number;
  anthropicApiKey?: string;
  anthropicModel: string;
  aiMaxAnalysesPerRun: number;
  aiAutoAnalyzeMinFit: number;
  cronSecret?: string;
  appPassword?: string;
  sessionSecret: string;
  schedulerEnabled: boolean;
  documentMaxBytes: number;
  documentsPerRun: number;
  enrichPerRun: number;
  contactEmail?: string;
}

function int(v: string | undefined, fallback: number): number {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const appPassword = nonEmpty(env.APP_PASSWORD);
  return {
    nodeEnv,
    port: int(env.PORT, 8787),
    appBaseUrl: nonEmpty(env.APP_BASE_URL) ?? 'http://localhost:5173',
    databaseUrl: nonEmpty(env.DATABASE_URL),
    databaseSslCaFile: nonEmpty(env.DATABASE_SSL_CA_FILE),
    databaseSslAllowUnverified: bool(env.DATABASE_SSL_ALLOW_UNVERIFIED, false),
    pgliteDir: nonEmpty(env.PGLITE_DIR) ?? path.resolve('data', 'pglite'),
    migrationsDir: nonEmpty(env.MIGRATIONS_DIR) ?? path.resolve('migrations'),
    samApiKey: nonEmpty(env.SAM_API_KEY),
    samDailyRequestLimit: int(env.SAM_DAILY_REQUEST_LIMIT, 10),
    samDownloadDocuments: bool(env.SAM_DOWNLOAD_DOCUMENTS, false),
    samBulkLookbackDays: int(env.SAM_BULK_LOOKBACK_DAYS, 90),
    samBulkMaxRecordsPerRun: int(env.SAM_BULK_MAX_RECORDS_PER_RUN, 4000),
    anthropicApiKey: nonEmpty(env.ANTHROPIC_API_KEY),
    anthropicModel: nonEmpty(env.ANTHROPIC_MODEL) ?? 'claude-opus-5-5',
    aiMaxAnalysesPerRun: int(env.AI_MAX_ANALYSES_PER_RUN, 8),
    aiAutoAnalyzeMinFit: int(env.AI_AUTO_ANALYZE_MIN_FIT, 65),
    cronSecret: nonEmpty(env.CRON_SECRET),
    appPassword,
    sessionSecret: nonEmpty(env.SESSION_SECRET) ?? nonEmpty(env.CRON_SECRET) ?? appPassword ?? 'local-dev-session-secret',
    schedulerEnabled: bool(env.SCHEDULER_ENABLED, nodeEnv === 'production'),
    documentMaxBytes: int(env.DOCUMENT_MAX_BYTES, 25 * 1024 * 1024),
    documentsPerRun: int(env.DOCUMENTS_PER_RUN, 40),
    enrichPerRun: int(env.ENRICH_PER_RUN, 25),
    contactEmail: nonEmpty(env.CONTACT_EMAIL),
  };
}

/** Names of secrets whose values must never be logged or sent to the browser. */
export const SECRET_ENV_NAMES = ['SAM_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'CRON_SECRET', 'APP_PASSWORD', 'SESSION_SECRET', 'SUPABASE_SERVICE_ROLE_KEY'];
