import type { AppConfig } from '../config';
import type { Db } from '../db';
import type { RequestBudget } from '../connectors/types';

/**
 * Daily request budgets persisted in the database (api_usage), so limits are
 * respected across restarts, scheduled runs and on-demand refreshes.
 * SAM.gov resets daily quotas at midnight UTC-ish; we use the UTC date.
 */
export class DbRequestBudget implements RequestBudget {
  constructor(
    private db: Db,
    private limits: Record<string, number>,
  ) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
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

  async consume(key: string, n = 1): Promise<void> {
    if (this.limits[key] !== undefined && (await this.remaining(key)) < n) {
      throw new BudgetExhaustedError(key);
    }
    await this.db.query(
      `INSERT INTO api_usage (connector_id, usage_date, requests) VALUES ($1, $2, $3)
       ON CONFLICT (connector_id, usage_date) DO UPDATE SET requests = api_usage.requests + EXCLUDED.requests`,
      [key, this.today(), n],
    );
  }
}

export class BudgetExhaustedError extends Error {
  constructor(readonly key: string) {
    super(`Daily request budget for ${key.toUpperCase()} is exhausted. It resets tomorrow (UTC).`);
    this.name = 'BudgetExhaustedError';
  }
}

export function budgetFor(db: Db, config: AppConfig): DbRequestBudget {
  return new DbRequestBudget(db, { sam: config.samDailyRequestLimit });
}
