import path from 'node:path';

export interface AppConfig {
  nodeEnv: string;
  port: number;
  appBaseUrl: string;
  /** Postgres connection string (Supabase). When absent an embedded PGlite database is used. */
  databaseUrl?: string;
  databaseSslCaFile?: string;
  /** Supabase CA certificate supplied as an environment secret (PEM text). Preferred on hosts without a filesystem. */
  databaseSslCaPem?: string;
  /** Same certificate, base64-encoded (single line — easiest to paste into GitHub/Render secrets). */
  databaseSslCaBase64?: string;
  databaseSslAllowUnverified: boolean;
  databasePoolMax: number;
  /** Refuse to start on the embedded PGlite database (hosted deployments must use DATABASE_URL). */
  requireDatabaseUrl: boolean;
  pgliteDir: string;
  migrationsDir: string;
  samApiKey?: string;
  /** Daily request ceiling shared by every SAM.gov API call (personal non-federal keys: 10/day). */
  samDailyRequestLimit: number;
  samDownloadDocuments: boolean;
  samBulkLookbackDays: number;
  samBulkMaxRecordsPerRun: number;
  /** focused = keep only notices relevant to the profile or already tracked; full = everything in the lookback window. */
  samBulkIngestMode: 'focused' | 'full';
  /** Extra NAICS prefixes always kept by focused bulk ingestion. */
  samBulkFocusNaicsPrefixes: string[];
  /** SAM requests held back from background work for interactive refreshes / targeted searches. */
  samManualReserve: number;
  /** Default ceiling of SAM requests a single targeted search may spend. */
  samTargetedSearchMaxRequests: number;
  /** Tracked (pursue / watch / capture) opportunities are live-checked when older than this. */
  samTrackedRefreshHours: number;
  /** High-fit active opportunities are live-checked when their SAM data is older than this. */
  samStaleDays: number;
  /** Fit score at which an opportunity counts as a strong match for SAM priority checks. */
  samPriorityMinFit: number;
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
  /** Storage diagnostics thresholds (Supabase Free includes 500 MB). */
  dbSizeWarnMb: number;
  dbSizeLimitMb: number;
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

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Default interactive reserve: ~20% of the daily SAM limit (2 of 10 for personal keys), at most 50. */
export function defaultSamReserve(limit: number): number {
  if (limit <= 1) return 0;
  return Math.min(50, Math.max(1, Math.round(limit * 0.2)));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const appPassword = nonEmpty(env.APP_PASSWORD);
  const samDailyRequestLimit = int(env.SAM_DAILY_REQUEST_LIMIT, 10);
  return {
    nodeEnv,
    port: int(env.PORT, 8787),
    appBaseUrl: nonEmpty(env.APP_BASE_URL) ?? 'http://localhost:5173',
    databaseUrl: nonEmpty(env.DATABASE_URL),
    databaseSslCaFile: nonEmpty(env.DATABASE_SSL_CA_FILE),
    databaseSslCaPem: nonEmpty(env.DATABASE_SSL_CA_PEM),
    databaseSslCaBase64: nonEmpty(env.DATABASE_SSL_CA_BASE64),
    databaseSslAllowUnverified: bool(env.DATABASE_SSL_ALLOW_UNVERIFIED, false),
    databasePoolMax: Math.max(1, int(env.DATABASE_POOL_MAX, 8)),
    requireDatabaseUrl: bool(env.REQUIRE_DATABASE_URL, false),
    pgliteDir: nonEmpty(env.PGLITE_DIR) ?? path.resolve('data', 'pglite'),
    migrationsDir: nonEmpty(env.MIGRATIONS_DIR) ?? path.resolve('migrations'),
    samApiKey: nonEmpty(env.SAM_API_KEY),
    samDailyRequestLimit,
    samDownloadDocuments: bool(env.SAM_DOWNLOAD_DOCUMENTS, false),
    samBulkLookbackDays: int(env.SAM_BULK_LOOKBACK_DAYS, 90),
    samBulkMaxRecordsPerRun: int(env.SAM_BULK_MAX_RECORDS_PER_RUN, 4000),
    samBulkIngestMode: (nonEmpty(env.SAM_BULK_INGEST_MODE) ?? 'focused').toLowerCase() === 'full' ? 'full' : 'focused',
    samBulkFocusNaicsPrefixes: list(env.SAM_BULK_FOCUS_NAICS_PREFIXES),
    samManualReserve: Math.max(0, Math.min(samDailyRequestLimit, int(env.SAM_MANUAL_RESERVE_REQUESTS, defaultSamReserve(samDailyRequestLimit)))),
    samTargetedSearchMaxRequests: Math.max(1, int(env.SAM_TARGETED_SEARCH_MAX_REQUESTS, 3)),
    samTrackedRefreshHours: Math.max(1, int(env.SAM_TRACKED_REFRESH_HOURS, 24)),
    samStaleDays: Math.max(1, int(env.SAM_STALE_DAYS, 7)),
    samPriorityMinFit: int(env.SAM_PRIORITY_MIN_FIT, 60),
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
    dbSizeWarnMb: int(env.DB_SIZE_WARN_MB, 400),
    dbSizeLimitMb: int(env.DB_SIZE_LIMIT_MB, 500),
  };
}

/** Names of secrets whose values must never be logged or sent to the browser. */
export const SECRET_ENV_NAMES = [
  'SAM_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'TARGET_DATABASE_URL',
  'CRON_SECRET',
  'APP_PASSWORD',
  'SESSION_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_SSL_CA_PEM',
  'DATABASE_SSL_CA_BASE64',
];
