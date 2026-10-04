import { PURSUIT_DECISIONS, STAGE_LABELS, type Decision, type EligibilityStatus, type Stage } from '../../shared/domain';
import type { Db } from '../db';
import { json } from '../db';
import { htmlToText } from '../lib/text';
import { computePriority, scoreAttractiveness, scoreConfidence, type ScoringExtras } from './dimensions';
import { scoreOpportunity } from './fit';
import { extractFeatures, loadActiveModel, preferenceScore, retrainPreferenceModel, type FeatureVector, type PreferenceModel } from './preference';
import { companyCorpus, loadCompanyContext } from './profile';
import { TfIdfModel } from './similarity';
import type { CompanyContext, FitResult, OppForScoring } from './types';

const CONNECTOR_REASON: Record<string, string> = {
  sam_opportunities: 'SAM.gov daily API ingestion',
  sam_bulk: 'SAM.gov bulk data reconciliation',
  sam_awards: 'SAM.gov Contract Awards data',
  usaspending: 'USAspending award history',
  gsa_forecast: 'GSA procurement forecast — pre-solicitation intelligence',
  dhs_apfs: 'DHS procurement forecast (APFS) — pre-solicitation intelligence',
  sba_subnet: 'SBA SUBNet subcontracting listing',
  grants_gov: 'Grants.gov funding opportunity listing',
};

export async function loadOppForScoring(db: Db, id: string): Promise<OppForScoring | null> {
  const o = await db.one<any>('SELECT * FROM opportunities WHERE id = $1', [id]);
  if (!o) return null;
  const reqs = await db.query<{ category: string; text: string; provenance: string; evidence_quote: string | null }>(
    'SELECT category, text, provenance, evidence_quote FROM opportunity_requirements WHERE opportunity_id = $1 AND is_current LIMIT 300',
    [id],
  );
  const docs = await db.query<{ text_content: string | null }>(
    `SELECT left(text_content, 15000) AS text_content FROM opportunity_documents WHERE opportunity_id = $1 AND text_status = 'extracted' ORDER BY posted_at NULLS LAST LIMIT 4`,
    [id],
  );
  const elig = await db.one<{ value: string[] }>(`SELECT value FROM opportunity_field_values WHERE opportunity_id = $1 AND field = 'eligibility' AND is_current ORDER BY observed_at DESC LIMIT 1`, [id]);
  const summary = o.summary ? `${o.summary}\n` : '';
  const text = [summary, htmlToText(o.description ?? ''), reqs.map((r) => r.text).join('\n'), docs.map((d) => d.text_content ?? '').join('\n')].join('\n').slice(0, 80_000);
  return {
    id: o.id,
    title: o.title,
    text,
    stage: o.stage,
    opportunityClass: o.opportunity_class,
    isSignal: o.is_signal,
    status: o.status,
    naics: o.naics_code,
    naicsCodes: o.naics_codes ?? [],
    psc: o.psc_code,
    setAsideCode: o.set_aside_code,
    setAside: o.set_aside,
    department: o.department_name,
    subtier: o.subtier_name,
    office: o.office_name,
    valueLow: o.value_low,
    valueHigh: o.value_high,
    valueProvenance: o.value_provenance,
    valueLabel: o.value_label,
    placeState: o.place_state,
    placeCity: o.place_city,
    deadline: o.response_deadline ? new Date(o.response_deadline).toISOString() : null,
    postedAt: o.posted_at ? new Date(o.posted_at).toISOString() : null,
    performanceStart: o.performance_start,
    performanceEnd: o.performance_end,
    contractVehicle: o.contract_vehicle,
    eligibility: Array.isArray(elig?.value) ? elig!.value : [],
    requirements: reqs.map((r) => ({ category: r.category, text: r.text, provenance: r.provenance, quote: r.evidence_quote })),
  };
}

/** Build the IDF model from the company corpus plus a sample of the opportunity corpus. */
export async function buildSimilarityModel(db: Db, co: CompanyContext): Promise<TfIdfModel> {
  const rows = await db.query<{ t: string }>(`SELECT title || ' ' || left(coalesce(description, ''), 1500) AS t FROM opportunities WHERE merged_into_id IS NULL ORDER BY random() LIMIT 2500`);
  return new TfIdfModel([...rows.map((r) => htmlToText(r.t)), companyCorpus(co), ...co.pastPerformance.map((p) => p.text)]);
}

interface DiscoveryReason {
  code: string;
  kind: 'source' | 'profile' | 'relationship' | 'signal';
  text: string;
}

async function discoveryReasons(db: Db, opp: OppForScoring, fit: FitResult, co: CompanyContext): Promise<DiscoveryReason[]> {
  const out: DiscoveryReason[] = [];
  const row = await db.one<any>(
    `SELECT o.connector_ids, o.recompete_signal, o.is_signal, o.performance_end,
       (SELECT count(*)::int FROM opportunity_awards oa WHERE oa.opportunity_id = o.id AND oa.status = 'active') AS awards,
       (SELECT count(*)::int FROM opportunity_relationships r WHERE (r.from_opportunity_id = o.id OR r.to_opportunity_id = o.id) AND r.status <> 'rejected' AND r.relationship_type IN ('forecast_of')) AS forecast_links,
       (SELECT count(*)::int FROM opportunity_relationships r WHERE (r.from_opportunity_id = o.id OR r.to_opportunity_id = o.id) AND r.status <> 'rejected') AS rels,
       (SELECT count(*)::int FROM user_opportunity_decisions d JOIN opportunities o2 ON o2.id = d.opportunity_id
          WHERE d.is_current AND d.decision = ANY($2::text[]) AND o2.office_id = o.office_id AND o2.id <> o.id AND o.office_id IS NOT NULL) AS office_pursuits
     FROM opportunities o WHERE o.id = $1`,
    [opp.id, PURSUIT_DECISIONS],
  );
  const connectors: string[] = row?.connector_ids ?? [];
  for (const c of connectors) out.push({ code: `source:${c}`, kind: 'source', text: CONNECTOR_REASON[c] ?? `Custom source: ${c}` });
  const nonSam = connectors.filter((c) => !c.startsWith('sam_'));
  if (connectors.length && !connectors.some((c) => c === 'sam_opportunities' || c === 'sam_bulk') && opp.opportunityClass !== 'grant' && !opp.isSignal)
    out.push({ code: 'not_on_sam', kind: 'source', text: `Appears in ${nonSam.join(', ')} but no matching SAM.gov notice has been found` });
  const naicsAll = [opp.naics, ...opp.naicsCodes].filter(Boolean) as string[];
  const exact = naicsAll.find((n) => co.naics.includes(n));
  if (exact) out.push({ code: 'naics', kind: 'profile', text: `NAICS ${exact} matches your company profile` });
  else {
    const grp = naicsAll.find((n) => co.naics.some((c) => c.slice(0, 4) === n.slice(0, 4)));
    if (grp) out.push({ code: 'naics_group', kind: 'profile', text: `NAICS ${grp} is in the same industry group as your codes` });
  }
  if (opp.psc && co.psc.includes(opp.psc)) out.push({ code: 'psc', kind: 'profile', text: `PSC ${opp.psc} matches your preferences` });
  for (const m of fit.matchedCapabilities.slice(0, 3)) out.push({ code: `cap:${m.slug}`, kind: 'profile', text: `${m.inTitle ? 'Title' : 'Description'} references ${m.matchedTerm} (${m.name} capability)` });
  const scope = fit.components.find((c) => c.component === 'scope');
  if (scope && scope.ratio >= 0.65) out.push({ code: 'scope', kind: 'profile', text: `Scope language closely matches your capability profile (scope score ${Math.round(scope.points)}/${scope.max})` });
  const pp = fit.components.find((c) => c.component === 'past_performance');
  if (pp && pp.ratio >= 0.6) out.push({ code: 'past_performance', kind: 'profile', text: pp.explanation[0] ?? 'Similar to your past performance' });
  if (row?.office_pursuits > 0) out.push({ code: 'office_history', kind: 'relationship', text: `Same contracting office as ${row.office_pursuits} opportunity(ies) you marked Pursue/Interested` });
  if (row?.awards > 0) out.push({ code: 'award_history', kind: 'relationship', text: `${row.awards} related historical award(s) linked from SAM/USAspending` });
  if (row?.forecast_links > 0) out.push({ code: 'forecast_link', kind: 'relationship', text: 'Linked to a procurement forecast record' });
  if (opp.stage === 'forecast') out.push({ code: 'forecast', kind: 'signal', text: `Forecast predicts a procurement${opp.performanceStart ? ` (performance ~${opp.performanceStart.slice(0, 7)})` : ''}` });
  if (row?.is_signal && row?.performance_end) {
    const months = Math.round((new Date(row.performance_end).getTime() - Date.now()) / (30.4375 * 86_400_000));
    out.push({ code: 'expiring', kind: 'signal', text: `Existing contract expires in ~${months} month(s) with no successor solicitation detected` });
  } else if (row?.recompete_signal) out.push({ code: 'recompete_hint', kind: 'signal', text: 'Source indicates this is a recompete / follow-on' });
  if (opp.opportunityClass === 'subcontract') out.push({ code: 'subcontract', kind: 'source', text: 'Subcontracting opportunity from a prime contractor (not a federal prime solicitation)' });
  if (!out.some((r) => r.kind === 'profile') && co.configured) out.push({ code: 'broad_ingestion', kind: 'source', text: `Captured by broad ingestion (${STAGE_LABELS[opp.stage as Stage] ?? opp.stage}); weak match to your profile` });
  return out;
}

export interface ScoreRunContext {
  co: CompanyContext;
  model: TfIdfModel;
  pref: PreferenceModel;
}

export async function prepareScoring(db: Db): Promise<ScoreRunContext> {
  const co = await loadCompanyContext(db);
  return { co, model: await buildSimilarityModel(db, co), pref: await loadActiveModel(db) };
}

/** Facts the attractiveness / confidence dimensions need beyond the scoring text. */
export async function loadScoringExtras(db: Db, id: string): Promise<ScoringExtras> {
  const r = await db.one<any>(
    `SELECT o.data_completeness, length(coalesce(o.description, '')) AS description_length, o.status,
       (SELECT count(*)::int FROM opportunity_documents d WHERE d.opportunity_id = o.id) AS documents,
       (SELECT count(*)::int FROM opportunity_documents d WHERE d.opportunity_id = o.id AND d.text_status = 'extracted') AS extracted,
       (SELECT count(*)::int FROM opportunity_sources os WHERE os.opportunity_id = o.id) AS sources,
       EXISTS (SELECT 1 FROM opportunity_vendors ov WHERE ov.opportunity_id = o.id) AS has_incumbent,
       (SELECT count(*)::int FROM user_opportunity_decisions d JOIN opportunities o2 ON o2.id = d.opportunity_id
          WHERE d.is_current AND d.decision = ANY($2::text[]) AND o2.office_id = o.office_id AND o2.id <> o.id AND o.office_id IS NOT NULL) AS office_pursuits,
       EXISTS (SELECT 1 FROM opportunity_sources os JOIN source_records sr ON sr.id = os.source_record_id
          WHERE os.opportunity_id = o.id AND sr.seen_status = 'active' AND (sr.normalized->'data'->'extra'->>'optionExercise') = 'true') AS option_exercise,
       EXISTS (SELECT 1 FROM opportunity_requirements q WHERE q.opportunity_id = o.id AND q.is_current AND q.category = 'sole_source') AS sole_source
     FROM opportunities o WHERE o.id = $1`,
    [id, PURSUIT_DECISIONS],
  );
  return {
    dataCompleteness: r?.data_completeness ?? null,
    descriptionLength: Number(r?.description_length ?? 0),
    extractedDocuments: r?.extracted ?? 0,
    documentCount: r?.documents ?? 0,
    sourceCount: r?.sources ?? 0,
    hasIncumbent: !!r?.has_incumbent,
    officePursuits: r?.office_pursuits ?? 0,
    cancelled: r?.status === 'cancelled',
    optionExercise: !!r?.option_exercise,
    soleSourceIntent: !!r?.sole_source,
  };
}

/** Compute and persist fit, eligibility, preference, the other score dimensions and explanations for one profile. */
export async function scoreOne(db: Db, ctx: ScoreRunContext, id: string, reason = 'refresh'): Promise<{ fit: number; preference: number; priority: number } | null> {
  const opp = await loadOppForScoring(db, id);
  if (!opp) return null;
  const fit = scoreOpportunity(opp, ctx.co, ctx.model);
  const extras = await loadScoringExtras(db, id);
  const features = extractFeatures(opp, fit, { hasIncumbent: extras.hasIncumbent });
  const pref = preferenceScore(fit.fit, ctx.pref, features);
  const attractiveness = scoreAttractiveness(opp, fit, ctx.co, extras);
  const confidence = scoreConfidence(opp, fit, extras);
  const priority = computePriority({ preference: pref.score, attractiveness: attractiveness.score, eligibility: fit.eligibility.status, status: opp.status, stage: opp.stage, deadline: opp.deadline, isSignal: opp.isSignal });
  const dimensions = { attractiveness, confidence, priority };
  const reasons = await discoveryReasons(db, opp, fit, ctx.co);
  const prev = await db.one<{ fit_score: number | null; preference_score: number | null; priority_score: number | null }>('SELECT fit_score, preference_score, priority_score FROM opportunities WHERE id = $1', [id]);

  await db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO match_scores (opportunity_id, company_id, fit_score, preference_score, learned_component, blend_alpha, eligibility_status, model_version, weights,
         attractiveness_score, confidence_score, priority_score, dimensions, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::jsonb, now())
       ON CONFLICT (opportunity_id) DO UPDATE SET company_id = EXCLUDED.company_id, fit_score = EXCLUDED.fit_score, preference_score = EXCLUDED.preference_score,
         learned_component = EXCLUDED.learned_component, blend_alpha = EXCLUDED.blend_alpha, eligibility_status = EXCLUDED.eligibility_status,
         model_version = EXCLUDED.model_version, weights = EXCLUDED.weights, attractiveness_score = EXCLUDED.attractiveness_score,
         confidence_score = EXCLUDED.confidence_score, priority_score = EXCLUDED.priority_score, dimensions = EXCLUDED.dimensions, computed_at = now()`,
      [id, ctx.co.id, fit.fit, pref.score, pref.learned, ctx.pref.alpha, fit.eligibility.status, ctx.pref.version, json(ctx.co.weights), attractiveness.score, confidence.score, priority.score, json(dimensions)],
    );
    await tx.query('DELETE FROM match_score_components WHERE opportunity_id = $1', [id]);
    await tx.query(
      `INSERT INTO match_score_components (opportunity_id, component, weight, points, max_points, ratio, explanation)
       SELECT $1, x.component, x.weight, x.points, x.max, x.ratio, x.explanation FROM jsonb_to_recordset($2::jsonb) AS x(component text, weight numeric, points numeric, max numeric, ratio numeric, explanation jsonb)`,
      [id, json(fit.components)],
    );
    await tx.query('DELETE FROM match_explanations WHERE opportunity_id = $1', [id]);
    const expl = [
      ...fit.strengths.map((t) => ({ kind: 'strength', text: t, severity: 'info', detail: {} })),
      ...fit.gaps.map((t) => ({ kind: 'gap', text: t, severity: 'warning', detail: {} })),
      ...fit.eligibility.flags.map((f) => ({ kind: f.kind, text: f.text, severity: f.severity, detail: { rule: f.rule, evidenceProvenance: f.evidenceProvenance } })),
      ...fit.matchedCapabilities.map((m) => ({ kind: 'matched_capability', text: m.name, severity: 'info', detail: m })),
      { kind: 'features', text: 'preference features', severity: 'info', detail: { features, scopeTerms: fit.scopeTerms } },
    ];
    await tx.query(
      `INSERT INTO match_explanations (opportunity_id, kind, text, severity, detail) SELECT $1, x.kind, x.text, x.severity, x.detail FROM jsonb_to_recordset($2::jsonb) AS x(kind text, text text, severity text, detail jsonb)`,
      [id, json(expl)],
    );
    await tx.query(
      `UPDATE opportunities SET fit_score = $2, preference_score = $3, eligibility_status = $4, discovery_reasons = $5::jsonb,
         attractiveness_score = $6, confidence_score = $7, priority_score = $8, scored_at = now() WHERE id = $1`,
      [id, fit.fit, pref.score, fit.eligibility.status, json(reasons), attractiveness.score, confidence.score, priority.score],
    );
    if (!prev || prev.fit_score !== fit.fit || prev.preference_score !== pref.score || prev.priority_score !== priority.score) {
      await tx.query('INSERT INTO score_history (opportunity_id, fit_score, preference_score, priority_score, model_version, reason) VALUES ($1,$2,$3,$4,$5,$6)', [
        id,
        fit.fit,
        pref.score,
        priority.score,
        ctx.pref.version,
        reason,
      ]);
    }
  });
  return { fit: fit.fit, preference: pref.score, priority: priority.score };
}

export async function scoreMany(db: Db, ids: string[] | 'all', reason = 'refresh', ctx?: ScoreRunContext): Promise<number> {
  const c = ctx ?? (await prepareScoring(db));
  const list = ids === 'all' ? (await db.query<{ id: string }>('SELECT id FROM opportunities WHERE merged_into_id IS NULL')).map((r) => r.id) : ids;
  let n = 0;
  for (const id of list) {
    if (await scoreOne(db, c, id, reason)) n++;
  }
  return n;
}

/** Recompute features for every reviewed opportunity, retrain the preference model and re-rank everything. */
export async function retrainAndRescore(db: Db, trigger: string): Promise<PreferenceModel> {
  const ctx = await prepareScoring(db);
  const decisions = await db.query<{ opportunity_id: string; decision: Decision; reasons: string[]; feature_snapshot: FeatureVector | null }>(
    `SELECT d.opportunity_id, d.decision, d.reasons, d.feature_snapshot FROM user_opportunity_decisions d
     JOIN opportunities o ON o.id = d.opportunity_id WHERE d.is_current AND o.merged_into_id IS NULL`,
  );
  const samples: { decision: Decision; reasons: string[]; features: FeatureVector; fit: number }[] = [];
  for (const d of decisions) {
    const opp = await loadOppForScoring(db, d.opportunity_id);
    let features = d.feature_snapshot ?? {};
    let fitScore = 50;
    if (opp) {
      const fit = scoreOpportunity(opp, ctx.co, ctx.model);
      const hasIncumbent = !!(await db.one('SELECT 1 FROM opportunity_vendors WHERE opportunity_id = $1 LIMIT 1', [d.opportunity_id]));
      features = extractFeatures(opp, fit, { hasIncumbent });
      fitScore = fit.fit;
    }
    samples.push({ decision: d.decision, reasons: d.reasons ?? [], features, fit: fitScore });
  }
  const pref = await retrainPreferenceModel(db, samples, trigger);
  await rescorePreferencesOnly(db, pref);
  return pref;
}

/**
 * Re-rank every scored profile with a new preference model. Base fit is untouched;
 * only the learned blend changes, using the feature vectors stored at scoring time.
 */
export async function rescorePreferencesOnly(db: Db, pref: PreferenceModel): Promise<number> {
  const rows = await db.query<{
    opportunity_id: string;
    fit_score: number;
    preference_score: number | null;
    features: FeatureVector | null;
    attractiveness_score: number | null;
    eligibility_status: EligibilityStatus;
    dimensions: Record<string, unknown> | null;
    status: string;
    stage: string;
    response_deadline: string | null;
    is_signal: boolean;
  }>(
    `SELECT ms.opportunity_id, ms.fit_score, ms.preference_score, me.detail->'features' AS features, ms.attractiveness_score, ms.eligibility_status, ms.dimensions,
       o.status, o.stage, o.response_deadline, o.is_signal
     FROM match_scores ms JOIN opportunities o ON o.id = ms.opportunity_id LEFT JOIN match_explanations me ON me.opportunity_id = ms.opportunity_id AND me.kind = 'features'`,
  );
  let changed = 0;
  for (const r of rows) {
    const { score, learned } = preferenceScore(r.fit_score, pref, r.features ?? {});
    if (score === r.preference_score) continue;
    changed++;
    // Priority depends on the personalized score, so it moves with the model — eligibility gating still applies.
    const priority = computePriority({
      preference: score,
      attractiveness: r.attractiveness_score ?? 50,
      eligibility: r.eligibility_status,
      status: r.status,
      stage: r.stage,
      deadline: r.response_deadline ? new Date(r.response_deadline).toISOString() : null,
      isSignal: r.is_signal,
    });
    await db.query(
      'UPDATE match_scores SET preference_score = $2, learned_component = $3, blend_alpha = $4, model_version = $5, priority_score = $6, dimensions = $7::jsonb WHERE opportunity_id = $1',
      [r.opportunity_id, score, learned, pref.alpha, pref.version, priority.score, json({ ...(r.dimensions ?? {}), priority })],
    );
    await db.query('UPDATE opportunities SET preference_score = $2, priority_score = $3 WHERE id = $1', [r.opportunity_id, score, priority.score]);
    await db.query('INSERT INTO score_history (opportunity_id, fit_score, preference_score, priority_score, model_version, reason) VALUES ($1,$2,$3,$4,$5,$6)', [
      r.opportunity_id,
      r.fit_score,
      score,
      priority.score,
      pref.version,
      `preference model v${pref.version}`,
    ]);
  }
  return changed;
}
