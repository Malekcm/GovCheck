import type { Db } from '../db';
import { json } from '../db';

/**
 * Capture tracking is user-owned state. Source refreshes never write these tables, and
 * tracking is independent of where an opportunity was discovered or which source is official.
 *
 * Legacy rule kept for opportunities without an explicit tracking row: a Pursue / Interested /
 * Watch decision or an active capture stage counts as tracked. An explicit Untrack wins.
 */
export const LEGACY_TRACKED_SQL = `(EXISTS (SELECT 1 FROM user_opportunity_decisions td WHERE td.opportunity_id = o.id AND td.is_current AND td.decision IN ('strong_pursue','pursue','partner_sub','interested','watch'))
  OR EXISTS (SELECT 1 FROM opportunity_capture tk WHERE tk.opportunity_id = o.id AND tk.pursuit_stage NOT IN ('discovered','lost','no_bid')))`;

/** Alias `o`. True when the team is tracking the opportunity. */
export const IS_TRACKED_SQL = `COALESCE((SELECT tr.tracked FROM opportunity_tracking tr WHERE tr.opportunity_id = o.id), ${LEGACY_TRACKED_SQL})`;

export interface TrackingChange {
  tracked: boolean;
  actorId?: string | null;
  requestId?: string | null;
  reason?: string;
}

/** Idempotent: repeating a request id, or setting the current value again, changes nothing. */
export async function setTracking(db: Db, opportunityId: string, change: TrackingChange): Promise<{ tracked: boolean; changed: boolean }> {
  return db.tx(async (tx) => {
    const opp = await tx.one<{ merged_into_id: string | null }>('SELECT merged_into_id FROM opportunities WHERE id = $1 FOR UPDATE', [opportunityId]);
    if (!opp) throw new Error('Opportunity not found.');
    if (opp.merged_into_id) throw new Error(`Opportunity was merged into ${opp.merged_into_id}.`);
    if (change.requestId) {
      const seen = await tx.one<{ change: any; opportunity_id: string }>('SELECT change, opportunity_id FROM opportunity_tracking_history WHERE request_id = $1', [change.requestId]);
      if (seen) {
        if (seen.opportunity_id !== opportunityId || seen.change.tracked !== change.tracked) throw new Error('Idempotency key was reused for a different change.');
        return { tracked: change.tracked, changed: false };
      }
    }
    const prev = await tx.one<{ tracked: boolean }>('SELECT tracked FROM opportunity_tracking WHERE opportunity_id = $1 FOR UPDATE', [opportunityId]);
    if (prev?.tracked === change.tracked) return { tracked: change.tracked, changed: false };
    if (prev)
      await tx.query(
        `UPDATE opportunity_tracking SET tracked = $2, updated_at = now(), updated_by = $3, version = version + 1,
           tracked_at = CASE WHEN $2 THEN now() ELSE tracked_at END, tracked_by = CASE WHEN $2 THEN $3 ELSE tracked_by END WHERE opportunity_id = $1`,
        [opportunityId, change.tracked, change.actorId ?? null],
      );
    else await tx.query('INSERT INTO opportunity_tracking (opportunity_id, tracked, tracked_by, updated_by) VALUES ($1,$2,$3,$3)', [opportunityId, change.tracked, change.actorId ?? null]);
    if (change.tracked) await tx.query(`INSERT INTO opportunity_capture (opportunity_id) VALUES ($1) ON CONFLICT (opportunity_id) DO NOTHING`, [opportunityId]);
    await tx.query('INSERT INTO opportunity_tracking_history (opportunity_id, actor_id, request_id, change) VALUES ($1,$2,$3,$4::jsonb)', [
      opportunityId,
      change.actorId ?? null,
      change.requestId ?? null,
      json({ tracked: change.tracked, previous: prev?.tracked ?? null, reason: change.reason ?? null }),
    ]);
    return { tracked: change.tracked, changed: true };
  });
}

export async function trackingState(db: Db, opportunityId: string) {
  const row = await db.one<any>(
    `SELECT ${IS_TRACKED_SQL} AS tracked, tr.tracked AS explicit, tr.tracked_at, tr.updated_at, m.name AS tracked_by_name
     FROM opportunities o LEFT JOIN opportunity_tracking tr ON tr.opportunity_id = o.id LEFT JOIN team_members m ON m.user_id = tr.tracked_by WHERE o.id = $1`,
    [opportunityId],
  );
  const history = await db.query(
    `SELECT h.change, h.created_at, m.name AS actor_name FROM opportunity_tracking_history h LEFT JOIN team_members m ON m.user_id = h.actor_id WHERE h.opportunity_id = $1 ORDER BY h.created_at DESC LIMIT 20`,
    [opportunityId],
  );
  return { tracked: !!row?.tracked, explicit: row?.explicit ?? null, trackedAt: row?.tracked_at ?? null, trackedBy: row?.tracked_by_name ?? null, history };
}
