import type { AppConfig } from '../config';
import type { Db } from '../db';

export type TangoCategory = 'manual' | 'background' | 'test';
export class TangoBlocked extends Error {}
type Ledger = {
  used: number; background_used: number; month_used: number; test_used: number;
  provider_remaining: number | null; provider_reset: string | null;
  blocked_until: string | null; last_dispatch: string | null; last_success: string | null;
  last_test_success: string | null; auth_blocked: boolean;
};

/** One account-wide row, deliberately shared even when different API keys are used. */
export class TangoBudget {
  constructor(private db: Db, private config: AppConfig['tango']) {}

  private async ledger(tx: Db, now: Date): Promise<Ledger> {
    const day = now.toISOString().slice(0, 10), month = day.slice(0, 7);
    await tx.query(`INSERT INTO tango_budget(account_id, usage_day, usage_month) VALUES ('tango',$1,$2)
      ON CONFLICT (account_id) DO NOTHING`, [day, month]);
    await tx.one(`SELECT account_id FROM tango_budget WHERE account_id='tango' FOR UPDATE`);
    return (await tx.one<Ledger>(`UPDATE tango_budget SET
      used=CASE WHEN usage_day<>$1::date THEN 0 ELSE used END,
      background_used=CASE WHEN usage_day<>$1::date THEN 0 ELSE background_used END,
      provider_remaining=CASE WHEN usage_day<>$1::date THEN NULL ELSE provider_remaining END,
      provider_reset=CASE WHEN usage_day<>$1::date THEN NULL ELSE provider_reset END,
      month_used=CASE WHEN usage_month<>$2 THEN 0 ELSE month_used END,
      usage_day=$1, usage_month=$2 WHERE account_id='tango' RETURNING *`, [day, month]))!;
  }

  private cap() { return Math.max(0, Math.min(this.config.internalCap, this.config.dailyLimit - this.config.providerReserve)); }

  async status() {
    return this.db.tx(async tx => {
      const { at } = (await tx.one<{ at: string }>('SELECT clock_timestamp() AS at'))!;
      const now = new Date(at), row = await this.ledger(tx, now);
      const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
      return { configured: !!this.config.apiKey, enabled: this.config.enabled, mode: this.config.enabled ? 'manual' : 'disabled',
        scheduled: false, allowance: this.config.dailyLimit, burstAllowance: 25, internalCap: this.cap(),
        protectedReserve: this.config.providerReserve, manualReserve: this.config.manualReserve,
        backgroundCap: Math.max(0, this.cap() - this.config.manualReserve), monthlyLimit: this.config.monthlyLimit,
        used: row.used, backgroundUsed: row.background_used, monthUsed: row.month_used, testUsed: row.test_used,
        providerRemaining: row.provider_remaining, providerReset: row.provider_reset, resetsAt,
        lastAttempt: row.last_dispatch, lastSuccess: row.last_success, lastTestSuccess: row.last_test_success,
        blockedUntil: row.blocked_until, authenticationBlocked: row.auth_blocked, persistence: 'transient-only' };
    });
  }

  async reserve(endpoint: string, category: TangoCategory): Promise<string> {
    return this.db.tx(async tx => {
      const { at } = (await tx.one<{ at: string }>('SELECT clock_timestamp() AS at'))!;
      const now = new Date(at), row = await this.ledger(tx, now);
      if (row.auth_blocked) throw new TangoBlocked('Authentication failed previously. Verify the server key and explicitly clear the authentication block.');
      if (row.blocked_until && new Date(row.blocked_until) > now) throw new TangoBlocked('Tango is cooling down after a provider rate limit.');
      if (row.used >= this.cap() || row.month_used >= this.config.monthlyLimit) throw new TangoBlocked('Tango internal request allocation exhausted.');
      if (category === 'background' && row.background_used >= Math.max(0, this.cap() - this.config.manualReserve)) throw new TangoBlocked('Manual research reserve protected.');
      if (row.provider_remaining !== null && row.provider_remaining <= this.config.providerReserve) throw new TangoBlocked('Provider safety reserve reached.');
      if (category === 'test' && row.test_used >= this.config.testMaxRequests) throw new TangoBlocked('Development connection tests have reached their lifetime request cap.');
      if (row.last_dispatch && now.getTime() - new Date(row.last_dispatch).getTime() < 3000) throw new TangoBlocked('Wait at least three seconds between Tango requests.');
      if (category === 'test' && await tx.one(`SELECT id FROM tango_requests WHERE account_id='tango' AND category='test' AND attempted_at > $1::timestamptz - interval '60 seconds' LIMIT 1`, [at])) throw new TangoBlocked('Connection test cooldown: wait one minute.');
      await tx.query(`UPDATE tango_budget SET used=used+1, month_used=month_used+1,
        background_used=background_used+$1, test_used=test_used+$2,
        provider_remaining=CASE WHEN provider_remaining IS NULL THEN NULL ELSE provider_remaining-1 END,
        last_dispatch=$3 WHERE account_id='tango'`, [category === 'background' ? 1 : 0, category === 'test' ? 1 : 0, at]);
      const request = await tx.one<{ id: string }>(`INSERT INTO tango_requests(account_id,endpoint,category,attempted_at) VALUES ('tango',$1,$2,$3) RETURNING id`, [endpoint, category, at]);
      return request!.id;
    });
  }

  async finish(id: string, status: number | null, headers = new Headers()) {
    const number = (name: string) => {
      const value = headers.get(name);
      return value !== null && /^\d+(\.\d+)?$/.test(value) ? Number(value) : null;
    };
    await this.db.tx(async tx => {
      await tx.one(`SELECT account_id FROM tango_budget WHERE account_id='tango' FOR UPDATE`);
      const remaining = number('x-ratelimit-daily-remaining');
      const dailyReset = number('x-ratelimit-daily-reset');
      // Reset headers are durations in seconds, NOT epoch timestamps.
      const wait = status === 429 ? Math.max(60, number('retry-after') ?? 0, number('x-ratelimit-reset') ?? 0,
        remaining === 0 ? dailyReset ?? 86400 : 0) : number('x-ratelimit-burst-remaining') === 0 ? Math.max(3, number('x-ratelimit-burst-reset') ?? 60) : 0;
      await tx.query(`UPDATE tango_budget SET
        provider_remaining=CASE WHEN $1::integer IS NULL THEN provider_remaining ELSE least(coalesce(provider_remaining,$1),$1) END,
        provider_reset=CASE WHEN $2::float IS NULL THEN provider_reset ELSE clock_timestamp()+$2 * interval '1 second' END,
        blocked_until=CASE WHEN $3::float>0 THEN greatest(coalesce(blocked_until,clock_timestamp()),clock_timestamp()+$3 * interval '1 second') ELSE blocked_until END,
        auth_blocked=auth_blocked OR $4,
        last_success=CASE WHEN $5 THEN clock_timestamp() ELSE last_success END,
        last_test_success=CASE WHEN $5 AND EXISTS(SELECT 1 FROM tango_requests WHERE id=$6 AND category='test') THEN clock_timestamp() ELSE last_test_success END
        WHERE account_id='tango' AND usage_day=(SELECT attempted_at AT TIME ZONE 'UTC' FROM tango_requests WHERE id=$6)::date`,
      [remaining, dailyReset, wait, status === 401, status !== null && status >= 200 && status < 300, id]);
      await tx.query(`UPDATE tango_requests SET finished_at=clock_timestamp(),outcome=$2,http_status=$3,provider_remaining=$4 WHERE id=$1`,
        [id, status === null ? 'network_or_payload_failure' : status >= 200 && status < 300 ? 'success' : 'http_error', status, remaining]);
    });
  }
}
