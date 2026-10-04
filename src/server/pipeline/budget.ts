import type { AppConfig } from '../config';
import type { Db } from '../db';
import { json } from '../db';
import type { BudgetMeta, RequestBudget } from '../connectors/types';

/**
 * Why a SAM.gov request was spent, in priority order. Background work spends the budget
 * top-down (see samPriority.ts); interactive work (targeted search, manual refresh) may also
 * use the reserve that background work leaves untouched.
 */
export const SAM_CATEGORIES = [
  { id: 'tracked', label: 'Tracked opportunities (pursue / watch / capture)', interactive: false },
  { id: 'active_changes', label: 'Active opportunities: amendment checks', interactive: false },
  { id: 'stale_high_fit', label: 'Strong matches with stale data', interactive: false },
  { id: 'new_match', label: 'New likely matches: live enrichment', interactive: false },
  { id: 'targeted_search', label: 'Targeted searches (user requested)', interactive: true },
  { id: 'manual_refresh', label: 'Manual opportunity refreshes', interactive: true },
  { id: 'discovery', label: 'General discovery (new notices feed)', interactive: false },
  { id: 'awards', label: 'SAM contract awards', interactive: false },
  { id: 'documents', label: 'SAM attachment downloads', interactive: false },
  { id: 'test', label: 'Connection tests', interactive: true },
  { id: 'other', label: 'Other', interactive: false },
] as const;

export type SamCategory = (typeof SAM_CATEGORIES)[number]['id'];

/** GovCheck counts SAM usage per UTC day. */
export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** When GovCheck's daily counter rolls over (next 00:00 UTC). */
export function budgetResetsAt(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return d.toISOString();
}

/**
 * Daily request budgets persisted in the database (api_usage), so limits are respected
 * across restarts, scheduled runs and on-demand refreshes — and across processes: the hosted
 * web app and the GitHub Actions sync share one Supabase database and one counter.
 *
 * consume() is a single conditional upsert, so two processes can never jointly exceed the
 * limit. Every request is also journaled in api_request_log with its category.
 */
export class DbRequestBudget implements RequestBudget {
  constructor(
    private db: Db,
    private limits: Record<string, number>,
    private reserves: Record<string, number> = {},
  ) {}

  private today(): string {
    return utcToday();
  }

  limit(key: string): number | undefined {
    return this.limits[key];
  }

  /** Requests background work must leave unused for interactive use. */
  reserve(key: string): number {
    return this.reserves[key] ?? 0;
  }

  async used(key: string): Promise<number> {
    const row = await this.db.one<{ requests: number }>('SELECT requests FROM api_usage WHERE connector_id = $1 AND usage_date = $2', [key, this.today()]);
    return row?.requests ?? 0;
  }

  async remaining(key: string): Promise<number> {
    const limit = this.limits[key];
    if (limit === undefined) return Number.POSITIVE_INFINITY;
    return Math.max(0, limit - (await this.used(key)));
  }

  /** What background (scheduled) work may still spend today. */
  async backgroundRemaining(key: string): Promise<number> {
    return Math.max(0, (await this.remaining(key)) - this.reserve(key));
  }

  async consume(key: string, n = 1, meta: BudgetMeta = {}): Promise<void> {
    const limit = this.limits[key];
    const day = this.today();
    if (limit !== undefined) {
      if (n > limit) throw new BudgetExhaustedError(key);
      const row = await this.db.one<{ requests: number }>(
        `INSERT INTO api_usage (connector_id, usage_date, requests) VALUES ($1, $2, $3)
         ON CONFLICT (connector_id, usage_date) DO UPDATE SET requests = api_usage.requests + EXCLUDED.requests
         WHERE api_usage.requests + EXCLUDED.requests <= $4
         RETURNING requests`,
        [key, day, n, limit],
      );
      if (!row) throw new BudgetExhaustedError(key);
    } else {
      await this.db.query(
        `INSERT INTO api_usage (connector_id, usage_date, requests) VALUES ($1, $2, $3)
         ON CONFLICT (connector_id, usage_date) DO UPDATE SET requests = api_usage.requests + EXCLUDED.requests`,
        [key, day, n],
      );
    }
    await this.db
      .query(`INSERT INTO api_request_log (budget_key, usage_date, category, connector_id, requests, detail) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [
        key,
        day,
        meta.category ?? 'other',
        meta.connectorId ?? null,
        n,
        json(meta.detail ?? {}),
      ])
      .catch(() => undefined); // the journal is informational; the counter above is authoritative
  }

  async usageByCategory(key: string, day = this.today()): Promise<{ category: string; requests: number }[]> {
    return this.db.query<{ category: string; requests: number }>(
      `SELECT category, sum(requests)::int AS requests FROM api_request_log WHERE budget_key = $1 AND usage_date = $2 GROUP BY 1 ORDER BY 2 DESC`,
      [key, day],
    );
  }
}

/** A view of a budget that tags every request with a category (and connector) for the journal. */
export function withBudgetMeta(budget: RequestBudget, meta: BudgetMeta): RequestBudget {
  return {
    remaining: (key) => budget.remaining(key),
    consume: (key, n, extra) => budget.consume(key, n, { ...meta, ...(extra ?? {}), detail: { ...(meta.detail ?? {}), ...(extra?.detail ?? {}) } }),
  };
}

export class BudgetExhaustedError extends Error {
  constructor(readonly key: string) {
    super(`Daily request budget for ${key.toUpperCase()} is exhausted. GovCheck's counter resets at 00:00 UTC.`);
    this.name = 'BudgetExhaustedError';
  }
}

export function budgetFor(db: Db, config: AppConfig): DbRequestBudget {
  return new DbRequestBudget(db, { sam: config.samDailyRequestLimit }, { sam: config.samManualReserve });
}

export interface SamBudgetStatus {
  limit: number;
  used: number;
  remaining: number;
  reserve: number;
  backgroundAvailable: number;
  resetsAt: string;
  day: string;
  byCategory: { category: string; label: string; requests: number }[];
  recent: { requested_at: string; category: string; connector_id: string | null; requests: number; detail: Record<string, unknown> }[];
}

/** Everything the UI shows about today's SAM.gov budget. Read-only. */
export async function samBudgetStatus(db: Db, config: AppConfig): Promise<SamBudgetStatus> {
  const day = utcToday();
  const usedRow = await db.one<{ requests: number }>(`SELECT requests FROM api_usage WHERE connector_id = 'sam' AND usage_date = $1`, [day]);
  const used = usedRow?.requests ?? 0;
  const remaining = Math.max(0, config.samDailyRequestLimit - used);
  const cats = await db.query<{ category: string; requests: number }>(
    `SELECT category, sum(requests)::int AS requests FROM api_request_log WHERE budget_key = 'sam' AND usage_date = $1 GROUP BY 1`,
    [day],
  );
  const logged = cats.reduce((s, c) => s + c.requests, 0);
  const label = (id: string) => SAM_CATEGORIES.find((c) => c.id === id)?.label ?? id;
  const byCategory = cats.map((c) => ({ category: c.category, label: label(c.category), requests: c.requests }));
  // Requests counted before per-category journaling existed (or by an older build) are shown honestly.
  if (used > logged) byCategory.push({ category: 'unattributed', label: 'Not attributed (older build or before upgrade)', requests: used - logged });
  byCategory.sort((a, b) => b.requests - a.requests);
  const recent = await db.query<any>(
    `SELECT requested_at, category, connector_id, requests, detail FROM api_request_log WHERE budget_key = 'sam' ORDER BY requested_at DESC LIMIT 25`,
  );
  return {
    limit: config.samDailyRequestLimit,
    used,
    remaining,
    reserve: config.samManualReserve,
    backgroundAvailable: Math.max(0, remaining - config.samManualReserve),
    resetsAt: budgetResetsAt(),
    day,
    byCategory,
    recent,
  };
}
