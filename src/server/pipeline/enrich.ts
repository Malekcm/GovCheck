import type { Db } from '../db';
import { addMonths } from '../lib/dates';
import type { HttpClient } from '../lib/http';
import type { Logger } from '../lib/logger';
import { formatMoney, formatRange } from '../lib/money';
import { htmlToText, nameKey, tokenize } from '../lib/text';
import { searchRowToRecord, usaspendingAdapter, usaspendingSearch } from '../connectors/usaspending';
import { TfIdfModel } from '../scoring/similarity';
import { setFinancials } from './apply';
import { applyAwardFacts, linkAwardToOpportunity, setVendorRole } from './awards';
import { recomputeOpportunity } from './canonical';
import { emptyStats, ingestRecord, type IngestContext } from './ingest';

export interface EnrichDeps {
  db: Db;
  http: HttpClient;
  log: Logger;
  priorities: Map<string, number>;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Pull award history related to an opportunity from USAspending into the local database. */
export async function fetchRelatedAwards(deps: EnrichDeps, opp: any): Promise<number> {
  const naics = opp.naics_code as string | null;
  if (!naics && !opp.psc_code) return 0;
  const ictx: IngestContext = {
    db: deps.db,
    connectorId: 'usaspending',
    connectorName: 'USAspending.gov',
    adapter: usaspendingAdapter,
    priorities: deps.priorities,
    log: deps.log,
    dirty: new Set(),
    stats: emptyStats(),
  };
  const queries: Parameters<typeof usaspendingSearch>[1][] = [];
  const agencyFilter = opp.subtier_name ? { awardingSubAgency: opp.subtier_name } : opp.department_name ? { awardingAgency: opp.department_name } : {};
  if (naics) queries.push({ naics: [naics], ...agencyFilter });
  else if (opp.psc_code) queries.push({ psc: [opp.psc_code], ...agencyFilter });
  const terms = [...new Set(tokenize(opp.title).filter((t) => t.length > 3))].slice(0, 3);
  if (terms.length >= 2 && Object.keys(agencyFilter).length) queries.push({ keywords: [terms.join(' ')], ...agencyFilter });
  let n = 0;
  for (const q of queries) {
    try {
      const { results } = await usaspendingSearch({ http: deps.http }, q, { limit: 40 });
      for (const row of results) {
        await ingestRecord(ictx, searchRowToRecord(row));
        n++;
      }
    } catch (err) {
      deps.log.warn(`USAspending enrichment query failed for ${opp.id}`, err);
    }
  }
  return n;
}

interface AwardCand {
  id: string;
  piid: string | null;
  description: string | null;
  awardee_name: string | null;
  vendor_id: string | null;
  office_name: string | null;
  subtier_name: string | null;
  naics_code: string | null;
  psc_code: string | null;
  date_signed: string | null;
  pop_start: string | null;
  pop_current_end: string | null;
  pop_potential_end: string | null;
  total_obligated: number | null;
  base_and_all_options: number | null;
  connector_id: string;
  source_record_id: string | null;
  department_name: string | null;
  dollars_obligated: number | null;
  solicitation_id: string | null;
}

/**
 * Local incumbent / comparable / pricing analysis for one profile, using awards already
 * in the database. Links are labeled with confidence and evidence; probabilistic links
 * are replaced on each run, user-rejected links are never re-created.
 */
export async function analyzeIncumbency(deps: EnrichDeps, oppId: string): Promise<{ possibleIncumbents: number; comparables: number; estimate: boolean }> {
  const { db } = deps;
  const opp = await db.one<any>('SELECT * FROM opportunities WHERE id = $1', [oppId]);
  if (!opp || opp.opportunity_class === 'grant' || opp.opportunity_class === 'subcontract') return { possibleIncumbents: 0, comparables: 0, estimate: false };
  if (!opp.subtier_name && !opp.department_name) return { possibleIncumbents: 0, comparables: 0, estimate: false };

  const exactAwardIds = new Set(
    (await db.query<{ award_id: string }>(`SELECT award_id FROM opportunity_awards WHERE opportunity_id = $1 AND method <> 'probabilistic'`, [oppId])).map((r) => r.award_id),
  );
  const rejected = new Set((await db.query<{ award_id: string }>(`SELECT award_id FROM opportunity_awards WHERE opportunity_id = $1 AND status = 'rejected'`, [oppId])).map((r) => r.award_id));

  const agencyKey = nameKey(opp.subtier_name ?? opp.department_name);
  const cands = (
    await db.query<AwardCand>(
      `SELECT id, piid, description, awardee_name, vendor_id, office_name, subtier_name, naics_code, psc_code, date_signed, pop_start, pop_current_end, pop_potential_end,
              total_obligated, base_and_all_options, connector_id, source_record_id, department_name, dollars_obligated, solicitation_id
       FROM awards WHERE award_key NOT LIKE 'sam_notice:%' AND (naics_code = $1 OR ($2::text IS NOT NULL AND psc_code = $2))
       ORDER BY date_signed DESC NULLS LAST LIMIT 600`,
      [opp.naics_code, opp.psc_code],
    )
  ).filter((a) => nameKey(a.subtier_name) === agencyKey || nameKey(a.department_name) === agencyKey || (opp.subtier_name && nameKey(a.subtier_name).includes(agencyKey)));

  const oppText = `${opp.title} ${htmlToText(opp.description ?? '').slice(0, 4000)}`;
  const model = new TfIdfModel([oppText, ...cands.map((c) => c.description ?? '')]);
  const ov = model.vector(oppText);
  const anchor = new Date(opp.performance_start ?? opp.response_deadline ?? opp.posted_at ?? Date.now());
  const officeKey = nameKey(opp.office_name);

  const scored = cands
    .filter((a) => !exactAwardIds.has(a.id) && !rejected.has(a.id))
    .map((a) => {
      const sim = a.description ? model.cosine(ov, model.vector(a.description)) : 0;
      const sameOffice = !!officeKey && nameKey(a.office_name) === officeKey;
      const end = a.pop_current_end ? new Date(a.pop_current_end) : null;
      const monthsFromAnchor = end ? (end.getTime() - anchor.getTime()) / (30.4375 * 86_400_000) : null;
      const endProx = monthsFromAnchor == null ? 0 : monthsFromAnchor >= -12 && monthsFromAnchor <= 24 ? 1 - Math.abs(monthsFromAnchor - 3) / 27 : 0;
      return { a, sim, sameOffice, monthsFromAnchor, score: sim * 0.6 + (sameOffice ? 0.25 : 0) + Math.max(0, endProx) * 0.15 };
    });

  const incumbents = opp.stage === 'award' || opp.is_signal ? [] : scored.filter((s) => s.monthsFromAnchor != null && s.monthsFromAnchor >= -12 && s.monthsFromAnchor <= 24 && (s.sim >= 0.25 || (s.sameOffice && s.sim >= 0.15)) && s.score >= 0.3).sort((x, y) => y.score - x.score).slice(0, 3);
  const incumbentIds = new Set(incumbents.map((s) => s.a.id));
  // Thin records (e.g. forecasts with one-line descriptions) cannot be compared on scope; fall back
  // to same-agency + same-NAICS awards, ranked by office match and recency, and label them low confidence.
  const thinText = htmlToText(opp.description ?? '').length < 300;
  const comparables = thinText
    ? scored
        .filter((s) => !incumbentIds.has(s.a.id))
        .sort((x, y) => Number(y.sameOffice) - Number(x.sameOffice) || y.sim - x.sim || String(y.a.date_signed ?? '').localeCompare(String(x.a.date_signed ?? '')))
        .slice(0, 10)
    : scored.filter((s) => !incumbentIds.has(s.a.id) && s.sim >= 0.15).sort((x, y) => y.sim - x.sim).slice(0, 12);
  const keep = new Set([...incumbentIds, ...comparables.map((c) => c.a.id)]);

  // Retire probabilistic links (and their derived facts) that no longer qualify.
  const stale = await db.query<{ award_id: string; relationship: string }>(
    `SELECT award_id, relationship FROM opportunity_awards WHERE opportunity_id = $1 AND method = 'probabilistic' AND status = 'active'`,
    [oppId],
  );
  for (const s of stale) {
    if (s.relationship === 'possible_incumbent' && incumbentIds.has(s.award_id)) continue;
    if (s.relationship === 'comparable' && keep.has(s.award_id) && !incumbentIds.has(s.award_id)) continue;
    await db.query(`DELETE FROM opportunity_awards WHERE opportunity_id = $1 AND award_id = $2 AND relationship = $3 AND method = 'probabilistic'`, [oppId, s.award_id, s.relationship]);
    if (s.relationship === 'possible_incumbent') {
      const a = cands.find((c) => c.id === s.award_id) ?? (await db.one<AwardCand>('SELECT * FROM awards WHERE id = $1', [s.award_id]));
      if (a) {
        await setFinancials(db, { opportunityId: oppId, connectorId: `${a.connector_id}:award`, sourceRecordId: a.source_record_id }, [], ['historical_incumbent']);
        if (a.vendor_id) await db.query(`DELETE FROM opportunity_vendors WHERE opportunity_id = $1 AND vendor_id = $2 AND role = 'possible_incumbent'`, [oppId, a.vendor_id]);
      }
    }
  }

  for (const s of incumbents) {
    const conf = s.score >= 0.55 && s.sameOffice ? 'medium' : 'low';
    const evidence = [
      s.sameOffice ? `Same contracting office (${s.a.office_name})` : `Same agency (${s.a.subtier_name ?? s.a.department_name})`,
      `Same ${s.a.naics_code === opp.naics_code ? `NAICS ${s.a.naics_code}` : `PSC ${s.a.psc_code}`}`,
      `Scope similarity ${Math.round(s.sim * 100)}%`,
      s.monthsFromAnchor != null ? `Contract ends ${s.monthsFromAnchor >= 0 ? `${Math.round(s.monthsFromAnchor)} months after` : `${Math.round(-s.monthsFromAnchor)} months before`} this opportunity's expected start` : '',
    ].filter(Boolean);
    await linkAwardToOpportunity(db, oppId, s.a.id, { relationship: 'possible_incumbent', confidence: conf, confidenceScore: Number(s.score.toFixed(3)), method: 'probabilistic', evidence });
    await applyAwardFacts(db, oppId, s.a as any, 'possible_incumbent', conf);
    if (s.a.vendor_id) await setVendorRole(db, oppId, s.a.vendor_id, 'possible_incumbent', conf, evidence);
  }
  for (const s of comparables) {
    await linkAwardToOpportunity(db, oppId, s.a.id, {
      relationship: 'comparable',
      confidence: !thinText && s.sim >= 0.35 ? 'medium' : 'low',
      confidenceScore: Number(s.sim.toFixed(3)),
      method: 'probabilistic',
      evidence: [`Same agency and ${s.a.naics_code === opp.naics_code ? 'NAICS' : 'PSC'}`, thinText ? 'Scope not compared (this record has too little description text)' : `Scope similarity ${Math.round(s.sim * 100)}%`, ...(s.sameOffice ? ['Same office'] : [])],
    });
  }

  // Estimated likely value from comparable + incumbent awards (never presented as official).
  const valued = [...incumbents, ...comparables]
    .map((s) => ({ s, v: s.a.base_and_all_options ?? s.a.total_obligated }))
    .filter((x) => x.v != null && x.v > 0) as { s: (typeof scored)[number]; v: number }[];
  let estimate = false;
  if (valued.length >= 2) {
    const values = valued.map((x) => x.v).sort((a, b) => a - b);
    const low = percentile(values, 0.25);
    const high = percentile(values, 0.75);
    const sameOffice = valued.filter((x) => x.s.sameOffice).length;
    const meanSim = valued.reduce((s, x) => s + x.s.sim, 0) / valued.length;
    const confidence = thinText ? 'low' : valued.length >= 6 && meanSim >= 0.35 && sameOffice >= 2 ? 'high' : valued.length >= 3 ? 'medium' : 'low';
    const years = valued.map((x) => (x.s.a.date_signed ?? '').slice(0, 4)).filter(Boolean).sort();
    const basis = `${valued.length} comparable award(s) from ${opp.subtier_name ?? opp.department_name}${sameOffice ? ` (${sameOffice} from the same office)` : ''}, NAICS/PSC match, signed ${years[0] ?? '?'}–${years[years.length - 1] ?? '?'}${thinText ? ' (matched on agency + NAICS only — scope could not be compared)' : ''}; interquartile range of base + all options (or obligated) values: ${valued
      .slice(0, 5)
      .map((x) => `${x.s.a.piid} ${formatMoney(x.v)}`)
      .join(', ')}${valued.length > 5 ? '…' : ''}.`;
    const annual = valued
      .map((x) => {
        const st = x.s.a.pop_start ? new Date(x.s.a.pop_start).getTime() : null;
        const en = x.s.a.pop_potential_end ?? x.s.a.pop_current_end;
        const e = en ? new Date(en).getTime() : null;
        const yrs = st && e && e > st ? (e - st) / (365.25 * 86_400_000) : null;
        return yrs && yrs >= 0.5 ? x.v / yrs : null;
      })
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    await setFinancials(
      db,
      { opportunityId: oppId, connectorId: 'derived:pricing', sourceRecordId: null },
      [
        { kind: 'estimated_likely', low, high, provenance: 'estimated', confidence, label: `Estimated likely range ${formatRange(low, high)}`, basis },
        ...(valued.length
          ? [{ kind: 'comparable_range', low: values[0], high: values[values.length - 1], provenance: 'derived' as const, confidence, label: 'Full range of comparable awards', basis: `Minimum and maximum of ${values.length} comparable award values.` }]
          : []),
        ...(annual.length >= 2
          ? [{ kind: 'estimated_annual', low: percentile(annual, 0.25), high: percentile(annual, 0.75), provenance: 'estimated' as const, confidence, label: 'Estimated annual value', basis: `Comparable award values divided by their period of performance (${annual.length} awards with known durations).` }]
          : []),
      ],
    );
    estimate = true;
  } else {
    await setFinancials(db, { opportunityId: oppId, connectorId: 'derived:pricing', sourceRecordId: null }, []);
  }
  await recomputeOpportunity(db, oppId, { priorities: deps.priorities });
  return { possibleIncumbents: incumbents.length, comparables: comparables.length, estimate };
}

export function recompeteWindow(popEnd: Date): { start: Date; end: Date } {
  return { start: addMonths(popEnd, -12), end: addMonths(popEnd, -3) };
}
