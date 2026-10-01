export interface CompletenessInput {
  stage: string;
  opportunityClass: string;
  hasAgency: boolean;
  hasOffice: boolean;
  descriptionLength: number;
  hasValue: boolean;
  hasDeadline: boolean;
  hasNaics: boolean;
  hasPsc: boolean;
  setAsideKnown: boolean;
  contactCount: number;
  documentCount: number;
  hasAwardHistory: boolean;
  incumbentConfirmed: boolean;
  hasIncumbentCandidate: boolean;
  hasDuration: boolean;
  hasEvaluationCriteria: boolean;
  hasPlace: boolean;
}

export interface CompletenessResult {
  score: number;
  known: string[];
  missing: string[];
}

const SOLICITATION_STAGES = new Set(['solicitation', 'combined_synopsis']);
const DEADLINE_STAGES = new Set(['solicitation', 'combined_synopsis', 'sources_sought', 'rfi', 'presolicitation', 'subcontract', 'grant_posted', 'special_notice']);

/**
 * How much of the important information about this opportunity is known.
 * Independent of fit: a perfect-fit opportunity can still be poorly documented.
 */
export function computeCompleteness(i: CompletenessInput): CompletenessResult {
  const isGrant = i.opportunityClass === 'grant';
  const isSub = i.opportunityClass === 'subcontract';
  const items: { label: string; weight: number; ok: boolean; applies: boolean }[] = [
    { label: 'Agency', weight: 10, ok: i.hasAgency, applies: !isSub },
    { label: 'Contracting office', weight: 5, ok: i.hasOffice, applies: !isSub && !isGrant },
    { label: 'Scope description', weight: 14, ok: i.descriptionLength >= 200, applies: true },
    { label: 'Value', weight: 12, ok: i.hasValue, applies: true },
    { label: 'Response deadline', weight: 10, ok: i.hasDeadline, applies: DEADLINE_STAGES.has(i.stage) },
    { label: 'NAICS', weight: 6, ok: i.hasNaics, applies: !isGrant },
    { label: 'PSC', weight: 4, ok: i.hasPsc, applies: !isGrant && !isSub },
    { label: 'Set-aside', weight: 5, ok: i.setAsideKnown, applies: !isGrant && !isSub },
    { label: 'Contacts', weight: 8, ok: i.contactCount > 0, applies: i.stage !== 'forecast' && i.stage !== 'recompete_signal' },
    { label: 'Documents', weight: 8, ok: i.documentCount > 0, applies: SOLICITATION_STAGES.has(i.stage) || isGrant },
    { label: 'Historical award', weight: 6, ok: i.hasAwardHistory, applies: !isGrant },
    { label: 'Incumbent confirmation', weight: 5, ok: i.incumbentConfirmed, applies: !isGrant && !isSub && i.stage !== 'award' },
    { label: 'Duration / period of performance', weight: 6, ok: i.hasDuration, applies: true },
    { label: 'Evaluation criteria', weight: 6, ok: i.hasEvaluationCriteria, applies: SOLICITATION_STAGES.has(i.stage) },
    { label: 'Place of performance', weight: 4, ok: i.hasPlace, applies: true },
  ];
  const applicable = items.filter((x) => x.applies);
  const total = applicable.reduce((s, x) => s + x.weight, 0);
  const got = applicable.filter((x) => x.ok).reduce((s, x) => s + x.weight, 0);
  const known = applicable.filter((x) => x.ok).map((x) => x.label);
  const missing = applicable.filter((x) => !x.ok).map((x) => (x.label === 'Incumbent confirmation' && i.hasIncumbentCandidate ? 'Incumbent confirmation (candidate found, unconfirmed)' : x.label));
  return { score: total ? Math.round((got / total) * 100) : 0, known, missing };
}
