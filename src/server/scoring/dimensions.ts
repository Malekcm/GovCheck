import type { EligibilityStatus } from '../../shared/domain';
import { formatMoney, formatRange } from '../lib/money';
import { nameKey } from '../lib/text';
import type { CompanyContext, FitResult, OppForScoring } from './types';

/**
 * Score dimensions that sit BESIDE the objective company-fit score (never blended into it):
 *
 *  - Strategic attractiveness: is this worth winning? (size, timing/positioning, competition
 *    restriction, customer relationship, incumbent dynamics)
 *  - Data confidence: how much of what the scores rely on is actually known, and how much is
 *    official vs inferred.
 *  - Review priority: the ranking used for "Best" — the personalized score nudged by
 *    attractiveness, then CAPPED by eligibility and status so a strong keyword match can never
 *    hide a hard restriction or a dead opportunity.
 *
 * Every point added or removed carries a human-readable factor.
 */
export interface Factor {
  label: string;
  effect: number;
  detail: string;
}

export interface DimensionResult {
  score: number;
  factors: Factor[];
  missing?: string[];
}

export interface ScoringExtras {
  dataCompleteness: number | null;
  descriptionLength: number;
  extractedDocuments: number;
  documentCount: number;
  sourceCount: number;
  hasIncumbent: boolean;
  officePursuits: number;
  cancelled: boolean;
  optionExercise: boolean;
  soleSourceIntent: boolean;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const SOLE_SOURCE_SET_ASIDES = new Set(['8AN', 'HZS', 'SDVOSBS', 'WOSBSS', 'EDWOSBSS', 'VSS']);
const EARLY_STAGES = new Set(['forecast', 'recompete_signal', 'sources_sought', 'rfi', 'presolicitation', 'grant_forecast']);

function sameAgency(a: string | null, opp: OppForScoring): boolean {
  const k = nameKey(a);
  if (!k) return false;
  return [opp.department, opp.subtier, opp.office].some((x) => {
    const o = nameKey(x);
    return !!o && (o === k || o.includes(k) || k.includes(o));
  });
}

export function scoreAttractiveness(opp: OppForScoring, fit: FitResult, co: CompanyContext, x: ScoringExtras, now = new Date()): DimensionResult {
  const factors: Factor[] = [];
  const add = (label: string, effect: number, detail: string) => factors.push({ label, effect, detail });

  // Size / value
  const lo = opp.valueLow;
  const hi = opp.valueHigh ?? opp.valueLow;
  const v = lo != null && hi != null ? (lo + hi) / 2 : (hi ?? lo);
  const valueTag = opp.valueProvenance && opp.valueProvenance !== 'official' ? ` (${opp.valueProvenance.replace('_', ' ')})` : '';
  if (v == null) add('Value', 0, 'Value unknown — attractiveness is uncertain until a value, ceiling or comparable award is found.');
  else if (co.minValue || co.preferredMaxValue || co.maxRealisticValue) {
    if (co.minValue && v < co.minValue) add('Value', -18, `${formatRange(lo, hi)}${valueTag} is below your minimum worthwhile value (${formatMoney(co.minValue)}).`);
    else if (co.maxRealisticValue && v > co.maxRealisticValue) add('Value', -8, `${formatRange(lo, hi)}${valueTag} exceeds your realistic maximum — likely a teaming play.`);
    else add('Value', 14, `${formatRange(lo, hi)}${valueTag} is in your target range.`);
  } else if (v >= 10_000_000) add('Value', 10, `Large opportunity: ${formatRange(lo, hi)}${valueTag}.`);
  else if (v >= 1_000_000) add('Value', 6, `Meaningful size: ${formatRange(lo, hi)}${valueTag}.`);
  else if (v < 150_000) add('Value', -6, `Small value: ${formatRange(lo, hi)}${valueTag}.`);

  // Timing / positioning
  const deadline = opp.deadline ? new Date(opp.deadline) : null;
  const days = deadline ? (deadline.getTime() - now.getTime()) / 86_400_000 : null;
  if (x.cancelled) add('Status', -45, 'Notice appears to be cancelled.');
  else if (x.optionExercise) add('Competition', -35, 'Forecast says this is an exercise of an option on an existing contract — not a new competition.');
  else if (opp.stage === 'award') add('Timing', -25, 'Already awarded — useful as incumbent/recompete intelligence, not as a bid.');
  else if (EARLY_STAGES.has(opp.stage)) add('Timing', 12, 'Pre-solicitation stage — time to shape the requirement, find teammates and meet the customer.');
  else if (days != null && days < 0) add('Timing', -30, `Response deadline passed ${Math.round(-days)} day(s) ago.`);
  else if (days != null && days < 7) add('Timing', -10, `Only ${Math.max(0, Math.round(days))} day(s) to respond.`);
  else if (days != null && days >= 14) add('Timing', 4, `${Math.round(days)} days to respond.`);

  // Competition restriction
  const eligibleSetAside = fit.eligibility.flags.some((f) => f.rule === 'set_aside' && f.kind === 'info');
  if (opp.setAsideCode && eligibleSetAside) add('Competition', SOLE_SOURCE_SET_ASIDES.has(opp.setAsideCode) ? 15 : 12, `${opp.setAside ?? opp.setAsideCode} — restricted competition you have confirmed you qualify for.`);
  else if (!opp.setAsideCode && (opp.stage === 'solicitation' || opp.stage === 'combined_synopsis') && opp.opportunityClass === 'prime') add('Competition', -3, 'No set-aside: full and open competition.');
  if (x.soleSourceIntent) add('Competition', -20, 'Notice states an intent to award sole source — respond only if you can demonstrate capability to challenge it.');

  // Customer relationship
  const pref = co.preferredAgencies.find((a) => sameAgency(a, opp));
  if (pref) add('Customer', 8, `Preferred agency (${pref}).`);
  const pp = co.pastPerformance.find((p) => sameAgency(p.agency, opp));
  if (pp) add('Customer', 8, `You have past performance with this agency (“${pp.name}”).`);
  if (x.officePursuits > 0) add('Customer', 5, `You are pursuing ${x.officePursuits} other opportunity(ies) with the same contracting office.`);

  // Incumbent dynamics
  if (opp.isSignal || x.hasIncumbent) {
    if (opp.isSignal) add('Incumbent', 3, 'Expiring contract: incumbent, value and timing are known — early positioning is possible.');
    else add('Incumbent', 2, 'Incumbent identified — you can research their performance and plan displacement or teaming.');
  }

  const score = clamp(50 + factors.reduce((s, f) => s + f.effect, 0));
  return { score, factors };
}

export function scoreConfidence(opp: OppForScoring, fit: FitResult, x: ScoringExtras): DimensionResult {
  const factors: Factor[] = [];
  const missing: string[] = [];
  const add = (label: string, effect: number, detail: string) => factors.push({ label, effect, detail });
  const completeness = x.dataCompleteness ?? 0;
  add('Completeness', Math.round(completeness * 0.45), `Data completeness ${completeness}%.`);

  if (x.descriptionLength >= 400) add('Scope text', 12, 'Substantial scope description available.');
  else if (x.descriptionLength >= 80) {
    add('Scope text', 5, 'Only a short description is available.');
    missing.push('Full scope description');
  } else missing.push('Scope description');

  if (x.extractedDocuments > 0) add('Documents', 13, `${x.extractedDocuments} document(s) parsed — requirements come from the actual solicitation text.`);
  else if (x.documentCount > 0) {
    add('Documents', 4, `${x.documentCount} document(s) listed but not parsed yet.`);
    missing.push('Parsed solicitation documents');
  } else if (!EARLY_STAGES.has(opp.stage)) missing.push('Solicitation documents');

  if (opp.valueProvenance === 'official') add('Value', 9, 'Value is official.');
  else if (opp.valueProvenance) {
    add('Value', 3, `Value is ${opp.valueProvenance.replace('_', ' ')}, not official.`);
    missing.push('Official value / ceiling');
  } else missing.push('Any value information');

  if (opp.deadline || EARLY_STAGES.has(opp.stage) || opp.stage === 'award') add('Dates', 6, opp.deadline ? 'Response deadline known.' : 'Pre-solicitation timing information available.');
  else missing.push('Response deadline');

  if (x.sourceCount >= 2) add('Corroboration', 7, `${x.sourceCount} source records corroborate this profile.`);
  const verify = fit.eligibility.flags.filter((f) => f.kind === 'verify');
  if (!verify.length) add('Eligibility', 8, 'No unresolved eligibility questions.');
  else missing.push(...verify.slice(0, 2).map((f) => `Eligibility check: ${f.rule.replace(/_/g, ' ')}`));

  return { score: clamp(factors.reduce((s, f) => s + f.effect, 0)), factors, missing };
}

const ELIGIBILITY_CAP: Record<EligibilityStatus, { cap?: number; mult: number; why?: string }> = {
  eligible: { mult: 1 },
  likely_eligible: { mult: 1 },
  unclear: { mult: 0.85, why: 'Eligibility unclear — ranked lower until verified' },
  likely_ineligible: { mult: 0.5, why: 'Likely ineligible — ranked down by half' },
  ineligible: { cap: 10, mult: 0.2, why: 'Ineligible as prime — capped at 10 (consider teaming)' },
};

/** Review priority: personalized score blended with attractiveness, then gated by eligibility and status. */
export function computePriority(input: { preference: number; attractiveness: number; eligibility: EligibilityStatus; status: string; stage: string; deadline: string | null; isSignal: boolean }, now = new Date()): DimensionResult {
  const factors: Factor[] = [];
  let score = 0.8 * input.preference + 0.2 * input.attractiveness;
  factors.push({ label: 'Base', effect: Math.round(score), detail: `80% personalized fit (${input.preference}) + 20% strategic attractiveness (${input.attractiveness}).` });
  const gate = ELIGIBILITY_CAP[input.eligibility] ?? ELIGIBILITY_CAP.unclear;
  if (gate.mult !== 1 || gate.cap != null) {
    const before = score;
    score = gate.cap != null ? Math.min(score * gate.mult, gate.cap) : score * gate.mult;
    factors.push({ label: 'Eligibility', effect: Math.round(score - before), detail: gate.why ?? '' });
  }
  const passed = input.deadline && new Date(input.deadline).getTime() < now.getTime() && !input.isSignal && input.stage !== 'award';
  if (['cancelled', 'archived'].includes(input.status) || passed) {
    const before = score;
    score *= 0.4;
    factors.push({ label: 'Status', effect: Math.round(score - before), detail: input.status === 'cancelled' ? 'Cancelled.' : passed ? 'Response deadline has passed.' : 'Archived at the source.' });
  }
  return { score: clamp(score), factors };
}
