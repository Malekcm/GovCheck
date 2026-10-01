import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import DOMPurify from 'dompurify';
import { AlertTriangle, CheckCircle2, ExternalLink, FileText, RefreshCw, Sparkles, XCircle } from 'lucide-react';
import { CLASS_LABELS, EVENT_LABELS, PROVENANCE_RANK, SCORE_COMPONENT_LABELS, STAGE_LABELS, setAsideLabel, type Provenance, type ScoreComponent, type Stage } from '../../shared/domain';
import { api } from '../api';
import { date, daysUntil, money, moneyRange, pct, relative, titleize } from '../format';
import { DecisionControl } from '../components/DecisionControl';
import { Card, ClassBadge, Deadline, EligibilityBadge, Empty, ErrorBox, ListInput, Loading, Modal, Prov, ProvenanceLegend, Score, SourceBadges, StageBadge, Term, toast } from '../components/ui';

const SECTIONS: [string, string][] = [
  ['summary', 'Executive summary'],
  ['match', 'Why we match'],
  ['concerns', 'Gaps / concerns'],
  ['found', 'Why we found it'],
  ['score', 'Fit score breakdown'],
  ['info', 'Opportunity information'],
  ['scope', 'Scope of work'],
  ['proposal', 'Proposal requirements'],
  ['financial', 'Financial intelligence'],
  ['dates', 'Dates / duration'],
  ['contacts', 'Contacts'],
  ['agency', 'Agency intelligence'],
  ['incumbent', 'Incumbent / vendors'],
  ['awards', 'Historical / related awards'],
  ['related', 'Related procurements'],
  ['timeline', 'Procurement timeline'],
  ['documents', 'Documents'],
  ['changes', 'Change history'],
  ['sources', 'Sources / provenance'],
  ['notes', 'Notes & tags'],
];

const SCOPE_CATS: [string, string][] = [
  ['objective', 'Objectives'],
  ['task', 'Tasks'],
  ['workstream', 'Workstreams'],
  ['deliverable', 'Deliverables'],
  ['technology', 'Technologies'],
  ['system', 'Systems'],
  ['technical', 'Technical requirements'],
  ['labor_category', 'Labor categories'],
  ['staffing', 'Staffing'],
  ['key_personnel', 'Key personnel'],
  ['certification', 'Certifications'],
  ['clearance', 'Clearances'],
  ['travel', 'Travel'],
  ['location', 'Location / on-site'],
  ['performance_standard', 'Performance standards'],
  ['reporting', 'Reporting requirements'],
  ['compliance', 'Compliance requirements'],
  ['contract_type', 'Contract type'],
  ['contract_vehicle', 'Contract vehicle'],
  ['period_of_performance', 'Period of performance'],
  ['option_periods', 'Option periods'],
  ['pricing', 'Pricing information'],
];
const PROPOSAL_CATS: [string, string][] = [
  ['submission_deadline', 'Submission deadline'],
  ['question_deadline', 'Questions deadline'],
  ['page_limit', 'Page limits'],
  ['volume', 'Required volumes'],
  ['submission', 'Submission method'],
  ['form', 'Forms & representations'],
  ['evaluation_factor', 'Evaluation criteria / factors'],
  ['mandatory', 'Mandatory requirements'],
];

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  solicitation_number: 'Solicitation number',
  notice_id: 'Notice ID',
  notice_type: 'Notice type',
  stage: 'Stage',
  status: 'Status',
  opportunity_class: 'Class',
  department: 'Department',
  subtier: 'Sub-agency',
  office: 'Office',
  naics_code: 'NAICS',
  naics_codes: 'NAICS (all)',
  psc_code: 'PSC',
  set_aside_code: 'Set-aside code',
  set_aside: 'Set-aside',
  contract_vehicle: 'Contract vehicle',
  pricing_type: 'Pricing type',
  competition_type: 'Competition',
  posted_at: 'Posted',
  source_updated_at: 'Updated (source)',
  response_deadline: 'Response deadline',
  archive_date: 'Archive date',
  performance_start: 'Performance start',
  performance_end: 'Performance end',
  place: 'Place of performance',
  primary_url: 'Source URL',
  prime_contractor: 'Prime contractor',
  eligibility: 'Eligible applicants / solicited business types',
  description: 'Description',
};

function fmtValue(field: string, v: any): string {
  if (v === null || v === undefined || v === '') return '—';
  if (/(_at|deadline|_date|performance_)/.test(field) && typeof v === 'string') return date(v, /deadline/.test(field));
  if (field === 'stage') return STAGE_LABELS[v as Stage] ?? v;
  if (field === 'opportunity_class') return CLASS_LABELS[v as keyof typeof CLASS_LABELS] ?? v;
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'object') return Object.values(v).filter(Boolean).join(', ');
  return String(v);
}

function Fact({ k, children, prov, tip }: { k: string; children: React.ReactNode; prov?: string | null; tip?: string }) {
  return (
    <div className="fact">
      <div className="k">
        {tip ? <Term t={tip}>{k}</Term> : k} {prov && <Prov p={prov} />}
      </div>
      <div className="v">{children}</div>
    </div>
  );
}

function RequirementList({ items }: { items: any[] }) {
  return (
    <ul className="list-plain">
      {items.map((r) => (
        <li key={r.id}>
          {r.text} <Prov p={r.provenance} />
          {(r.evidence_quote || r.document_name) && (
            <div className="evidence">
              {r.evidence_quote && `“${r.evidence_quote}”`}
              {r.document_name && (
                <>
                  {' '}
                  — <a href={r.document_url} target="_blank" rel="noreferrer">{r.document_name}</a>
                  {r.page ? `, p. ${r.page}` : ''}
                </>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function OpportunityDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['opportunity', id], queryFn: () => api.get<any>(`/api/opportunities/${id}`) });
  const [refreshResult, setRefreshResult] = useState<any[] | null>(null);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    if (id) api.post(`/api/opportunities/${id}/view`).catch(() => undefined);
  }, [id]);
  useEffect(() => {
    if (q.data?.redirect) navigate(`/opportunities/${q.data.redirect}`, { replace: true });
  }, [q.data, navigate]);

  const refresh = useMutation({
    mutationFn: () => api.post<{ steps: any[] }>(`/api/opportunities/${id}/refresh`),
    onSuccess: (r) => {
      setRefreshResult(r.steps);
      qc.invalidateQueries({ queryKey: ['opportunity', id] });
    },
    onError: (e: Error) => toast(e.message),
  });
  const analyze = useMutation({
    mutationFn: (force: boolean) => api.post<{ status: string; message?: string }>(`/api/opportunities/${id}/analyze`, { force }),
    onSuccess: (r) => {
      toast(r.message ?? `AI analysis: ${r.status}`);
      qc.invalidateQueries({ queryKey: ['opportunity', id] });
    },
    onError: (e: Error) => toast(e.message),
  });

  const d = q.data;
  const reqBy = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const r of d?.requirements ?? []) m.set(r.category, [...(m.get(r.category) ?? []), r]);
    return m;
  }, [d]);

  if (q.isLoading) return <Loading label="Assembling intelligence dossier…" />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!d || d.redirect) return <Loading />;

  const o = d.opportunity;
  const provMap = new Map<string, any>(d.provenance.map((p: any) => [p.field, p]));
  const provOf = (field: string) => {
    const p = provMap.get(field);
    return p?.values.find((v: any) => v.id === p.preferredId)?.provenance ?? (p ? p.values[0]?.provenance : null);
  };
  const strengths = d.explanations.filter((e: any) => e.kind === 'strength');
  const gaps = d.explanations.filter((e: any) => e.kind === 'gap');
  const blocks = d.explanations.filter((e: any) => e.kind === 'hard_block');
  const verify = d.explanations.filter((e: any) => e.kind === 'verify');
  const infos = d.explanations.filter((e: any) => e.kind === 'info');
  const matched = d.explanations.filter((e: any) => e.kind === 'matched_capability');
  const components = [...d.components].sort((a: any, b: any) => Object.keys(SCORE_COMPONENT_LABELS).indexOf(a.component) - Object.keys(SCORE_COMPONENT_LABELS).indexOf(b.component));
  const officialFin = d.financials.filter((f: any) => f.provenance === 'official');
  const inferredFin = d.financials.filter((f: any) => f.provenance !== 'official');
  const lifecycle = d.events.filter((e: any) => e.is_lifecycle).sort((a: any, b: any) => new Date(a.occurred_at ?? a.detected_at).getTime() - new Date(b.occurred_at ?? b.detected_at).getTime());
  const futureDates = d.dates.filter((x: any) => x.date_value && new Date(x.date_value).getTime() > Date.now() && ['response_due', 'expected_award', 'performance_start', 'performance_end', 'potential_end', 'recompete_window_start', 'recompete_window_end', 'questions_due'].includes(x.kind));
  const changes = d.events.filter((e: any) => !e.is_lifecycle);
  const conflicts = d.provenance.filter((p: any) => p.conflict);
  const incumbents = d.vendors.filter((v: any) => ['confirmed_incumbent', 'possible_incumbent', 'awardee'].includes(v.role));
  const days = daysUntil(o.response_deadline);
  const aiBrief = d.aiBrief;
  const completeness = o.completeness_detail ?? { known: [], missing: [] };
  const descriptionHtml = o.description ? DOMPurify.sanitize(/<[a-z][\s\S]*>/i.test(o.description) ? o.description : o.description.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br/>'), { ADD_ATTR: ['target', 'rel'] }) : '';

  return (
    <div>
      {o.is_signal && (
        <div className="signal-banner">
          <AlertTriangle size={16} /> INTELLIGENCE SIGNAL — NOT AN ACTIVE SOLICITATION. Derived from an expiring contract; no successor procurement has been found yet.
        </div>
      )}
      {o.stage === 'forecast' && (
        <div className="forecast-banner">
          <FileText size={16} /> STAGE: Forecast / Pre-Solicitation Intelligence — no solicitation has been released{d.relationships.some((r: any) => ['solicitation', 'combined_synopsis'].includes(r.other_stage)) ? ' (a possibly related solicitation is linked below)' : ''}.
        </div>
      )}
      {o.opportunity_class === 'subcontract' && (
        <div className="callout" style={{ marginBottom: 10 }}>
          <strong>SUBCONTRACT opportunity.</strong> Posted by a prime contractor — you would contract with the prime, not the government.
        </div>
      )}
      {o.opportunity_class === 'grant' && (
        <div className="callout" style={{ marginBottom: 10 }}>
          <strong>GRANT / FUNDING opportunity</strong> — financial assistance, not a procurement contract.
        </div>
      )}

      <div className="dossier-head">
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <StageBadge stage={o.stage} isSignal={o.is_signal} />
              <ClassBadge cls={o.opportunity_class} />
              <SourceBadges ids={o.connector_ids} />
              {o.seen_status !== 'active' && <span className="badge warn">No longer listed by source</span>}
            </div>
            <h1>{o.title}</h1>
            <div className="muted" style={{ marginTop: 4 }}>
              {[o.department_name, o.subtier_name, o.office_name].filter(Boolean).join(' › ') || (o.opportunity_class === 'subcontract' ? 'Prime contractor opportunity' : 'Agency not reported')}
            </div>
          </div>
          <div className="row no-print">
            <button className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              {refresh.isPending ? <span className="spinner" /> : <RefreshCw size={14} />} Refresh this opportunity
            </button>
            <button className="btn" onClick={() => analyze.mutate(false)} disabled={analyze.isPending || !d.aiAvailable} title={d.aiAvailable ? 'Extract structured requirements with Claude (cached by content hash)' : 'Set ANTHROPIC_API_KEY to enable'}>
              {analyze.isPending ? <span className="spinner" /> : <Sparkles size={14} />} Analyze with AI
            </button>
            <Link className="btn" to={`/opportunities/${o.id}/brief`}>
              <FileText size={14} /> Capture brief
            </Link>
            {o.primary_url && (
              <a className="btn" href={o.primary_url} target="_blank" rel="noreferrer">
                <ExternalLink size={14} /> Source
              </a>
            )}
          </div>
        </div>
        <div className="facts">
          <Fact k="Fit score" tip="Fit score">
            <Score value={o.fit_score} />
          </Fact>
          <Fact k="Preference" tip="Preference score">
            <Score value={o.preference_score} />
          </Fact>
          <Fact k="Eligibility">
            <EligibilityBadge status={o.eligibility_status} />
          </Fact>
          <Fact k="Deadline" prov={provOf('response_deadline')}>
            <Deadline value={o.response_deadline} />
          </Fact>
          <Fact k={o.value_label ?? 'Value'} prov={o.value_provenance}>
            <span className={`num ${o.value_provenance === 'estimated' ? 'val-estimated' : ''}`}>{moneyRange(o.value_low, o.value_high)}</span>
          </Fact>
          <Fact k="Type" prov={provOf('notice_type')}>
            {o.notice_type ?? '—'}
          </Fact>
          <Fact k="Set-aside" prov={provOf('set_aside_code') ?? provOf('set_aside')} tip="Set-aside">
            {setAsideLabel(o.set_aside_code, o.set_aside)}
          </Fact>
          <Fact k="Solicitation #" prov={provOf('solicitation_number')}>
            <span className="mono">{o.solicitation_number ?? '—'}</span>
          </Fact>
          <Fact k="Data completeness" tip="Data completeness">
            <span className="num">{o.data_completeness ?? 0}%</span>
          </Fact>
        </div>
        <hr />
        <div className="spread no-print" style={{ alignItems: 'flex-start' }}>
          <DecisionControl opportunityId={o.id} current={d.currentDecision} />
          <ProvenanceLegend />
        </div>
        {refreshResult && (
          <div className="callout small" style={{ marginTop: 10 }}>
            <strong>Refresh complete.</strong>
            <ul className="list-plain">
              {refreshResult.map((s, i) => (
                <li key={i}>
                  <span className={`badge ${s.status === 'success' ? 'good' : s.status === 'error' ? 'bad' : 'neutral'}`}>{s.step}</span> {s.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="dossier">
        <nav className="toc no-print" aria-label="Sections">
          {SECTIONS.map(([k, l]) => (
            <a key={k} href={`#${k}`}>
              {l}
            </a>
          ))}
        </nav>
        <div>
          {/* Executive summary */}
          <Card id="summary" title="Executive summary">
            {aiBrief?.work_summary || o.summary ? (
              <div className="stack">
                <div className="row">
                  <Prov p="ai_extracted" /> <span className="small muted">Plain-English summary generated by AI from the notice and documents — verify against sources.</span>
                </div>
                <p style={{ whiteSpace: 'pre-wrap' }}>{o.summary ?? aiBrief.work_summary}</p>
                {aiBrief?.likely_responsibilities?.length > 0 && (
                  <>
                    <h3>What we would likely be responsible for</h3>
                    <ul className="list-plain">
                      {aiBrief.likely_responsibilities.map((x: string, i: number) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : (
              <div className="stack">
                <div className="row">
                  <Prov p="derived" />
                  <span className="small muted">Summary assembled from structured source data{d.aiAvailable ? ' — run “Analyze with AI” for a plain-English scope summary.' : '. Configure ANTHROPIC_API_KEY for AI summaries.'}</span>
                </div>
                <p>
                  <strong>{STAGE_LABELS[o.stage as Stage] ?? o.stage}</strong>
                  {o.opportunity_class !== 'prime' ? ` (${CLASS_LABELS[o.opportunity_class as keyof typeof CLASS_LABELS]})` : ''} from {o.subtier_name ?? o.department_name ?? 'an unreported agency'}
                  {o.naics_code ? `, NAICS ${o.naics_code}` : ''}
                  {o.value_low || o.value_high ? `, ${o.value_label?.toLowerCase() ?? 'value'} ${moneyRange(o.value_low, o.value_high)}` : ''}
                  {o.response_deadline ? `, responses due ${date(o.response_deadline)}${days !== null && days >= 0 ? ` (${days} days)` : ''}` : ''}.
                  {o.incumbent_name ? ` ${o.has_incumbent ? 'Incumbent' : 'Possible incumbent'}: ${o.incumbent_name}.` : ''}
                </p>
                {strengths.length > 0 && <p>Why we might care: {strengths.map((s: any) => s.text).join('; ')}.</p>}
              </div>
            )}
            {descriptionHtml && (
              <>
                <h3 style={{ margin: '12px 0 6px' }}>
                  {provOf('description') === 'official' ? 'Official description' : 'Description'} <Prov p={provOf('description')} />
                </h3>
                <div className="html-desc" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
              </>
            )}
          </Card>

          {/* Why we match */}
          <Card id="match" title="Why we match">
            {matched.length || strengths.length ? (
              <div className="grid grid-2">
                <div>
                  <h3>Requested work that matches your capabilities</h3>
                  <ul className="list-plain">
                    {matched.map((m: any) => (
                      <li key={m.detail.capabilityId}>
                        <CheckCircle2 size={13} color="var(--good)" style={{ verticalAlign: -2 }} /> <strong>{m.detail.name}</strong> <span className="muted small">(strength {m.detail.strength}/5 · “{m.detail.matchedTerm}” in {m.detail.inTitle ? 'title' : 'description'})</span>
                        <div className="evidence">{m.detail.evidence}</div>
                      </li>
                    ))}
                    {!matched.length && <li className="muted">No capability keywords found in the available text.</li>}
                  </ul>
                </div>
                <div>
                  <h3>Strengths</h3>
                  <ul className="list-plain">
                    {strengths.map((s: any, i: number) => (
                      <li key={i}>{s.text}</li>
                    ))}
                    {!strengths.length && <li className="muted">None identified.</li>}
                  </ul>
                </div>
              </div>
            ) : (
              <span className="muted">No matching signals yet. Confirm capabilities in the <Link to="/company">company profile</Link>.</span>
            )}
          </Card>

          {/* Gaps */}
          <Card id="concerns" title="Gaps / concerns">
            {blocks.length + verify.length + gaps.length + infos.length === 0 ? (
              <span className="muted">No concerns identified from the available data. That does not mean there are none — check the documents.</span>
            ) : (
              <div className="stack">
                {blocks.map((b: any, i: number) => (
                  <div key={`b${i}`} className="callout bad">
                    <XCircle size={14} style={{ verticalAlign: -2 }} /> <strong>Hard eligibility signal:</strong> {b.text} <Prov p={b.detail?.evidenceProvenance} />
                  </div>
                ))}
                {verify.map((b: any, i: number) => (
                  <div key={`v${i}`} className="callout warn">
                    <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> <strong>Verify:</strong> {b.text} <Prov p={b.detail?.evidenceProvenance} />
                  </div>
                ))}
                <ul className="list-plain">
                  {gaps
                    .filter((g: any) => !blocks.some((b: any) => b.text === g.text) && !verify.some((b: any) => b.text === g.text))
                    .map((g: any, i: number) => (
                      <li key={i}>{g.text}</li>
                    ))}
                  {infos.map((g: any, i: number) => (
                    <li key={`i${i}`} className="muted">
                      {g.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          {/* Why we found it */}
          <Card id="found" title="Why we found it">
            <div className="grid grid-2">
              {(['source', 'profile', 'relationship', 'signal'] as const).map((kind) => {
                const items = (o.discovery_reasons ?? []).filter((r: any) => r.kind === kind);
                if (!items.length) return null;
                return (
                  <div key={kind}>
                    <h3>{{ source: 'Sources', profile: 'Profile match', relationship: 'Related history', signal: 'Signals' }[kind]}</h3>
                    <ul className="list-plain">
                      {items.map((r: any) => (
                        <li key={r.code}>{r.text}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Score */}
          <Card id="score" title={<h2>Fit score breakdown <Score value={o.fit_score} /></h2>}>
            {components.length ? (
              <div>
                {components.map((c: any) => (
                  <div key={c.component} className="component-row">
                    <div>
                      <strong>{SCORE_COMPONENT_LABELS[c.component as ScoreComponent]}</strong>
                      <div className="scorebar" style={{ marginTop: 5 }}>
                        <span style={{ width: `${Math.round(Number(c.ratio) * 100)}%` }} />
                      </div>
                    </div>
                    <div className="num">
                      {Number(c.points).toFixed(1)}/{Number(c.max_points)}
                    </div>
                    <ul className="list-plain small">
                      {(c.explanation as string[]).map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  </div>
                ))}
                <hr />
                <h3>Personalized (learned) preference</h3>
                <p className="small">
                  Preference score <Score value={o.preference_score} /> = {d.preference.model.version ? `${Math.round((1 - d.preference.model.alpha) * 100)}% base fit + ${Math.round(d.preference.model.alpha * 100)}% learned from your ${d.preference.model.sampleCount} decisions (model v${d.preference.model.version}, ${d.preference.model.stage.replace('_', ' ')} stage)` : 'equal to base fit until you review opportunities'}.
                </p>
                {d.preference.contributions.length > 0 && (
                  <ul className="list-plain small">
                    {d.preference.contributions.map((c: any) => (
                      <li key={c.feature}>
                        <span className={c.contribution > 0 ? 'badge good' : 'badge bad'}>{c.contribution > 0 ? '+' : '−'}</span> {c.group}: <span className="mono">{c.feature.split(':').slice(1).join(':')}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {d.scoreHistory.length > 1 && (
                  <details>
                    <summary className="small">Why your personalized score changed ({d.scoreHistory.length} recorded changes)</summary>
                    <table className="data">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Fit</th>
                          <th>Preference</th>
                          <th>Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {d.scoreHistory.map((h: any, i: number) => (
                          <tr key={i}>
                            <td>{date(h.computed_at, true)}</td>
                            <td className="num">{h.fit_score}</td>
                            <td className="num">{h.preference_score}</td>
                            <td className="small">{h.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </div>
            ) : (
              <span className="muted">Not scored yet.</span>
            )}
          </Card>

          {/* Info */}
          <Card id="info" title="Opportunity information">
            {conflicts.length > 0 && (
              <div className="conflict small" style={{ marginBottom: 10 }}>
                <AlertTriangle size={13} style={{ verticalAlign: -2 }} /> Sources disagree on: {conflicts.map((c: any) => FIELD_LABELS[c.field] ?? c.field).join(', ')}. All values are kept below; the preferred value follows source precedence.
              </div>
            )}
            <div className="kv">
              {[
                ['Solicitation number', o.solicitation_number, 'solicitation_number'],
                ['Notice ID', o.primary_notice_id, 'notice_id'],
                ['PIID / award numbers', d.identifiers.filter((i: any) => ['piid', 'award_number', 'predecessor_piid'].includes(i.id_type)).map((i: any) => `${i.value} (${titleize(i.id_type)})`).join(', ') || null, null],
                ['Opportunity type', o.notice_type, 'notice_type'],
                ['Status', titleize(o.status), 'status'],
                ['NAICS', [o.naics_code, ...(o.naics_codes ?? []).filter((x: string) => x !== o.naics_code)].filter(Boolean).join(', '), 'naics_code'],
                ['PSC', o.psc_code, 'psc_code'],
                ['Set-aside', o.set_aside_code || o.set_aside ? setAsideLabel(o.set_aside_code, o.set_aside) : null, o.set_aside_code ? 'set_aside_code' : 'set_aside'],
                ['Competition type', o.competition_type, 'competition_type'],
                ['Pricing type', o.pricing_type ?? reqBy.get('contract_type')?.[0]?.text, 'pricing_type'],
                ['Contract vehicle', o.contract_vehicle ?? reqBy.get('contract_vehicle')?.[0]?.text, 'contract_vehicle'],
                ['Place of performance', [o.place_city, o.place_state, o.place_zip, o.place_country].filter(Boolean).join(', '), 'place'],
              ].map(([label, value, field]) => (
                <div key={label as string} style={{ display: 'contents' }}>
                  <div className="k">
                    {label === 'NAICS' || label === 'PSC' || label === 'Set-aside' ? <Term t={label as string} /> : label}
                  </div>
                  <div>
                    {value ? value : <span className="muted">Unknown</span>} {value && field ? <Prov p={provOf(field as string) ?? 'derived'} /> : !value ? <Prov p="unknown" /> : null}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Scope */}
          <Card id="scope" title="Scope of work">
            {SCOPE_CATS.some(([k]) => reqBy.has(k)) ? (
              <div className="grid grid-2">
                {SCOPE_CATS.filter(([k]) => reqBy.has(k)).map(([k, l]) => (
                  <div key={k}>
                    <h3>{l}</h3>
                    <RequirementList items={reqBy.get(k)!} />
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted">No structured scope extracted yet. {d.aiAvailable ? 'Run “Analyze with AI” after documents are downloaded.' : 'Derived requirements appear as documents are processed.'}</span>
            )}
            {(reqBy.get('risk') || reqBy.get('missing_information')) && (
              <div className="grid grid-2" style={{ marginTop: 12 }}>
                {reqBy.get('risk') && (
                  <div>
                    <h3>Risks</h3>
                    <RequirementList items={reqBy.get('risk')!} />
                  </div>
                )}
                {reqBy.get('missing_information') && (
                  <div>
                    <h3>Missing / unknown information</h3>
                    <RequirementList items={reqBy.get('missing_information')!} />
                  </div>
                )}
              </div>
            )}
          </Card>

          {/* Proposal */}
          <Card id="proposal" title="Proposal / response requirements">
            <div className="kv" style={{ marginBottom: 10 }}>
              <div className="k">Submission deadline</div>
              <div>
                <Deadline value={o.response_deadline} /> {o.response_deadline && <Prov p={provOf('response_deadline')} />}
              </div>
            </div>
            {PROPOSAL_CATS.some(([k]) => reqBy.has(k)) ? (
              <div className="grid grid-2">
                {PROPOSAL_CATS.filter(([k]) => reqBy.has(k)).map(([k, l]) => (
                  <div key={k}>
                    <h3>{l}</h3>
                    <RequirementList items={reqBy.get(k)!} />
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted">Page limits, volumes, evaluation factors and submission method have not been extracted yet.</span>
            )}
          </Card>

          {/* Financial */}
          <Card id="financial" title="Financial intelligence">
            <div className="grid grid-2">
              <div>
                <h3>Official values</h3>
                {officialFin.length ? (
                  <div className="stack">
                    {officialFin.map((f: any) => (
                      <div key={f.id}>
                        <div className="spread">
                          <span>{f.label ?? titleize(f.kind)}</span>
                          <span className="num">
                            {moneyRange(f.amount_low, f.amount_high)} <Prov p="official" />
                          </span>
                        </div>
                        <div className="small muted">
                          Source: {f.connector_name ?? f.connector_id}
                          {f.piid ? ` · award ${f.piid}` : ''}
                          {f.basis ? ` · ${f.basis}` : ''}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">Official value: not provided by any connected source.</p>
                )}
              </div>
              <div>
                <h3>Derived / estimated values</h3>
                {inferredFin.length ? (
                  <div className="stack">
                    {inferredFin.map((f: any) => (
                      <div key={f.id}>
                        <div className="spread">
                          <span>{f.label ?? titleize(f.kind)}</span>
                          <span className={`num ${f.provenance === 'estimated' ? 'val-estimated' : 'val-derived'}`}>
                            {moneyRange(f.amount_low, f.amount_high)} <Prov p={f.provenance} />
                          </span>
                        </div>
                        <div className="small muted">
                          {f.confidence && <span className={`badge ${f.confidence === 'high' ? 'good' : f.confidence === 'medium' ? 'warn' : 'neutral'}`}>{f.confidence} confidence</span>} {f.basis}
                        </div>
                      </div>
                    ))}
                    <p className="small muted">Estimates are built from comparable historical awards and are never official government estimates.</p>
                  </div>
                ) : (
                  <p className="muted">No comparable award history yet. “Refresh this opportunity” pulls agency + NAICS award history from USAspending.</p>
                )}
              </div>
            </div>
          </Card>

          {/* Dates */}
          <Card id="dates" title="Dates / duration">
            {d.dates.length ? (
              <table className="data">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Value</th>
                    <th>Label</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {d.dates.map((x: any) => (
                    <tr key={x.id}>
                      <td>{titleize(x.kind)}</td>
                      <td className="nowrap">{x.date_text && !x.date_value ? x.date_text : date(x.date_value, x.kind === 'response_due')}</td>
                      <td>
                        <Prov p={x.provenance} title={x.basis ?? undefined} /> {x.date_text && x.date_value ? <span className="small muted">{x.date_text}</span> : null}
                      </td>
                      <td className="small muted">{x.connector_name ?? x.connector_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="muted">No dates captured.</span>
            )}
          </Card>

          {/* Contacts */}
          <Card id="contacts" title="Contacts">
            {d.contacts.length ? (
              <table className="data">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Name</th>
                    <th>Title</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {d.contacts.map((c: any, i: number) => (
                    <tr key={i}>
                      <td>{titleize(c.role)}</td>
                      <td>{c.full_name ?? '—'}</td>
                      <td className="small">{c.title ?? '—'}</td>
                      <td>{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : '—'}</td>
                      <td className="nowrap">{c.phone ?? '—'}</td>
                      <td className="small muted">
                        {c.connector_name ?? c.connector_id} <Prov p={c.provenance} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="muted">No public contacts in connected sources{o.stage === 'forecast' ? ' (forecast contacts are behind a login on Acquisition Gateway and are not collected).' : '.'}</span>
            )}
          </Card>

          {/* Agency */}
          <Card id="agency" title="Agency intelligence" actions={o.subagency_id || o.agency_id ? <Link to={`/agencies/${o.subagency_id ?? o.agency_id}`}>Agency page →</Link> : null}>
            {d.agencyStats ? (
              <div className="grid grid-2">
                <div className="kv">
                  <div className="k">Agency</div>
                  <div>{o.department_name ?? '—'}</div>
                  <div className="k">Sub-agency</div>
                  <div>{o.subtier_name ?? '—'}</div>
                  <div className="k">Office</div>
                  <div>{o.office_name ?? '—'}</div>
                  <div className="k">Profiles from this agency</div>
                  <div className="num">{d.agencyStats.opportunities}</div>
                  <div className="k">From this office</div>
                  <div className="num">{d.agencyStats.office_opportunities}</div>
                  <div className="k">Award history (this NAICS)</div>
                  <div className="num">
                    {money(d.agencyStats.naics_award_total)} · {d.agencyStats.naics_award_count} awards <Prov p="official" title="Sum of official award obligations stored locally" />
                  </div>
                </div>
                <div>
                  <h3>Frequent vendors (this agency & NAICS)</h3>
                  {d.topVendors.length ? (
                    <div className="bar-list">
                      {d.topVendors.map((v: any) => (
                        <div key={v.awardee_name} className="bar-row small">
                          <div>
                            {v.vendor_id ? <Link to={`/vendors/${v.vendor_id}`}>{v.awardee_name}</Link> : v.awardee_name}{' '}
                            <span className="muted">({v.awards})</span>
                            <div className="bar" style={{ width: `${Math.max(4, (Number(v.total) / Number(d.topVendors[0].total || 1)) * 100)}%` }} />
                          </div>
                          <div className="num right">{money(v.total)}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="muted small">No award history stored yet.</span>
                  )}
                </div>
              </div>
            ) : (
              <span className="muted">No agency information.</span>
            )}
          </Card>

          {/* Incumbent */}
          <Card id="incumbent" title="Incumbent / vendor intelligence">
            {incumbents.length ? (
              <div className="stack">
                {incumbents.map((v: any) => (
                  <div key={`${v.id}-${v.role}`} className="spread" style={{ alignItems: 'flex-start' }}>
                    <div>
                      <span className={`badge ${v.role === 'possible_incumbent' ? 'warn' : 'good'}`}>{v.role === 'confirmed_incumbent' ? 'CONFIRMED INCUMBENT' : v.role === 'awardee' ? 'AWARDEE' : 'POSSIBLE INCUMBENT'}</span>{' '}
                      <Link to={`/vendors/${v.id}`}>
                        <strong>{v.name}</strong>
                      </Link>{' '}
                      <span className="small muted">
                        <Term t="UEI" /> {v.uei ?? '—'} · <Term t="CAGE" /> {v.cage ?? '—'} · {v.confidence} confidence
                      </span>
                      <div className="evidence">Evidence: {(v.evidence ?? []).join('; ')}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted">No incumbent identified. {o.opportunity_class === 'prime' ? 'Refresh this opportunity to search award history.' : ''}</span>
            )}
          </Card>

          {/* Awards */}
          <Card id="awards" title="Historical / related awards" bodyClass="">
            {d.awards.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Relationship</th>
                      <th>
                        <Term t="PIID">Award</Term>
                      </th>
                      <th>Vendor</th>
                      <th>
                        <Term t="Base and all options">Potential</Term>
                      </th>
                      <th>
                        <Term t="Obligated" />
                      </th>
                      <th>Period</th>
                      <th>Office</th>
                      <th>NAICS / PSC</th>
                      <th>Similarity</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {d.awards.map((a: any) => (
                      <tr key={`${a.id}-${a.relationship}`} style={a.status === 'rejected' ? { opacity: 0.45 } : undefined}>
                        <td>
                          <span className={`badge ${a.relationship === 'award_of' || a.relationship === 'incumbent' ? 'good' : a.relationship === 'possible_incumbent' ? 'warn' : 'neutral'}`}>{titleize(a.relationship)}</span>
                          <div className="small muted">
                            {a.confidence} · {a.method}
                          </div>
                        </td>
                        <td className="mono small">
                          {a.usaspending_id ? (
                            <a href={`https://www.usaspending.gov/award/${encodeURIComponent(a.usaspending_id)}`} target="_blank" rel="noreferrer">
                              {a.piid}
                            </a>
                          ) : (
                            a.piid
                          )}
                          {a.referenced_idv_piid && <div className="muted">IDV {a.referenced_idv_piid}</div>}
                        </td>
                        <td className="small">{a.vendor_id ? <Link to={`/vendors/${a.vendor_id}`}>{a.awardee_name}</Link> : a.awardee_name}</td>
                        <td className="num">{money(a.base_and_all_options)}</td>
                        <td className="num">{money(a.total_obligated ?? a.dollars_obligated)}</td>
                        <td className="small nowrap">
                          {date(a.pop_start)} → {date(a.pop_current_end)}
                        </td>
                        <td className="small">{a.office_name ?? a.subtier_name}</td>
                        <td className="small mono">
                          {a.naics_code} / {a.psc_code}
                        </td>
                        <td className="small" title={(a.evidence ?? []).join('\n')}>
                          {a.confidence_score != null ? pct(a.confidence_score) : '—'}
                        </td>
                        <td>
                          {a.method === 'probabilistic' && (
                            <button
                              className="btn ghost sm"
                              onClick={() =>
                                api.put(`/api/opportunities/${o.id}/awards/${a.id}`, { status: a.status === 'rejected' ? 'active' : 'rejected', relationship: a.relationship }).then(() => qc.invalidateQueries({ queryKey: ['opportunity', id] }))
                              }
                            >
                              {a.status === 'rejected' ? 'Restore' : 'Not related'}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="card-body muted">No related awards linked yet.</div>
            )}
          </Card>

          {/* Related */}
          <Card id="related" title="Related procurements" actions={<button className="btn sm no-print" onClick={() => setLinking(true)}>Link manually</button>}>
            {d.relationships.length ? (
              <table className="data">
                <thead>
                  <tr>
                    <th>Relationship</th>
                    <th>Profile</th>
                    <th>Stage</th>
                    <th>Confidence</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {d.relationships.map((r: any) => (
                    <tr key={r.id}>
                      <td>
                        <span className={`badge ${r.status === 'confirmed' ? 'good' : 'warn'}`}>{titleize(r.relationship_type)}</span>
                        <div className="small muted">
                          {r.status} · {r.method}
                        </div>
                      </td>
                      <td>
                        <Link to={`/opportunities/${r.other_id}`}>{r.other_title}</Link>
                        <div className="small muted mono">{r.other_solicitation_number}</div>
                      </td>
                      <td>
                        <StageBadge stage={r.other_stage} isSignal={r.other_is_signal} />
                      </td>
                      <td className="num">{r.confidence != null ? pct(r.confidence) : '—'}</td>
                      <td className="small">{(r.evidence ?? []).join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="muted">No related procurements found.</span>
            )}
            {d.relationships.some((r: any) => r.status === 'suggested') && (
              <p className="small" style={{ marginTop: 8 }}>
                Suggested links are never merged automatically. <Link to="/merge">Review them in Merge Review →</Link>
              </p>
            )}
          </Card>

          {/* Timeline */}
          <Card id="timeline" title="Procurement timeline">
            {lifecycle.length || futureDates.length ? (
              <div className="timeline">
                {lifecycle.map((e: any) => (
                  <div key={e.id} className={`ev ${e.lifecycle_stage ?? ''} ${o.is_signal ? 'signal' : ''}`}>
                    <div>
                      <strong>{STAGE_LABELS[e.lifecycle_stage as Stage] ?? titleize(e.lifecycle_stage)}</strong> <span className="muted small">{date(e.occurred_at ?? e.detected_at)}</span>
                    </div>
                    <div className="small">
                      {e.title} {e.connector_name && <span className="badge outline">{e.connector_name}</span>}
                    </div>
                  </div>
                ))}
                {futureDates.map((x: any) => (
                  <div key={x.id} className="ev future">
                    <div>
                      <strong>{titleize(x.kind)}</strong> <span className="muted small">{date(x.date_value)}</span> <Prov p={x.provenance} title={x.basis ?? undefined} />
                    </div>
                    {x.basis && <div className="small muted">{x.basis}</div>}
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted">No lifecycle events yet.</span>
            )}
          </Card>

          {/* Documents */}
          <Card id="documents" title="Documents" bodyClass="">
            {d.documents.length ? (
              <table className="data">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Type</th>
                    <th>Source</th>
                    <th>Date</th>
                    <th>Version</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.documents.map((doc: any) => (
                    <tr key={doc.id}>
                      <td>
                        <a href={doc.url} target="_blank" rel="noreferrer">
                          {doc.filename ?? doc.url.split('/').pop()?.slice(0, 50)}
                        </a>
                        {doc.excerpt && <div className="small muted truncate" style={{ maxWidth: 380 }}>{doc.excerpt}</div>}
                      </td>
                      <td>{doc.doc_type ?? '—'}</td>
                      <td className="small">{doc.connector_name ?? doc.connector_id}</td>
                      <td className="small nowrap">{date(doc.posted_at ?? doc.first_seen_at)}</td>
                      <td className="num">
                        v{doc.version} {doc.changed_since_previous && <span className="badge warn">changed</span>}
                      </td>
                      <td className="small">
                        <span className={`badge ${doc.text_status === 'extracted' ? 'good' : doc.retrieval_status === 'failed' ? 'bad' : 'neutral'}`}>{doc.retrieval_status === 'downloaded' ? `${doc.text_status}${doc.page_count ? ` · ${doc.page_count}p` : ''}` : doc.retrieval_status}</span>
                        {doc.error_message && <div className="muted small">{doc.error_message}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="card-body muted">No documents listed by the sources.</div>
            )}
          </Card>

          {/* Changes */}
          <Card id="changes" title="Change history">
            {changes.length ? (
              <table className="data">
                <thead>
                  <tr>
                    <th>Detected</th>
                    <th>Change</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((e: any) => (
                    <tr key={e.id}>
                      <td className="small nowrap">{date(e.detected_at, true)}</td>
                      <td>
                        <span className="badge neutral">{EVENT_LABELS[e.event_type] ?? e.event_type}</span> {e.title}
                      </td>
                      <td className="small muted">{e.connector_name ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="muted">No changes since this profile was first seen ({relative(o.first_seen_at)}).</span>
            )}
          </Card>

          {/* Provenance */}
          <Card id="sources" title="Sources / provenance">
            <h3>Contributing source records</h3>
            <table className="data" style={{ marginBottom: 12 }}>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Record</th>
                  <th>Stage</th>
                  <th>Linked by</th>
                  <th>First / last seen</th>
                  <th>Versions</th>
                </tr>
              </thead>
              <tbody>
                {d.sources.map((s: any) => (
                  <tr key={s.source_record_id}>
                    <td>
                      {s.connector_name} <span className="badge outline">{s.access_method}</span>
                    </td>
                    <td className="small">
                      {s.source_url ? (
                        <a href={s.source_url} target="_blank" rel="noreferrer" className="mono">
                          {s.external_id.slice(0, 40)}
                        </a>
                      ) : (
                        <span className="mono">{s.external_id.slice(0, 40)}</span>
                      )}
                      <div className="muted">{s.title}</div>
                    </td>
                    <td className="small">{s.stage ? STAGE_LABELS[s.stage as Stage] ?? s.stage : titleize(s.record_kind)}</td>
                    <td className="small">
                      {s.link_method} {s.role !== 'primary' ? `(${s.role})` : ''}
                      {s.evidence?.length ? <div className="muted">{s.evidence.join('; ')}</div> : null}
                    </td>
                    <td className="small nowrap">
                      {date(s.first_seen_at)} / {date(s.last_seen_at)}
                      {s.seen_status !== 'active' && <div className="badge warn">{s.seen_status}</div>}
                    </td>
                    <td className="num">{s.version_count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <details>
              <summary>Field-level provenance ({d.provenance.length} fields{conflicts.length ? `, ${conflicts.length} with conflicts` : ''})</summary>
              <table className="data" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Field</th>
                    <th>Value</th>
                    <th>Label</th>
                    <th>Source</th>
                    <th>Observed</th>
                  </tr>
                </thead>
                <tbody>
                  {d.provenance
                    .filter((p: any) => p.field !== 'description')
                    .flatMap((p: any) =>
                      [...p.values]
                        .sort((a: any, b: any) => PROVENANCE_RANK[a.provenance as Provenance] - PROVENANCE_RANK[b.provenance as Provenance])
                        .map((v: any) => (
                          <tr key={v.id} style={p.conflict ? { background: 'var(--warn-bg)' } : undefined}>
                            <td className="small">
                              {FIELD_LABELS[p.field] ?? p.field} {v.id === p.preferredId && <span className="badge good">preferred</span>}
                            </td>
                            <td className="small" style={{ maxWidth: 360 }}>
                              {fmtValue(p.field, v.value).slice(0, 300)}
                              {v.basis && <div className="muted">{v.basis}</div>}
                            </td>
                            <td>
                              <Prov p={v.provenance} />
                            </td>
                            <td className="small">{v.connector_name ?? v.connector_id}</td>
                            <td className="small nowrap">{date(v.observed_at)}</td>
                          </tr>
                        )),
                    )}
                </tbody>
              </table>
              {d.fieldHistory.length > 0 && <p className="small muted" style={{ marginTop: 8 }}>{d.fieldHistory.length} superseded historical values are retained in the database.</p>}
            </details>
            <div className="grid grid-2" style={{ marginTop: 12 }}>
              <div>
                <h3>Known</h3>
                <div className="chips">
                  {completeness.known.map((k: string) => (
                    <span key={k} className="badge good">
                      {k}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <h3>Missing / uncertain</h3>
                <div className="chips">
                  {completeness.missing.map((k: string) => (
                    <span key={k} className="badge warn">
                      {k}
                    </span>
                  ))}
                  {!completeness.missing.length && <span className="muted small">Nothing flagged.</span>}
                </div>
              </div>
            </div>
            {d.aiAnalysis && (
              <p className="small muted" style={{ marginTop: 8 }}>
                Last AI analysis: {d.aiAnalysis.status} · {d.aiAnalysis.model} · {date(d.aiAnalysis.created_at, true)}
                {d.aiAnalysis.error_message ? ` · ${d.aiAnalysis.error_message}` : ''}{' '}
                {d.aiAvailable && (
                  <button className="btn ghost sm" onClick={() => analyze.mutate(true)}>
                    Re-run
                  </button>
                )}
              </p>
            )}
          </Card>

          <NotesAndTags oppId={o.id} notes={d.notes} tags={d.tags} />
        </div>
      </div>
      {linking && <LinkModal oppId={o.id} onClose={() => setLinking(false)} />}
    </div>
  );
}

function NotesAndTags({ oppId, notes, tags }: { oppId: string; notes: any[]; tags: string[] }) {
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['opportunity', oppId] });
  const add = useMutation({ mutationFn: () => api.post(`/api/opportunities/${oppId}/notes`, { body }), onSuccess: () => (setBody(''), invalidate()) });
  const del = useMutation({ mutationFn: (nid: string) => api.del(`/api/notes/${nid}`), onSuccess: invalidate });
  const saveTags = useMutation({ mutationFn: (t: string[]) => api.put(`/api/opportunities/${oppId}/tags`, { tags: t }), onSuccess: invalidate });
  return (
    <Card id="notes" title={<h2>Notes & tags <Prov p="user_entered" /></h2>}>
      <div className="grid grid-2">
        <div className="stack">
          <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Capture notes, teaming ideas, questions for the CO…" />
          <button className="btn primary sm" disabled={!body.trim() || add.isPending} onClick={() => add.mutate()}>
            Add note
          </button>
          {notes.map((n) => (
            <div key={n.id} className="card" style={{ padding: 8 }}>
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
              <div className="spread small muted">
                {date(n.created_at, true)}
                <button className="btn ghost sm danger" onClick={() => del.mutate(n.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          {!notes.length && <Empty title="No notes yet" />}
        </div>
        <div>
          <h3 style={{ marginBottom: 6 }}>Tags</h3>
          <ListInput value={tags} onChange={(t) => saveTags.mutate(t)} placeholder="Add a tag" />
          <p className="small muted" style={{ marginTop: 8 }}>Notes, tags and decisions are never changed by data refreshes.</p>
        </div>
      </div>
    </Card>
  );
}

function LinkModal({ oppId, onClose }: { oppId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [type, setType] = useState('related');
  const results = useQuery({ queryKey: ['search-related', oppId, q], queryFn: () => api.get<any[]>(`/api/opportunities/${oppId}/search-related?q=${encodeURIComponent(q)}`), enabled: q.length > 2 });
  const link = useMutation({
    mutationFn: (otherId: string) => api.post(`/api/opportunities/${oppId}/relationships`, { otherId, type }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['opportunity', oppId] });
      toast('Linked.');
      onClose();
    },
  });
  return (
    <Modal title="Link to another profile" onClose={onClose}>
      <div className="row" style={{ marginBottom: 10 }}>
        <input type="search" autoFocus placeholder="Search by title or solicitation #" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="related">Related</option>
          <option value="predecessor">This is a predecessor of…</option>
          <option value="successor">This is a successor of…</option>
          <option value="forecast_of">Forecast of</option>
          <option value="possible_same_procurement">Same procurement</option>
        </select>
      </div>
      {(results.data ?? []).map((r) => (
        <div key={r.id} className="spread" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
          <span>
            {r.title} <span className="muted small">{r.solicitation_number}</span>
          </span>
          <button className="btn sm" onClick={() => link.mutate(r.id)}>
            Link
          </button>
        </div>
      ))}
    </Modal>
  );
}
