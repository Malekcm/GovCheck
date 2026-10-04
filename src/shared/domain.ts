// Shared domain vocabulary used by both the API server and the UI.
// Keeping these in one place guarantees that labels, lifecycle order and
// provenance semantics are identical everywhere they are shown or computed.

export const PROVENANCES = ['official', 'derived', 'estimated', 'ai_extracted', 'user_entered', 'unknown'] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  official: 'Official',
  derived: 'Derived',
  estimated: 'Estimated',
  ai_extracted: 'AI extracted',
  user_entered: 'User entered',
  unknown: 'Unknown',
};

export const PROVENANCE_DESCRIPTIONS: Record<Provenance, string> = {
  official: 'Published by a government source (API, bulk file or official listing). Shown exactly as the source reported it.',
  derived: 'Computed deterministically from official data (e.g. matched identifiers, keyword detection, date arithmetic). The basis is always shown.',
  estimated: 'A statistical estimate built from comparable historical data. Never an official government figure.',
  ai_extracted: 'Extracted or summarized by an AI model from source text. Verify against the cited document before relying on it.',
  user_entered: 'Entered by you. Never changed by data refreshes.',
  unknown: 'Not available from any connected source yet.',
};

/** Precedence when choosing a canonical value from several sources (lower wins). */
export const PROVENANCE_RANK: Record<Provenance, number> = {
  user_entered: 0,
  official: 1,
  derived: 2,
  ai_extracted: 3,
  estimated: 4,
  unknown: 9,
};

export const OPPORTUNITY_CLASSES = ['prime', 'subcontract', 'grant', 'intelligence'] as const;
export type OpportunityClass = (typeof OPPORTUNITY_CLASSES)[number];

export const CLASS_LABELS: Record<OpportunityClass, string> = {
  prime: 'Prime contract',
  subcontract: 'Subcontract',
  grant: 'Grant / funding',
  intelligence: 'Intelligence signal',
};

// Procurement lifecycle, in order. Used for timelines and to determine the
// "most advanced" stage of a profile assembled from several records.
export const STAGES = [
  'forecast',
  'grant_forecast',
  'sources_sought',
  'rfi',
  'special_notice',
  'presolicitation',
  'subcontract',
  'grant_posted',
  'solicitation',
  'combined_synopsis',
  'award',
  'recompete_signal',
  'other',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_ORDER: Record<Stage, number> = {
  forecast: 10,
  grant_forecast: 10,
  recompete_signal: 5,
  sources_sought: 20,
  rfi: 22,
  special_notice: 25,
  presolicitation: 30,
  subcontract: 35,
  grant_posted: 40,
  solicitation: 40,
  combined_synopsis: 40,
  award: 60,
  other: 0,
};

export const STAGE_LABELS: Record<Stage, string> = {
  forecast: 'Forecast',
  grant_forecast: 'Grant forecast',
  sources_sought: 'Sources Sought',
  rfi: 'RFI',
  special_notice: 'Special Notice',
  presolicitation: 'Presolicitation',
  subcontract: 'Subcontract opportunity',
  grant_posted: 'Grant (posted)',
  solicitation: 'Solicitation',
  combined_synopsis: 'Combined Synopsis/Solicitation',
  award: 'Award',
  recompete_signal: 'Possible recompete',
  other: 'Other notice',
};

export const STAGE_DESCRIPTIONS: Record<Stage, string> = {
  forecast: 'An agency forecast of a planned procurement. Pre-solicitation intelligence — not an active solicitation.',
  grant_forecast: 'A forecasted grant/funding opportunity that has not opened yet.',
  sources_sought: 'Market research: the agency is looking for capable sources. Responding can shape the eventual solicitation.',
  rfi: 'Request for Information: market research, not a request for proposals.',
  special_notice: 'A general notice (industry day, intent to sole source, draft documents, etc.).',
  presolicitation: 'Advance notice that a solicitation is coming.',
  subcontract: 'A prime contractor seeking subcontractors. You would contract with the prime, not the government.',
  grant_posted: 'An open grant/funding opportunity accepting applications.',
  solicitation: 'An active request for proposals or quotes.',
  combined_synopsis: 'A combined synopsis/solicitation (common for commercial items) — proposals are being accepted.',
  award: 'A contract has been awarded.',
  recompete_signal: 'Intelligence signal: an existing contract is nearing expiration with no successor procurement detected. NOT an active solicitation.',
  other: 'Other notice type.',
};

/** Stages where a response can currently be submitted (if the deadline has not passed). */
export const ACTIONABLE_STAGES: Stage[] = ['solicitation', 'combined_synopsis', 'sources_sought', 'rfi', 'presolicitation', 'subcontract', 'grant_posted', 'special_notice'];
export const PRE_SOLICITATION_STAGES: Stage[] = ['forecast', 'grant_forecast', 'recompete_signal', 'sources_sought', 'rfi', 'presolicitation'];

/**
 * BD decisions. The first block is what the UI offers; `interested`, `maybe` and
 * `not_relevant` are kept so decisions recorded by earlier versions stay valid.
 */
export const DECISIONS = ['strong_pursue', 'pursue', 'partner_sub', 'watch', 'review_later', 'pass', 'not_eligible', 'duplicate_irrelevant', 'interested', 'maybe', 'not_relevant'] as const;
export type Decision = (typeof DECISIONS)[number];
export const PRIMARY_DECISIONS: Decision[] = ['strong_pursue', 'pursue', 'partner_sub', 'watch', 'review_later', 'pass', 'not_eligible', 'duplicate_irrelevant'];
export const DECISION_LABELS: Record<Decision, string> = {
  strong_pursue: 'Strong pursue',
  pursue: 'Pursue',
  partner_sub: 'Partner / sub',
  watch: 'Watch',
  review_later: 'Review later',
  pass: 'Pass',
  not_eligible: 'Not eligible',
  duplicate_irrelevant: 'Duplicate / irrelevant',
  interested: 'Interested',
  maybe: 'Maybe',
  not_relevant: 'Not relevant',
};
/** Decisions that count as an active pursuit (pipeline value, office history, etc.). */
export const PURSUIT_DECISIONS: Decision[] = ['strong_pursue', 'pursue', 'partner_sub', 'interested'];
/** Decisions that remove an opportunity from review queues. */
export const CLOSED_DECISIONS: Decision[] = ['pass', 'not_eligible', 'duplicate_irrelevant', 'not_relevant'];
/**
 * Soft training label for preference learning (probability the user wants this kind of work).
 * `null` = not a preference signal: "Not eligible" is a hard rule handled by eligibility, and
 * "Duplicate / irrelevant" says nothing about the work itself. Neither trains the model.
 */
export const DECISION_LABEL_VALUE: Record<Decision, number | null> = {
  strong_pursue: 1,
  pursue: 0.95,
  interested: 0.85,
  partner_sub: 0.75,
  watch: 0.65,
  maybe: 0.5,
  review_later: null,
  pass: 0.12,
  not_relevant: 0,
  not_eligible: null,
  duplicate_irrelevant: null,
};

/** Lightweight BD capture pipeline (not a CRM). */
export const PURSUIT_STAGES = ['discovered', 'reviewing', 'qualified', 'capture', 'bid_decision', 'proposal', 'submitted', 'awarded', 'lost', 'no_bid'] as const;
export type PursuitStage = (typeof PURSUIT_STAGES)[number];
export const PURSUIT_STAGE_LABELS: Record<PursuitStage, string> = {
  discovered: 'Discovered',
  reviewing: 'Reviewing',
  qualified: 'Qualified',
  capture: 'Capture',
  bid_decision: 'Bid / no-bid',
  proposal: 'Proposal',
  submitted: 'Submitted',
  awarded: 'Awarded',
  lost: 'Lost',
  no_bid: 'No bid',
};
export const OPEN_PURSUIT_STAGES: PursuitStage[] = ['discovered', 'reviewing', 'qualified', 'capture', 'bid_decision', 'proposal', 'submitted'];

export const ELIGIBILITY_STATUSES = ['eligible', 'likely_eligible', 'unclear', 'likely_ineligible', 'ineligible'] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];
export const ELIGIBILITY_LABELS: Record<EligibilityStatus, string> = {
  eligible: 'Eligible',
  likely_eligible: 'Likely eligible',
  unclear: 'Unclear',
  likely_ineligible: 'Likely ineligible',
  ineligible: 'Ineligible',
};
export const ELIGIBILITY_RANK: Record<EligibilityStatus, number> = {
  eligible: 0,
  likely_eligible: 1,
  unclear: 2,
  likely_ineligible: 3,
  ineligible: 4,
};

export const SCORE_COMPONENTS = ['capability', 'scope', 'past_performance', 'alignment', 'value', 'location', 'timeline', 'strategy'] as const;
export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];
export const SCORE_COMPONENT_LABELS: Record<ScoreComponent, string> = {
  capability: 'Capability match',
  scope: 'Scope / technical match',
  past_performance: 'Past performance match',
  alignment: 'NAICS / PSC / agency alignment',
  value: 'Contract size / value fit',
  location: 'Location / delivery fit',
  timeline: 'Timeline / capacity fit',
  strategy: 'Strategic / prime-sub fit',
};
export const DEFAULT_SCORE_WEIGHTS: Record<ScoreComponent, number> = {
  capability: 30,
  scope: 20,
  past_performance: 15,
  alignment: 10,
  value: 10,
  location: 5,
  timeline: 5,
  strategy: 5,
};

export const EVENT_LABELS: Record<string, string> = {
  NEW_OPPORTUNITY: 'New opportunity',
  NEW_SOURCE: 'New source linked',
  STATUS_CHANGED: 'Status changed',
  STAGE_CHANGED: 'Stage changed',
  DEADLINE_CHANGED: 'Deadline changed',
  VALUE_CHANGED: 'Value changed',
  CONTACT_CHANGED: 'Contact changed',
  NEW_DOCUMENT: 'New document',
  DOCUMENT_UPDATED: 'Document updated',
  AMENDMENT: 'Notice modified / amended',
  AWARD_POSTED: 'Award posted',
  FORECAST_LINKED: 'Forecast linked',
  INCUMBENT_IDENTIFIED: 'Incumbent identified',
  RECOMPETE_SIGNAL: 'Recompete signal',
  RELATIONSHIP_FOUND: 'Relationship found',
  FIELD_CHANGED: 'Field changed',
  REMOVED_FROM_SOURCE: 'No longer returned by source',
  MERGED: 'Merged',
  LIFECYCLE: 'Lifecycle event',
  SCOPE_CHANGED: 'Scope / description changed',
  DATES_CHANGED: 'Key date changed',
  CANCELLED: 'Cancelled',
  SET_ASIDE_CHANGED: 'Set-aside changed',
  SOLICITATION_RELEASED: 'Solicitation released',
  QA_PUBLISHED: 'Q&A published',
  REOPENED: 'Reopened',
  NOTICE_TYPE_CHANGED: 'Notice type changed',
  AGENCY_CHANGED: 'Agency / office changed',
  AWARD_INFO_ADDED: 'Award information added',
};

/** Event types that represent a meaningful change to a procurement (used by "what changed" views). */
export const MEANINGFUL_EVENT_TYPES = [
  'DEADLINE_CHANGED',
  'STATUS_CHANGED',
  'STAGE_CHANGED',
  'NOTICE_TYPE_CHANGED',
  'SET_ASIDE_CHANGED',
  'VALUE_CHANGED',
  'FIELD_CHANGED',
  'SCOPE_CHANGED',
  'AMENDMENT',
  'NEW_DOCUMENT',
  'DOCUMENT_UPDATED',
  'CONTACT_CHANGED',
  'AGENCY_CHANGED',
  'DATES_CHANGED',
  'AWARD_POSTED',
  'AWARD_INFO_ADDED',
  'CANCELLED',
  'REOPENED',
  'SOLICITATION_RELEASED',
];

/** Score dimensions shown side by side. Fit is never blended with the others. */
export const SCORE_DIMENSION_LABELS: Record<'fit' | 'eligibility' | 'attractiveness' | 'confidence' | 'priority', string> = {
  fit: 'Company fit',
  eligibility: 'Eligibility',
  attractiveness: 'Strategic attractiveness',
  confidence: 'Data confidence',
  priority: 'Review priority',
};

export const COVERAGE_SIGNAL_LABELS: Record<string, { label: string; description: string }> = {
  FORECAST_ONLY: { label: 'Forecast only', description: 'Known only from a procurement forecast — no SAM notice linked yet.' },
  FORECAST_OVERDUE: { label: 'Forecast overdue', description: 'The forecast award window has passed but no solicitation or award has been linked.' },
  SUBCONTRACT_ONLY: { label: 'Subcontract only', description: 'Found only on SBA SUBNet — invisible if you relied on SAM.gov alone.' },
  NO_SAM_MATCH: { label: 'No SAM match', description: 'Found on a non-SAM source with no matching SAM.gov notice.' },
  POSSIBLE_RECOMPETE: { label: 'Possible recompete', description: 'A contract is nearing expiration and no successor procurement has been detected.' },
  NO_AWARD_LINK: { label: 'No award link', description: 'An award notice exists but the award record could not be linked.' },
  ORPHAN_AWARD: { label: 'Orphan award', description: 'A relevant award references a solicitation that is not in the database.' },
  POSSIBLE_DUPLICATE: { label: 'Possible duplicate', description: 'Two profiles may describe the same procurement. Review in Merge Review.' },
  MISSING_DOCUMENTS: { label: 'Missing documents', description: 'An active solicitation with no documents captured.' },
  SOURCE_CONFLICT: { label: 'Source conflict', description: 'Sources disagree on a key fact (deadline, value, set-aside or NAICS).' },
  STALE_RECORD: { label: 'Stale record', description: 'An active profile that has not been seen in recent source refreshes.' },
  SOURCES_SOUGHT_NO_FOLLOWUP: { label: 'No follow-up solicitation', description: 'A Sources Sought / RFI from more than 90 days ago with no linked solicitation.' },
  NO_FORECAST_LINK: { label: 'No forecast link', description: 'A strong-fit solicitation with no linked forecast record.' },
};

export const SET_ASIDE_LABELS: Record<string, string> = {
  SBA: 'Total Small Business',
  SBP: 'Partial Small Business',
  '8A': '8(a)',
  '8AN': '8(a) Sole Source',
  HZC: 'HUBZone',
  HZS: 'HUBZone Sole Source',
  SDVOSBC: 'Service-Disabled Veteran-Owned SB',
  SDVOSBS: 'SDVOSB Sole Source',
  WOSB: 'Women-Owned Small Business',
  WOSBSS: 'WOSB Sole Source',
  EDWOSB: 'Economically Disadvantaged WOSB',
  EDWOSBSS: 'EDWOSB Sole Source',
  LAS: 'Local Area Set-Aside',
  IEE: 'Indian Economic Enterprise',
  ISBEE: 'Indian Small Business Economic Enterprise',
  BICiv: 'Buy Indian',
  VSA: 'Veteran-Owned SB (VA)',
  VSS: 'Veteran-Owned SB Sole Source (VA)',
};

/** Certification types the company can hold. Only the user sets these. */
export const CERTIFICATION_TYPES = [
  { code: 'SMALL_BUSINESS', label: 'Small business (for primary NAICS size standard)' },
  { code: '8A', label: 'SBA 8(a) Business Development' },
  { code: 'HUBZONE', label: 'HUBZone' },
  { code: 'SDVOSB', label: 'Service-Disabled Veteran-Owned Small Business' },
  { code: 'VOSB', label: 'Veteran-Owned Small Business' },
  { code: 'WOSB', label: 'Women-Owned Small Business' },
  { code: 'EDWOSB', label: 'Economically Disadvantaged WOSB' },
  { code: 'SDB', label: 'Small Disadvantaged Business' },
] as const;

export const CLEARANCE_LEVELS = ['none', 'public_trust', 'confidential', 'secret', 'top_secret', 'ts_sci'] as const;
export type ClearanceLevel = (typeof CLEARANCE_LEVELS)[number];
export const CLEARANCE_LABELS: Record<ClearanceLevel, string> = {
  none: 'None',
  public_trust: 'Public Trust',
  confidential: 'Confidential',
  secret: 'Secret',
  top_secret: 'Top Secret',
  ts_sci: 'TS/SCI',
};
export const CLEARANCE_RANK: Record<ClearanceLevel, number> = {
  none: 0,
  public_trust: 1,
  confidential: 2,
  secret: 3,
  top_secret: 4,
  ts_sci: 5,
};

export const GLOSSARY: Record<string, string> = {
  NAICS: 'North American Industry Classification System — the industry code an agency assigns to a procurement. It also determines the small-business size standard.',
  PSC: 'Product Service Code — what is being bought (e.g. DA01 = IT application development support).',
  PIID: 'Procurement Instrument Identifier — the official contract or order number.',
  UEI: 'Unique Entity ID — the 12-character SAM.gov identifier for a vendor.',
  CAGE: 'Commercial and Government Entity code — a 5-character vendor identifier.',
  'Set-aside': 'A procurement restricted to a category of business (small business, 8(a), HUBZone, SDVOSB, WOSB…).',
  IDV: 'Indefinite Delivery Vehicle — a contract (IDIQ, GWAC, BPA) under which task/delivery orders are placed.',
  Recompete: 'A new competition for work that is currently performed under an expiring contract.',
  Incumbent: 'The contractor currently performing the work.',
  'Sources Sought': 'Market research notice asking capable firms to identify themselves.',
  RFI: 'Request for Information — market research, not a request for proposals.',
  RFQ: 'Request for Quote.',
  RFP: 'Request for Proposal.',
  Obligated: 'Money legally committed by the government on a contract so far.',
  'Base and all options': 'The total potential value if every option is exercised.',
  'Data completeness': 'How many of the important facts about this opportunity are known. Separate from fit.',
  'Fit score': 'Objective comparison of the opportunity against your company profile (0–100).',
  'Preference score': 'Fit score adjusted by what you have actually pursued and passed on.',
  'Strategic attractiveness': 'How worthwhile the opportunity is if you can win it: size, timing/positioning, competition restriction, customer relationship and incumbent dynamics. Separate from fit.',
  'Data confidence': 'How much GovCheck actually knows (official values, scope text, documents, deadlines) — low confidence means the scores rest on thin data.',
  'Review priority': 'Ranking used for "Best" sort: the personalized score, capped when eligibility is doubtful so a keyword match never hides a hard restriction.',
};

export type Confidence = 'high' | 'medium' | 'low';

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return 'Unknown';
  return (STAGE_LABELS as Record<string, string>)[stage] ?? stage;
}

export function setAsideLabel(code: string | null | undefined, fallback?: string | null): string {
  if (!code || code === 'NONE') return fallback ? (/^no set.?aside/i.test(fallback) ? 'No set-aside' : fallback) : code === 'NONE' ? 'No set-aside' : '—';
  return SET_ASIDE_LABELS[code] ?? fallback ?? code;
}
