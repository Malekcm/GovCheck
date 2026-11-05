import { PROVENANCE_RANK, type Provenance } from '../../shared/domain';
import type { Db } from '../db';
import { stableStringify } from '../lib/hash';
import { chooseValue, FORECAST_CONNECTORS } from './canonical';
import { DISCOVERY_PROVIDERS, RESEARCH_LEAD_CONNECTOR } from './discovery';

/**
 * Opportunity dossier views: a consolidated Summary (every material field names its source)
 * and one tab per contributing source family. Built from evidence GovCheck is permitted to
 * hold; licensed discovery providers (G2X) get a tab that shows attribution and the current
 * user's live session only.
 */
export interface SourceFamily {
  key: string;
  label: string;
  type: string;
  authority: 'official' | 'official_forecast' | 'official_spending' | 'feed' | 'user' | 'discovery';
}

const FAMILIES: Record<string, SourceFamily> = {
  sam_opportunities: { key: 'sam', label: 'SAM.gov', type: 'Official federal contract opportunities', authority: 'official' },
  sam_bulk: { key: 'sam', label: 'SAM.gov', type: 'Official federal contract opportunities', authority: 'official' },
  sam_awards: { key: 'sam', label: 'SAM.gov', type: 'Official federal contract opportunities', authority: 'official' },
  dhs_apfs: { key: 'dhs_apfs', label: 'DHS APFS', type: 'Official agency procurement forecast', authority: 'official_forecast' },
  gsa_forecast: { key: 'gsa_forecast', label: 'GSA Forecast', type: 'Official agency procurement forecast', authority: 'official_forecast' },
  usaspending: { key: 'usaspending', label: 'USAspending', type: 'Official federal spending and award data', authority: 'official_spending' },
  grants_gov: { key: 'grants_gov', label: 'Grants.gov', type: 'Official federal grant opportunities', authority: 'official' },
  sba_subnet: { key: 'sba_subnet', label: 'SBA SubNet', type: 'Prime contractor subcontracting listing', authority: 'feed' },
  [RESEARCH_LEAD_CONNECTOR]: { key: 'research_lead', label: 'Research lead', type: 'User-authored tracking record (not government verified)', authority: 'user' },
};

export function familyOf(connectorId: string | null | undefined, connectorName?: string | null): SourceFamily {
  const id = connectorId ?? 'unknown';
  if (FAMILIES[id]) return FAMILIES[id];
  if (DISCOVERY_PROVIDERS[id]) return { key: id, label: DISCOVERY_PROVIDERS[id].label, type: 'Discovery provider', authority: 'discovery' };
  if (id === 'user') return { key: 'user', label: 'Team override', type: 'User-entered override', authority: 'user' };
  if (id === 'derived' || id.startsWith('engine:')) return { key: 'derived', label: 'GovCheck analysis', type: 'Derived from linked records', authority: 'feed' };
  return { key: id, label: connectorName ?? id.replace(/^feed_/, ''), type: 'Configured source', authority: 'feed' };
}

export type Authority = 'government_confirmed' | 'official_forecast' | 'official_spending' | 'derived' | 'ai' | 'estimate' | 'user_override' | 'user_authored' | 'feed';

export function authorityOf(provenance: Provenance, connectorId: string | null): Authority {
  if (provenance === 'user_entered') return connectorId === RESEARCH_LEAD_CONNECTOR ? 'user_authored' : 'user_override';
  if (provenance === 'ai_extracted') return 'ai';
  if (provenance === 'estimated') return 'estimate';
  if (provenance === 'derived') return 'derived';
  const fam = familyOf(connectorId);
  if (FORECAST_CONNECTORS.includes(connectorId ?? '')) return 'official_forecast';
  if (fam.authority === 'official_spending') return 'official_spending';
  if (fam.authority === 'official') return 'government_confirmed';
  return 'feed';
}

export const AUTHORITY_LABELS: Record<Authority, string> = {
  government_confirmed: 'Government confirmed',
  official_forecast: 'Agency forecast (planned, not confirmed)',
  official_spending: 'Official spending record',
  derived: 'Derived by GovCheck',
  ai: 'AI extracted — verify',
  estimate: 'Estimate — not official',
  user_override: 'Team override',
  user_authored: 'User-authored (not verified)',
  feed: 'Configured source',
};

const SUMMARY_FIELDS: [string, string][] = [
  ['title', 'Title'],
  ['department', 'Department'],
  ['subtier', 'Sub-agency'],
  ['office', 'Contracting office'],
  ['notice_type', 'Notice type'],
  ['status', 'Status'],
  ['solicitation_number', 'Solicitation number'],
  ['notice_id', 'Notice ID'],
  ['naics_code', 'NAICS'],
  ['psc_code', 'PSC'],
  ['set_aside', 'Set-aside'],
  ['set_aside_code', 'Set-aside code'],
  ['contract_vehicle', 'Contract vehicle'],
  ['response_deadline', 'Response deadline'],
  ['posted_at', 'Posted'],
  ['description', 'Scope of work'],
  ['primary_url', 'Official link'],
];
const DATE_FIELDS = new Set(['response_deadline', 'posted_at', 'archive_date']);
const ANCHORED = new Set(['title', 'status', 'response_deadline', 'notice_type', 'set_aside_code', 'set_aside', 'posted_at', 'description', 'primary_url', 'notice_id']);

export function comparable(field: string, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (DATE_FIELDS.has(field)) {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16);
  }
  if (typeof v === 'string') return v.trim().toUpperCase().replace(/\s+/g, ' ');
  return stableStringify(v);
}

interface FieldRow {
  id: string;
  field: string;
  value: any;
  provenance: Provenance;
  connector_id: string | null;
  connector_name?: string | null;
  source_record_id: string | null;
  observed_at: string;
  src_stage: string | null;
  is_current?: boolean;
  basis?: string | null;
}

export interface SummaryField {
  field: string;
  label: string;
  value: unknown;
  provenance: Provenance | null;
  authority: Authority | null;
  authorityLabel: string | null;
  source: { connectorId: string | null; family: string; label: string; sourceRecordId: string | null } | null;
  corroboratedBy: string[];
  conflict: boolean;
  superseded: { label: string; value: unknown; stage: string | null }[];
  alternatives: { value: unknown; provenance: Provenance; authorityLabel: string; source: string; observedAt: string; stage: string | null; sourceRecordId: string | null }[];
  overridden: { reason: string | null } | null;
}

/** Canonical choice + corroboration + conflicts for one field. Pure. */
export function summarizeField(field: string, label: string, values: FieldRow[], priorities: Map<string, number>, overrideNote?: string | null): SummaryField {
  const preferred = chooseValue(values as any, field, priorities) as FieldRow | null;
  const famOf = (v: FieldRow) => familyOf(v.connector_id, v.connector_name);
  const others = values.filter((v) => v !== preferred);
  const prefKey = preferred ? comparable(field, preferred.value) : '';
  const prefFam = preferred ? famOf(preferred).key : '';
  const corroboratedBy = [...new Set(others.filter((v) => comparable(field, v.value) === prefKey && famOf(v).key !== prefFam).map((v) => famOf(v).label))];
  const superseded: SummaryField['superseded'] = [];
  // Conflicts are judged among official values only: an AI or estimated value under an official one is
  // not a conflict, and a team override does not hide disagreement between the government records.
  const officials = values.filter((v) => v.provenance === 'official');
  const topOfficial = chooseValue(officials as any, field, priorities) as FieldRow | null;
  let conflict = false;
  for (const v of officials) {
    if (!topOfficial || v === topOfficial || comparable(field, v.value) === comparable(field, topOfficial.value)) continue;
    // Lifecycle supersession (a sources-sought deadline replaced by the solicitation's) is not a conflict.
    if (ANCHORED.has(field) && v.src_stage && topOfficial.src_stage && v.src_stage !== topOfficial.src_stage) {
      superseded.push({ label: famOf(v).label, value: v.value, stage: v.src_stage });
      continue;
    }
    conflict = true;
  }
  const sorted = [...values].sort((a, b) => PROVENANCE_RANK[a.provenance] - PROVENANCE_RANK[b.provenance]);
  return {
    field,
    label,
    value: preferred?.value ?? null,
    provenance: preferred?.provenance ?? null,
    authority: preferred ? authorityOf(preferred.provenance, preferred.connector_id) : null,
    authorityLabel: preferred ? AUTHORITY_LABELS[authorityOf(preferred.provenance, preferred.connector_id)] : null,
    source: preferred ? { connectorId: preferred.connector_id, family: famOf(preferred).key, label: famOf(preferred).label, sourceRecordId: preferred.source_record_id } : null,
    corroboratedBy,
    conflict,
    superseded,
    alternatives: sorted.map((v) => ({ value: v.value, provenance: v.provenance, authorityLabel: AUTHORITY_LABELS[authorityOf(v.provenance, v.connector_id)], source: famOf(v).label, observedAt: v.observed_at, stage: v.src_stage, sourceRecordId: v.source_record_id })),
    overridden: preferred?.connector_id === 'user' ? { reason: overrideNote ?? null } : null,
  };
}

const VALUE_KIND_LABELS: Record<string, { label: string; category: 'forecast' | 'solicitation' | 'award' | 'historical' | 'estimate' }> = {
  official_estimate: { label: 'Official estimate (solicitation)', category: 'solicitation' },
  ceiling: { label: 'Contract ceiling', category: 'solicitation' },
  forecast_estimate: { label: 'Forecast value range (planned — not an award)', category: 'forecast' },
  award_value: { label: 'Awarded value', category: 'award' },
  potential_value: { label: 'Potential value (base + all options)', category: 'award' },
  obligated: { label: 'Cumulative obligations (spending to date)', category: 'award' },
  historical_incumbent: { label: 'Predecessor contract value (historical)', category: 'historical' },
  estimated_likely: { label: 'GovCheck estimate (not official)', category: 'estimate' },
  subcontract_value: { label: 'Subcontract value', category: 'solicitation' },
  grant_ceiling: { label: 'Grant award ceiling', category: 'solicitation' },
  grant_total_funding: { label: 'Total program funding', category: 'solicitation' },
};

export interface DossierInput {
  opportunity: any;
  sources: any[];
  fieldValues: FieldRow[];
  overrides: any[];
  financials: any[];
  dates: any[];
  documents: any[];
  awards: any[];
  vendors: any[];
  events: any[];
  relationships: any[];
  capture: any | null;
  currentDecision: any | null;
  recommendedActions: any[];
  priorities: Map<string, number>;
}

export async function buildDossier(db: Db, input: DossierInput, viewer: { userId: string | null }) {
  const id = input.opportunity.id;
  const current = input.fieldValues.filter((f) => f.is_current !== false);
  const byField = new Map<string, FieldRow[]>();
  for (const f of current) byField.set(f.field, [...(byField.get(f.field) ?? []), f]);
  const overrideNotes = new Map<string, string | null>();
  for (const o of input.overrides) {
    overrideNotes.set(o.field, o.note ?? null);
    byField.set(o.field, [...(byField.get(o.field) ?? []), { id: `override:${o.field}`, field: o.field, value: o.value, provenance: 'user_entered', connector_id: 'user', connector_name: 'Team override', source_record_id: null, observed_at: o.created_at, src_stage: null }]);
  }

  const [discovery, versions, signals, assignments, tracking, research, pendingMatches] = await Promise.all([
    db.query<any>(
      `SELECT d.provider, d.provider_record_url, d.is_lead_origin, d.discovered_at, m.name AS discovered_by_name FROM opportunity_discovery d LEFT JOIN team_members m ON m.user_id = d.discovered_by WHERE d.opportunity_id = $1 ORDER BY d.discovered_at`,
      [id],
    ),
    db.query<any>(
      `SELECT v.source_record_id, v.content_hash, v.parser_version, v.retrieved_at FROM source_record_versions v
       WHERE v.source_record_id IN (SELECT source_record_id FROM opportunity_sources WHERE opportunity_id = $1) ORDER BY v.retrieved_at DESC`,
      [id],
    ),
    db.query<any>('SELECT id, source_name, source_url, category, notes, verification_status, review_status, observed_at FROM research_signals WHERE opportunity_id = $1 ORDER BY observed_at DESC', [id]),
    db.query<any>(`SELECT a.assignment_role, a.status, a.next_action, a.due_date, m.name FROM opportunity_assignments a JOIN team_members m ON m.user_id = a.user_id WHERE a.opportunity_id = $1 AND a.active ORDER BY a.assignment_role DESC, m.name`, [id]),
    db.one<any>('SELECT tracked, tracked_at FROM opportunity_tracking WHERE opportunity_id = $1', [id]),
    db.one<any>(`SELECT id, status, completed_at, report->>'executiveSummary' AS executive_summary, report->>'conditionalRecommendation' AS recommendation FROM research_runs WHERE opportunity_id = $1 ORDER BY created_at DESC LIMIT 1`, [id]),
    db.query<any>(`SELECT count(*)::int AS n FROM opportunity_relationships WHERE status = 'suggested' AND relationship_type IN ('possible_duplicate','possible_same_procurement') AND (from_opportunity_id = $1 OR to_opportunity_id = $1)`, [id]),
  ]);

  // ---------------- Summary ----------------
  const fields = SUMMARY_FIELDS.filter(([f]) => byField.has(f)).map(([f, label]) => summarizeField(f, label, byField.get(f)!, input.priorities, overrideNotes.get(f)));
  const value = input.financials
    .filter((f) => f.amount_low != null || f.amount_high != null)
    .map((f) => {
      const k = VALUE_KIND_LABELS[f.kind] ?? { label: f.label ?? f.kind, category: 'estimate' as const };
      return { kind: f.kind, family: familyOf(f.connector_id?.split(':')[0], f.connector_name).key, label: k.label, category: k.category, low: f.amount_low, high: f.amount_high, provenance: f.provenance as Provenance, authorityLabel: AUTHORITY_LABELS[authorityOf(f.provenance, f.connector_id?.split(':')[0] ?? null)], source: familyOf(f.connector_id?.split(':')[0], f.connector_name).label, award: f.piid ? { piid: f.piid, awardee: f.awardee_name } : null };
    });
  const forecastDates = input.dates
    .filter((d) => ['expected_solicitation', 'expected_award', 'forecast_award_fy', 'performance_start', 'performance_end', 'questions_due', 'response_due'].includes(d.kind))
    .map((d) => ({ kind: d.kind, value: d.date_value ?? d.date_text, provenance: d.provenance, authorityLabel: AUTHORITY_LABELS[authorityOf(d.provenance, d.connector_id)], source: familyOf(d.connector_id, d.connector_name).label }));
  const incumbents = input.vendors
    .filter((v) => ['confirmed_incumbent', 'possible_incumbent', 'awardee'].includes(v.role))
    .map((v) => ({ name: v.name, role: v.role, confidence: v.confidence, label: v.role === 'confirmed_incumbent' ? 'Confirmed incumbent' : v.role === 'awardee' ? 'Awardee' : 'Possible incumbent (derived — verify)' }));
  const awards = input.awards.filter((a) => a.status === 'active').map((a) => ({ piid: a.piid, awardee: a.awardee_name, relationship: a.relationship, confidence: a.confidence, source: familyOf(a.connector_id, a.connector_name).label, popEnd: a.pop_current_end ?? a.pop_potential_end ?? null }));
  const amendments = input.events.filter((e) => ['AMENDMENT', 'NEW_DOCUMENT'].includes(e.event_type)).slice(0, 8).map((e) => ({ title: e.title, at: e.occurred_at ?? e.detected_at, source: e.connector_name ?? null }));
  const materialChanges = input.events
    .filter((e) => !e.is_lifecycle && !['NEW_OPPORTUNITY', 'RELATIONSHIP_FOUND', 'DISCOVERY_ATTRIBUTED'].includes(e.event_type) && new Date(e.detected_at).getTime() > Date.now() - 30 * 86_400_000)
    .slice(0, 10)
    .map((e) => ({ type: e.event_type, title: e.title, at: e.detected_at, source: e.connector_name ?? null }));
  const conflicts = fields.filter((f) => f.conflict).map((f) => f.field);

  // ---------------- Source tabs ----------------
  const tabs = new Map<string, any>();
  const tabFor = (fam: SourceFamily) => {
    if (!tabs.has(fam.key)) tabs.set(fam.key, { key: fam.key, label: fam.label, type: fam.type, authority: fam.authority, records: [], awards: [], documents: [], discovery: [], signals: [] });
    return tabs.get(fam.key);
  };
  const canonicalByField = new Map(fields.map((f) => [f.field, comparable(f.field, f.value)]));
  for (const s of input.sources) {
    const fam = familyOf(s.connector_id, s.connector_name);
    const contributed = current.filter((v) => v.source_record_id === s.source_record_id).map((v) => ({ field: v.field, value: v.value, provenance: v.provenance, differsFromSummary: canonicalByField.has(v.field) && canonicalByField.get(v.field) !== comparable(v.field, v.value) }));
    const history = input.fieldValues
      .filter((v) => v.source_record_id === s.source_record_id && v.is_current === false)
      .slice(0, 50)
      .map((v: any) => ({ field: v.field, previous: v.value, supersededAt: v.superseded_at, observedAt: v.observed_at }));
    tabFor(fam).records.push({
      connectorId: s.connector_id,
      connectorName: s.connector_name,
      accessMethod: s.access_method,
      recordId: s.external_id,
      sourceRecordId: s.source_record_id,
      kind: s.record_kind,
      stage: s.stage,
      noticeType: s.notice_type,
      title: s.title,
      url: s.source_url,
      status: s.seen_status,
      lastRetrieved: s.retrieved_at,
      firstSeen: s.first_seen_at,
      lastChanged: s.last_changed_at,
      versionCount: s.version_count,
      linkMethod: s.link_method,
      linkEvidence: s.evidence,
      versions: versions.filter((v) => v.source_record_id === s.source_record_id).slice(0, 20),
      fieldsContributed: contributed,
      conflictingFields: contributed.filter((c) => c.differsFromSummary).map((c) => c.field),
      changesSincePrevious: history,
    });
  }
  for (const a of input.awards) tabFor(familyOf(a.connector_id, a.connector_name)).awards.push({ piid: a.piid, awardee: a.awardee_name, relationship: a.relationship, status: a.status, confidence: a.confidence, obligated: a.total_obligated ?? a.dollars_obligated, potential: a.base_and_all_options, popEnd: a.pop_current_end, dateSigned: a.date_signed });
  for (const d of input.documents) if (d.connector_id) tabFor(familyOf(d.connector_id, d.connector_name)).documents.push({ id: d.id, filename: d.filename, url: d.url, postedAt: d.posted_at, version: d.version, changed: d.changed_since_previous });
  const g2xConnected = viewer.userId ? !!(await db.one('SELECT 1 FROM g2x_connections WHERE user_id = $1', [viewer.userId])) : false;
  for (const d of discovery) {
    const tab = tabFor(familyOf(d.provider));
    tab.discovery.push({ provider: d.provider, url: d.provider_record_url, leadOrigin: d.is_lead_origin, discoveredAt: d.discovered_at, discoveredBy: d.discovered_by_name });
    if (d.provider === 'g2x') tab.session = { connected: g2xConnected, persistenceAuthorized: false, teamSharingAuthorized: false, note: 'G2X content is shown only inside your own connected G2X session and is never stored or shared with teammates.' };
  }
  for (const s of signals) tabFor({ key: `research:${s.source_name}`, label: `${s.source_name} research`, type: 'User-authored research note', authority: 'user' }).signals.push(s);
  const tabOrder = ['sam', 'dhs_apfs', 'gsa_forecast', 'usaspending', 'grants_gov', 'sba_subnet'];
  const sourceTabs = [...tabs.values()].sort((a, b) => {
    const ia = tabOrder.indexOf(a.key);
    const ib = tabOrder.indexOf(b.key);
    return (ia < 0 ? 50 : ia) - (ib < 0 ? 50 : ib) || a.label.localeCompare(b.label);
  });

  // ---------------- Compare sources ----------------
  const compareFields: [string, string][] = [
    ['response_deadline', 'Solicitation deadline'],
    ['notice_type', 'Notice type'],
    ['solicitation_number', 'Solicitation number'],
    ['naics_code', 'NAICS'],
    ['psc_code', 'PSC'],
    ['set_aside', 'Set-aside'],
    ['contract_vehicle', 'Contract vehicle'],
    ['department', 'Department'],
    ['office', 'Office'],
  ];
  const notApplicable = (tabKey: string, field: string) => (tabKey === 'usaspending' && ['response_deadline', 'notice_type', 'set_aside'].includes(field)) || (['dhs_apfs', 'gsa_forecast'].includes(tabKey) && field === 'response_deadline');
  const storedTabs = sourceTabs.filter((t) => t.records.length || t.awards.length);
  const compare = {
    columns: storedTabs.map((t) => ({ key: t.key, label: t.label })),
    sessionOnly: sourceTabs.filter((t) => t.authority === 'discovery').map((t) => t.label),
    rows: [
      ...compareFields.map(([field, label]) => ({
        field,
        label,
        overridable: ['response_deadline', 'set_aside_code', 'naics_code', 'contract_vehicle', 'psc_code', 'title'].includes(field),
        summary: fields.find((f) => f.field === field)?.value ?? null,
        cells: storedTabs.map((t) => {
          const vals = (byField.get(field) ?? []).filter((v) => familyOf(v.connector_id, v.connector_name).key === t.key);
          if (vals.length) return { tab: t.key, state: 'value', values: [...new Set(vals.map((v) => JSON.stringify(v.value)))].map((x) => JSON.parse(x)), provenance: vals[0].provenance };
          return { tab: t.key, state: notApplicable(t.key, field) ? 'not_applicable' : 'not_available', values: [] };
        }),
      })),
      // Values are never collapsed: forecast ranges, award ceilings and obligations stay distinct rows.
      ...[...new Set(value.map((v) => v.kind))].map((kind) => ({
        field: `value:${kind}`,
        label: VALUE_KIND_LABELS[kind]?.label ?? kind,
        overridable: false,
        summary: null,
        cells: storedTabs.map((t) => {
          const vals = value.filter((v) => v.kind === kind && v.family === t.key);
          return vals.length ? { tab: t.key, state: 'value', values: vals.map((v) => ({ low: v.low, high: v.high })), provenance: vals[0].provenance } : { tab: t.key, state: 'not_available', values: [] };
        }),
      })),
      {
        field: 'incumbent',
        label: 'Incumbent',
        overridable: false,
        summary: incumbents[0]?.name ?? null,
        cells: storedTabs.map((t) => {
          const names = [...new Set(t.awards.filter((a: any) => a.status === 'active').map((a: any) => a.awardee).filter(Boolean))];
          return names.length ? { tab: t.key, state: 'value', values: names } : { tab: t.key, state: 'not_available', values: [] };
        }),
      },
    ],
  };

  const owner = assignments.find((a) => a.assignment_role === 'owner');
  return {
    summary: {
      fields,
      conflicts,
      value: { headline: { low: input.opportunity.value_low, high: input.opportunity.value_high, label: input.opportunity.value_label, provenance: input.opportunity.value_provenance }, facts: value },
      stage: { stage: input.opportunity.stage, status: input.opportunity.status, isSignal: input.opportunity.is_signal, verification: input.opportunity.verification_status },
      forecastDates,
      incumbents,
      awards,
      documents: { count: input.documents.length, recent: input.documents.slice(-5).map((d) => ({ filename: d.filename, url: d.url, postedAt: d.posted_at })) },
      amendments,
      fit: { fitScore: input.opportunity.fit_score, eligibility: input.opportunity.eligibility_status, priority: input.opportunity.priority_score },
      capture: { decision: input.currentDecision?.decision ?? null, pursuitStage: input.capture?.pursuit_stage ?? null, priority: input.capture?.priority ?? null, tracked: tracking?.tracked ?? null },
      team: { owner: owner?.name ?? input.capture?.owner ?? null, collaborators: assignments.filter((a) => a.assignment_role === 'collaborator').map((a) => a.name) },
      research: research ? { id: research.id, status: research.status, completedAt: research.completed_at, executiveSummary: research.executive_summary, recommendation: research.recommendation, provenance: 'ai_extracted' } : null,
      nextActions: [
        ...(input.capture?.next_action ? [{ action: input.capture.next_action, due: input.capture.next_action_date, source: 'Capture plan' }] : []),
        ...assignments.filter((a) => a.next_action).map((a) => ({ action: a.next_action, due: a.due_date, source: `Assignment · ${a.name}` })),
        ...input.recommendedActions.slice(0, 3).map((a) => ({ action: a.action, due: a.due ?? null, source: 'GovCheck recommendation' })),
      ],
      materialChanges,
      discovery: { firstDiscoveredSource: input.opportunity.first_discovered_source, firstDiscoveredLabel: input.opportunity.first_discovered_source ? familyOf(input.opportunity.first_discovered_source).label : null, firstDiscoveredAt: input.opportunity.first_discovered_at, officialSources: [...new Set(input.sources.filter((s) => s.connector_id !== RESEARCH_LEAD_CONNECTOR).map((s) => familyOf(s.connector_id, s.connector_name).label))] },
      pendingMatchReviews: pendingMatches[0]?.n ?? 0,
    },
    sourceTabs,
    compare,
  };
}
