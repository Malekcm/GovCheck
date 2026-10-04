import type { AppConfig } from '../config';
import type { Db } from '../db';

/**
 * Database / storage diagnostics for administrators. Read-only: GovCheck never deletes
 * history to stay under a size limit — it only warns, so a person can decide (upgrade the
 * plan, switch the bulk source to focused mode, disable a source).
 */
export interface StorageDiagnostics {
  database: 'postgres' | 'pglite';
  counts: Record<string, number>;
  sizeBytes: number | null;
  sizeMb: number | null;
  warnMb: number;
  limitMb: number;
  usagePct: number | null;
  largestTables: { table: string; bytes: number; rows: number | null }[];
  versionGrowth: { day: string; versions: number; snapshots: number; events: number }[];
  syncVolume: { day: string; runs: number; retrieved: number; created: number; updated: number; unchanged: number }[];
  avgVersionsPerRecord: number | null;
  projectedDaysToLimit: number | null;
  level: 'ok' | 'warning' | 'critical' | 'unknown';
  warnings: string[];
}

const COUNTED = [
  'opportunities',
  'source_records',
  'source_record_versions',
  'opportunity_snapshots',
  'opportunity_events',
  'opportunity_field_values',
  'opportunity_documents',
  'awards',
  'sync_runs',
  'user_opportunity_decisions',
  'user_notes',
];

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export async function storageDiagnostics(db: Db, config: Pick<AppConfig, 'dbSizeWarnMb' | 'dbSizeLimitMb'>): Promise<StorageDiagnostics> {
  const counts: Record<string, number> = {};
  for (const t of COUNTED) counts[t] = (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`))?.n ?? 0;
  counts.opportunities_active = (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM opportunities WHERE merged_into_id IS NULL AND status IN ('active','forecast')`))?.n ?? 0;

  const sizeBytes = await safe(async () => (await db.one<{ b: number }>('SELECT pg_database_size(current_database())::bigint AS b'))?.b ?? null, null as number | null);
  const largestTables = await safe(
    async () =>
      (
        await db.query<{ table: string; bytes: number; rows: number }>(
          `SELECT c.relname AS table, pg_total_relation_size(c.oid)::bigint AS bytes, c.reltuples::bigint AS rows
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY 2 DESC LIMIT 12`,
        )
      ).map((r) => ({ ...r, rows: r.rows >= 0 ? r.rows : null })),
    [] as StorageDiagnostics['largestTables'],
  );
  const versionGrowth = await db.query<any>(
    `SELECT d::date::text AS day,
       (SELECT count(*)::int FROM source_record_versions v WHERE v.created_at >= d AND v.created_at < d + interval '1 day') AS versions,
       (SELECT count(*)::int FROM opportunity_snapshots s WHERE s.created_at >= d AND s.created_at < d + interval '1 day') AS snapshots,
       (SELECT count(*)::int FROM opportunity_events e WHERE e.detected_at >= d AND e.detected_at < d + interval '1 day') AS events
     FROM generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d ORDER BY d`,
  );
  const syncVolume = await db.query<any>(
    `SELECT started_at::date::text AS day, count(*)::int AS runs, COALESCE(sum(records_retrieved),0)::int AS retrieved, COALESCE(sum(records_created),0)::int AS created,
       COALESCE(sum(records_updated),0)::int AS updated, COALESCE(sum(records_unchanged),0)::int AS unchanged
     FROM sync_runs WHERE started_at > now() - interval '14 days' AND connector_id NOT LIKE 'engine:%' GROUP BY 1 ORDER BY 1`,
  );
  const avgVersionsPerRecord = counts.source_records ? Number((counts.source_record_versions / counts.source_records).toFixed(2)) : null;

  const sizeMb = sizeBytes != null ? Math.round((sizeBytes / 1024 / 1024) * 10) / 10 : null;
  const usagePct = sizeMb != null ? Math.round((sizeMb / config.dbSizeLimitMb) * 1000) / 10 : null;
  const warnings: string[] = [];
  let level: StorageDiagnostics['level'] = sizeMb == null ? 'unknown' : 'ok';

  // Rough projection: recent daily growth in stored rows × average stored bytes per row.
  let projectedDaysToLimit: number | null = null;
  if (sizeBytes != null) {
    const recent = versionGrowth.slice(-7);
    const rowsPerDay = recent.reduce((s: number, d: any) => s + d.versions + d.snapshots + d.events, 0) / Math.max(1, recent.length);
    const totalRows = counts.source_record_versions + counts.opportunity_snapshots + counts.opportunity_events + counts.source_records;
    const bytesPerRow = totalRows ? sizeBytes / totalRows : 0;
    const growth = rowsPerDay * bytesPerRow;
    if (growth > 0) projectedDaysToLimit = Math.max(0, Math.round((config.dbSizeLimitMb * 1024 * 1024 - sizeBytes) / growth));
  }
  if (sizeMb != null) {
    if (sizeMb >= config.dbSizeLimitMb * 0.95) {
      level = 'critical';
      warnings.push(`Database is ${sizeMb} MB — at or near the ${config.dbSizeLimitMb} MB plan limit. Upgrade the database plan or reduce ingestion (SAM_BULK_INGEST_MODE=focused, disable unused sources). GovCheck does not delete history automatically.`);
    } else if (sizeMb >= config.dbSizeWarnMb) {
      level = 'warning';
      warnings.push(`Database is ${sizeMb} MB of ${config.dbSizeLimitMb} MB. Plan for an upgrade or narrower ingestion before it fills.`);
    }
  }
  if (projectedDaysToLimit != null && projectedDaysToLimit < 60) {
    if (level === 'ok') level = 'warning';
    warnings.push(`At the last week's growth rate the database reaches ${config.dbSizeLimitMb} MB in about ${projectedDaysToLimit} days.`);
  }
  if (avgVersionsPerRecord != null && avgVersionsPerRecord > 5) warnings.push(`Source records average ${avgVersionsPerRecord} stored versions each — check whether a source changes cosmetically on every fetch.`);

  return {
    database: db.kind,
    counts,
    sizeBytes,
    sizeMb,
    warnMb: config.dbSizeWarnMb,
    limitMb: config.dbSizeLimitMb,
    usagePct,
    largestTables,
    versionGrowth,
    syncVolume,
    avgVersionsPerRecord,
    projectedDaysToLimit,
    level,
    warnings,
  };
}
