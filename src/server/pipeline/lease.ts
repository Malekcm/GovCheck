import crypto from 'node:crypto';
import os from 'node:os';
import type { Db } from '../db';
import { json } from '../db';

/**
 * Cross-process single-flight lock for source ingestion.
 *
 * The in-process lock in sync.ts only protects one Node process. With a shared Supabase
 * database the hosted web app (manual "Check due sources now") and the GitHub Actions
 * scheduled job are separate processes, so the lock also lives in the database as a lease
 * row in app_state with an expiry. The holder renews it while working; if the holder dies
 * the lease simply expires and the next process can proceed. All timestamps use the
 * database clock so hosts with skewed clocks agree.
 */
export const SYNC_LEASE_KEY = 'sync:lease';
export const SYNC_LEASE_TTL_MS = 10 * 60_000;

export interface LeaseInfo {
  holder: string;
  label: string;
  host: string;
  acquiredAt: string;
  expiresAt: string;
}

/** Identity of this process (stable for its lifetime). */
export const PROCESS_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

export async function acquireLease(db: Db, label: string, holder = PROCESS_ID, ttlMs = SYNC_LEASE_TTL_MS): Promise<boolean> {
  const row = await db.one<{ key: string }>(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ($1, jsonb_build_object('holder', $2::text, 'label', $3::text, 'host', $4::text, 'acquiredAt', now(), 'expiresAt', now() + ($5::int * interval '1 millisecond')), now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     WHERE (app_state.value->>'expiresAt')::timestamptz < now() OR app_state.value->>'holder' = $2::text
     RETURNING key`,
    [SYNC_LEASE_KEY, holder, label.slice(0, 200), os.hostname(), Math.round(ttlMs)],
  );
  return !!row;
}

/** Extend a lease we hold. Returns false if it was lost (expired and taken by someone else). */
export async function renewLease(db: Db, holder = PROCESS_ID, ttlMs = SYNC_LEASE_TTL_MS): Promise<boolean> {
  const row = await db.one<{ key: string }>(
    `UPDATE app_state SET value = jsonb_set(value, '{expiresAt}', to_jsonb(now() + ($3::int * interval '1 millisecond'))), updated_at = now()
     WHERE key = $1 AND value->>'holder' = $2 RETURNING key`,
    [SYNC_LEASE_KEY, holder, Math.round(ttlMs)],
  );
  return !!row;
}

export async function releaseLease(db: Db, holder = PROCESS_ID): Promise<void> {
  await db.query(`DELETE FROM app_state WHERE key = $1 AND value->>'holder' = $2`, [SYNC_LEASE_KEY, holder]);
}

/** The unexpired lease, if any process currently holds one. */
export async function currentLease(db: Db): Promise<LeaseInfo | null> {
  const row = await db.one<{ value: LeaseInfo }>(`SELECT value FROM app_state WHERE key = $1 AND (value->>'expiresAt')::timestamptz > now()`, [SYNC_LEASE_KEY]);
  return row?.value ?? null;
}

/** Record when the scheduled job last ran (shown as "last scheduled check" in the UI). */
export async function recordSchedulerHeartbeat(db: Db, triggeredBy: string, summary: Record<string, unknown>): Promise<void> {
  await db.query(`INSERT INTO app_state (key, value) VALUES ('scheduler:last', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [
    json({ at: new Date().toISOString(), triggeredBy, host: os.hostname(), ...summary }),
  ]);
}
