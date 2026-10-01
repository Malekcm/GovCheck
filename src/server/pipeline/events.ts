import type { Db } from '../db';
import { json } from '../db';

export interface EventInput {
  type: string;
  title: string;
  dedupeKey: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  detail?: Record<string, unknown>;
  connectorId?: string | null;
  sourceRecordId?: string | null;
  occurredAt?: string | Date | null;
  isLifecycle?: boolean;
  lifecycleStage?: string | null;
}

/** Append an event to an opportunity's history. Idempotent per (opportunity, dedupeKey). */
export async function recordEvent(db: Db, opportunityId: string, e: EventInput): Promise<boolean> {
  const row = await db.one<{ id: string }>(
    `INSERT INTO opportunity_events (opportunity_id, event_type, is_lifecycle, lifecycle_stage, title, field, old_value, new_value, detail, connector_id, source_record_id, occurred_at, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13)
     ON CONFLICT (opportunity_id, dedupe_key) DO NOTHING RETURNING id`,
    [
      opportunityId,
      e.type,
      e.isLifecycle ?? false,
      e.lifecycleStage ?? null,
      e.title,
      e.field ?? null,
      json(e.oldValue ?? null),
      json(e.newValue ?? null),
      json(e.detail ?? {}),
      e.connectorId ?? null,
      e.sourceRecordId ?? null,
      e.occurredAt ?? null,
      e.dedupeKey,
    ],
  );
  return !!row;
}
