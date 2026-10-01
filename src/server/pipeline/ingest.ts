import { STAGE_LABELS, type Stage } from '../../shared/domain';
import type { Db } from '../db';
import type { Logger } from '../lib/logger';
import type { NormalizedOpportunity, RawRecord, SourceAdapter } from '../connectors/types';
import { addIdentifiers, fieldInputsFor, setContacts, setDates, setDocuments, setFieldValues, setFinancials, setLocations } from './apply';
import { applyAwardFacts, linkAwardExact, linkAwardToOpportunity, upsertAward } from './awards';
import { recomputeOpportunity } from './canonical';
import { recordEvent } from './events';
import { linkForecastReferences, linkSource, resolveOpportunity, suggestRelationships } from './resolve';
import { saveNormalized, storeSourceRecord, type StoredRecord } from './store';

export interface IngestStats {
  retrieved: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  opportunitiesCreated: number;
  opportunitiesUpdated: number;
}

export interface IngestContext {
  db: Db;
  connectorId: string;
  connectorName: string;
  adapter: SourceAdapter;
  priorities: Map<string, number>;
  log: Logger;
  /** Profiles touched in this run (for scoring / enrichment afterwards). */
  dirty: Set<string>;
  stats: IngestStats;
}

export function emptyStats(): IngestStats {
  return { retrieved: 0, created: 0, updated: 0, unchanged: 0, failed: 0, opportunitiesCreated: 0, opportunitiesUpdated: 0 };
}

const VERB: Partial<Record<Stage, string>> = {
  forecast: 'Forecast published',
  grant_forecast: 'Grant forecast published',
  award: 'Award notice posted',
  subcontract: 'Subcontract opportunity posted',
  grant_posted: 'Grant opportunity posted',
};

function postedDate(n: NormalizedOpportunity): string | null {
  return n.dates.find((d) => d.kind === 'posted')?.value ?? n.dates.find((d) => d.kind === 'updated')?.value ?? null;
}

/** Apply a normalized opportunity-type record to its canonical profile. */
async function applyOpportunityRecord(db: Db, n: NormalizedOpportunity, stored: StoredRecord, ictx: IngestContext): Promise<{ opportunityId: string; created: boolean }> {
  const res = await resolveOpportunity(db, n, stored.id);
  const oppId = res.opportunityId;
  const newlyLinked = await linkSource(db, oppId, stored.id, res.method === 'existing_link' ? 'exact' : res.method, 1, res.evidence);
  const ref = { opportunityId: oppId, connectorId: ictx.connectorId, sourceRecordId: stored.id };

  await addIdentifiers(db, oppId, n.identifiers, stored.id);
  await setFieldValues(db, ref, fieldInputsFor(n));
  await setDates(db, ref, n.dates);
  await setFinancials(db, ref, n.financials);
  await setContacts(db, ref, n.contacts);
  await setLocations(db, ref, n.place ?? null);
  await setLocations(db, ref, n.officeAddress ?? null, 'office');
  const newDocs = await setDocuments(db, ref, n.documents);

  if (n.award && (n.award.piid || n.award.awardee.name)) {
    const award = await upsertAward(db, n.award, ictx.connectorId, stored.id);
    await linkAwardToOpportunity(db, oppId, award.id, { relationship: 'award_of', confidence: 'high', method: 'exact', evidence: ['Award reported on this official award notice.'] });
    const row = await db.one<any>('SELECT * FROM awards WHERE id = $1', [award.id]);
    await applyAwardFacts(db, oppId, row, 'award_of', 'high');
    for (const other of await linkAwardExact(db, award.id)) ictx.dirty.add(other);
  }

  const occurred = postedDate(n);
  await recordEvent(db, oppId, {
    type: 'LIFECYCLE',
    isLifecycle: true,
    lifecycleStage: n.stage,
    title: `${VERB[n.stage] ?? `${STAGE_LABELS[n.stage] ?? n.stage} posted`} — ${ictx.connectorName}`,
    occurredAt: occurred,
    connectorId: ictx.connectorId,
    sourceRecordId: stored.id,
    dedupeKey: `life:${stored.id}:${n.stage}`,
    detail: { noticeType: n.noticeType, title: n.title, url: n.url },
  });

  if (!res.created && newlyLinked) {
    // A different source record joined an existing profile (cross-source consolidation).
    await recordEvent(db, oppId, { type: 'NEW_SOURCE', title: `${ictx.connectorName} record linked (${res.evidence.join('; ')})`, dedupeKey: `src:${stored.id}`, connectorId: ictx.connectorId, sourceRecordId: stored.id });
  }

  if (stored.status === 'changed' && stored.previousNormalized?.data) {
    const prev = stored.previousNormalized.data as NormalizedOpportunity;
    const prevPosted = postedDate(prev);
    if ((prevPosted && occurred && prevPosted !== occurred) || /amend|modif/i.test(n.title) || prev.title !== n.title) {
      await recordEvent(db, oppId, {
        type: 'AMENDMENT',
        title: `${ictx.connectorName} notice updated${occurred ? ` (re-posted ${occurred.slice(0, 10)})` : ''}`,
        occurredAt: occurred,
        isLifecycle: true,
        lifecycleStage: 'amendment',
        connectorId: ictx.connectorId,
        sourceRecordId: stored.id,
        dedupeKey: `amend:${stored.id}:${stored.contentHash}`,
        detail: { previousTitle: prev.title, title: n.title },
      });
    }
  }

  if (!res.created) {
    for (const url of newDocs) {
      await recordEvent(db, oppId, { type: 'NEW_DOCUMENT', title: `New document: ${n.documents.find((d) => d.url === url)?.filename ?? url.split('/').pop()}`, dedupeKey: `doc:${url}`, connectorId: ictx.connectorId, detail: { url } });
    }
  }

  await recomputeOpportunity(db, oppId, { priorities: ictx.priorities, isNew: res.created });
  if (res.created) {
    await suggestRelationships(db, oppId);
    await linkForecastReferences(db, oppId);
  }
  return { opportunityId: oppId, created: res.created };
}

/** Full pipeline for one raw record. Atomic: a failure leaves no partial profile changes. */
export async function ingestRecord(ictx: IngestContext, rec: RawRecord): Promise<'new' | 'changed' | 'unchanged'> {
  return ictx.db.tx(async (db) => {
    const stored = await storeSourceRecord(db, ictx.connectorId, rec, ictx.adapter.parserVersion);
    if (stored.status === 'unchanged' && !stored.reparse) return 'unchanged';
    const result = ictx.adapter.normalize({ ...rec, rawText: stored.rawText ?? undefined });
    await saveNormalized(db, stored.id, result ? { type: result.type, data: result.data } : null);
    if (!result) return stored.status;

    if (result.type === 'award') {
      const award = await upsertAward(db, result.data, ictx.connectorId, stored.id);
      for (const id of await linkAwardExact(db, award.id)) {
        await recomputeOpportunity(db, id, { priorities: ictx.priorities });
        ictx.dirty.add(id);
      }
      return stored.status;
    }

    const { opportunityId, created } = await applyOpportunityRecord(db, result.data, stored, ictx);
    ictx.dirty.add(opportunityId);
    if (created) ictx.stats.opportunitiesCreated++;
    else ictx.stats.opportunitiesUpdated++;
    return stored.status;
  });
}

/** Source records not seen in a full listing pass are marked — never deleted. */
export async function markUnseen(db: Db, connectorId: string, since: Date): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `UPDATE source_records SET seen_status = 'not_seen' WHERE connector_id = $1 AND last_seen_at < $2 AND seen_status = 'active' RETURNING id`,
    [connectorId, since],
  );
  if (!rows.length) return 0;
  const opps = await db.query<{ opportunity_id: string }>(
    `SELECT DISTINCT os.opportunity_id FROM opportunity_sources os WHERE os.source_record_id = ANY($1::uuid[])`,
    [rows.map((r) => r.id)],
  );
  for (const o of opps) {
    const active = await db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id WHERE os.opportunity_id = $1 AND sr.seen_status = 'active'`,
      [o.opportunity_id],
    );
    if (!active?.n) {
      await db.query(`UPDATE opportunities SET seen_status = 'not_seen' WHERE id = $1`, [o.opportunity_id]);
      await recordEvent(db, o.opportunity_id, {
        type: 'REMOVED_FROM_SOURCE',
        title: `No longer listed by ${connectorId} (kept; likely closed or archived at the source)`,
        dedupeKey: `unseen:${connectorId}:${since.toISOString().slice(0, 10)}`,
      });
    }
  }
  return rows.length;
}
