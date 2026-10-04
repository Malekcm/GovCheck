import type { AppConfig } from '../config';
import type { Db } from '../db';
import { json } from '../db';
import { createFeedAdapter, type FeedConfig } from './genericFeed';
import { dhsApfsAdapter } from './dhsApfs';
import { gsaForecastAdapter } from './gsaForecast';
import { grantsGovAdapter } from './grantsGov';
import { samAwardsAdapter } from './sam/samAwards';
import { samBulkAdapter } from './sam/samBulk';
import { samOpportunitiesAdapter } from './sam/samOpportunities';
import { sbaSubnetAdapter } from './sbaSubnet';
import type { SourceAdapter } from './types';
import { usaspendingAdapter } from './usaspending';

/** Built-in connectors in default run order (SAM API first so it gets the request budget). */
export const BUILTIN_ADAPTERS: SourceAdapter[] = [
  samOpportunitiesAdapter,
  samAwardsAdapter,
  gsaForecastAdapter,
  dhsApfsAdapter,
  sbaSubnetAdapter,
  grantsGovAdapter,
  usaspendingAdapter,
  samBulkAdapter,
];

export interface ConnectorRow {
  id: string;
  name: string;
  source_type: string;
  base_url: string | null;
  access_method: string;
  enabled: boolean;
  auth_required: boolean;
  auth_env_var: string | null;
  priority: number;
  schedule_minutes: number | null;
  config: Record<string, unknown>;
  cursor: Record<string, unknown>;
  health: string;
  health_message: string | null;
  last_attempted_at: string | null;
  last_success_at: string | null;
  last_run_id: string | null;
  next_run_at: string | null;
  records_retrieved_total: number;
  is_custom: boolean;
  notes: string | null;
}

/** Make sure every built-in connector has a registry row. Never overwrites user settings, cursors or enablement. */
export async function ensureConnectors(db: Db, config: AppConfig): Promise<void> {
  for (const a of BUILTIN_ADAPTERS) {
    const m = a.meta;
    const configured = a.isConfigured(config);
    await db.query(
      `INSERT INTO source_connectors (id, name, source_type, base_url, access_method, enabled, auth_required, auth_env_var, priority, schedule_minutes, notes, health, health_message, config)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, source_type = EXCLUDED.source_type, base_url = EXCLUDED.base_url,
         access_method = EXCLUDED.access_method, auth_required = EXCLUDED.auth_required, auth_env_var = EXCLUDED.auth_env_var,
         priority = EXCLUDED.priority, notes = EXCLUDED.notes,
         health = CASE WHEN $14 THEN (CASE WHEN source_connectors.health = 'not_configured' THEN 'unknown' ELSE source_connectors.health END) ELSE 'not_configured' END,
         health_message = CASE WHEN $14 THEN (CASE WHEN source_connectors.health = 'not_configured' THEN NULL ELSE source_connectors.health_message END) ELSE EXCLUDED.health_message END,
         updated_at = now()`,
      [
        m.id,
        m.name,
        m.sourceType,
        m.baseUrl,
        m.accessMethod,
        m.authRequired,
        m.authEnvVar ?? null,
        m.priority,
        m.defaultScheduleMinutes,
        m.notes ?? null,
        configured.configured ? 'unknown' : 'not_configured',
        configured.configured ? null : configured.reason ?? 'Not configured',
        json({}),
        configured.configured,
      ],
    );
  }
}

/** Derived intelligence engines are registered like connectors so their runs and health are visible. */
export const ENGINES: { id: string; name: string; notes: string }[] = [
  { id: 'engine:recompete', name: 'Recompete intelligence engine', notes: 'Finds expiring contracts relevant to your profile and creates POSSIBLE RECOMPETE signals when no successor procurement exists.' },
  { id: 'engine:enrichment', name: 'Incumbent & pricing enrichment', notes: 'Pulls related award history from USAspending, identifies possible incumbents and comparable awards, and estimates likely value ranges.' },
  { id: 'engine:documents', name: 'Document intelligence', notes: 'Downloads public solicitation documents (respecting budgets and robots.txt), extracts text and derived requirements.' },
  { id: 'engine:ai', name: 'AI extraction (Claude)', notes: 'Optional. Structured requirement extraction and plain-English summaries, cached by content hash.' },
  { id: 'engine:scoring', name: 'Matching & scoring', notes: 'Explainable fit score, eligibility rules and learned preference score.' },
  { id: 'engine:coverage', name: 'Coverage analysis', notes: 'Detects forecast-only, subcontract-only, orphan awards, duplicates, conflicts and stale records.' },
];

export async function ensureEngines(db: Db): Promise<void> {
  for (const e of ENGINES) {
    await db.query(
      `INSERT INTO source_connectors (id, name, source_type, access_method, enabled, priority, notes, health)
       VALUES ($1,$2,'engine','manual',true,80,$3,'unknown') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, notes = EXCLUDED.notes`,
      [e.id, e.name, e.notes],
    );
  }
}

export function builtinAdapter(id: string): SourceAdapter | undefined {
  return BUILTIN_ADAPTERS.find((a) => a.meta.id === id);
}

export async function getAdapter(db: Db, id: string): Promise<SourceAdapter | null> {
  const builtin = builtinAdapter(id);
  if (builtin) return builtin;
  const row = await db.one<ConnectorRow>('SELECT * FROM source_connectors WHERE id = $1', [id]);
  if (!row || !row.is_custom) return null;
  return createFeedAdapter({ id: row.id, name: row.name, priority: row.priority, notes: row.notes ?? undefined }, row.config as unknown as FeedConfig);
}

export async function listAdapters(db: Db): Promise<SourceAdapter[]> {
  const rows = await db.query<ConnectorRow>('SELECT * FROM source_connectors WHERE is_custom = true ORDER BY created_at');
  return [...BUILTIN_ADAPTERS, ...rows.map((row) => createFeedAdapter({ id: row.id, name: row.name, priority: row.priority, notes: row.notes ?? undefined }, row.config as unknown as FeedConfig))];
}

/** Connector precedence map (lower = more authoritative), including derived pseudo-sources. */
export async function connectorPriorities(db: Db): Promise<Map<string, number>> {
  const rows = await db.query<{ id: string; priority: number }>('SELECT id, priority FROM source_connectors');
  const map = new Map(rows.map((r) => [r.id, r.priority]));
  map.set('user', 0);
  map.set('derived', 80);
  map.set('ai', 90);
  return map;
}
