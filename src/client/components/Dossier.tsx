import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ExternalLink, GitCompare } from 'lucide-react';
import { DECISION_LABELS, PURSUIT_STAGE_LABELS, STAGE_LABELS, type Decision, type PursuitStage, type Stage } from '../../shared/domain';
import { api } from '../api';
import { date, moneyRange, relative } from '../format';
import { useOpportunityPermission } from '../useOpportunityPermission';
import { Card, ErrorBox, Modal, Prov, toast } from './ui';

const AUTH_TONE: Record<string, string> = {
  government_confirmed: 'good',
  official_forecast: 'info',
  official_spending: 'info',
  derived: 'neutral',
  ai: 'warn',
  estimate: 'warn',
  user_override: 'outline',
  user_authored: 'warn',
  feed: 'neutral',
};

export function fmt(v: unknown, field?: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field && /deadline|posted|_at$|date/.test(field) && typeof v === 'string' && !Number.isNaN(Date.parse(v))) return date(v);
  if (Array.isArray(v)) return v.map((x) => fmt(x)).join(', ');
  if (typeof v === 'object') {
    const o = v as any;
    if ('low' in o || 'high' in o) return moneyRange(o.low, o.high);
    return Object.values(o).filter((x) => x != null && x !== '').join(', ');
  }
  const s = String(v);
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
}

function Authority({ label, authority }: { label: string | null; authority: string | null }) {
  if (!label) return null;
  return <span className={`badge ${AUTH_TONE[authority ?? ''] ?? 'neutral'}`}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------
export function TrackingPanel({ id, tracking, verification, discovery }: { id: string; tracking: any; verification: string; discovery: any }) {
  const qc = useQueryClient();
  const { canEdit, teamAuth, manager } = useOpportunityPermission(id);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<any>('/api/auth/me') });
  const viewer = me.data?.user?.role === 'viewer';
  const set = useMutation({
    mutationFn: (tracked: boolean) => api.post(`/api/opportunities/${id}/track`, { tracked, requestId: crypto.randomUUID() }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['opportunity', id] }),
    onError: (e: Error) => toast(e.message),
  });
  const canUntrack = !teamAuth || manager || canEdit;
  return (
    <Card id="tracking" title="Tracking">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {tracking?.tracked ? <span className="badge good">Tracked{tracking.trackedBy ? ` by ${tracking.trackedBy}` : ''}{tracking.trackedAt ? ` · ${relative(tracking.trackedAt)}` : ''}</span> : <span className="badge neutral">Not tracked</span>}
        {verification === 'research_lead' ? (
          <>
            <span className="badge warn">Research lead</span>
            <span className="badge warn">Not government verified</span>
            <span className="badge warn">No official solicitation confirmed</span>
          </>
        ) : (
          <span className="badge good">Government source linked</span>
        )}
        {discovery?.firstDiscoveredLabel && <span className="badge outline">First discovered by {discovery.firstDiscoveredLabel}{discovery.firstDiscoveredAt ? ` · ${date(discovery.firstDiscoveredAt)}` : ''}</span>}
        {discovery?.officialSources?.length > 0 && <span className="badge outline">Official source: {discovery.officialSources.join(', ')}</span>}
        <span style={{ flex: 1 }} />
        {!viewer && !tracking?.tracked && (
          <button className="btn primary sm" disabled={set.isPending} onClick={() => set.mutate(true)}>
            Track opportunity
          </button>
        )}
        {!viewer && tracking?.tracked && canUntrack && (
          <button className="btn sm" disabled={set.isPending} onClick={() => set.mutate(false)}>
            Untrack
          </button>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 8 }}>
        Capture decision, owner and collaborators, tags, notes, capture stage, priority and follow-up dates are managed in the sections below. Source refreshes and merges never change them.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
export function SummaryPanel({ summary, onOpenTab }: { summary: any; onOpenTab: (key: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const s = summary;
  return (
    <Card id="consolidated" title="Consolidated summary">
      {s.stage.verification === 'research_lead' && (
        <div className="callout warn small" style={{ marginBottom: 10 }}>
          <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> This is a user-authored research lead. Nothing below is government verified, and no open solicitation has been confirmed.
        </div>
      )}
      {s.conflicts.length > 0 && (
        <div className="callout bad small" style={{ marginBottom: 10 }}>
          <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> Official sources disagree on: {s.conflicts.join(', ')}. Review the alternatives below or in Compare sources.
        </div>
      )}
      <div className="row small" style={{ gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <span className="badge info">{STAGE_LABELS[s.stage.stage as Stage] ?? s.stage.stage}</span>
        <span className="badge neutral">Status: {s.stage.status}</span>
        {s.stage.isSignal && <span className="badge warn">Intelligence signal — not an active solicitation</span>}
        {s.pendingMatchReviews > 0 && <span className="badge info">{s.pendingMatchReviews} potential match(es) to review</span>}
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Field</th>
            <th>Value</th>
            <th>Source / authority</th>
          </tr>
        </thead>
        <tbody>
          {s.fields.map((f: any) => (
            <tr key={f.field}>
              <td className="nowrap">{f.label}</td>
              <td style={{ maxWidth: 520 }}>
                <div style={{ whiteSpace: f.field === 'description' ? 'pre-wrap' : undefined, maxHeight: f.field === 'description' ? 160 : undefined, overflow: 'auto' }}>
                  {f.field === 'primary_url' && typeof f.value === 'string' ? (
                    <a href={f.value} target="_blank" rel="noreferrer">
                      {f.value}
                    </a>
                  ) : (
                    fmt(f.value, f.field)
                  )}
                </div>
                {f.overridden && <div className="small muted">Team override{f.overridden.reason ? `: ${f.overridden.reason}` : ''} — source values preserved.</div>}
                {f.superseded.length > 0 && <div className="small muted">Supersedes earlier-stage value(s): {f.superseded.map((x: any) => `${fmt(x.value, f.field)} (${x.label}${x.stage ? `, ${x.stage}` : ''})`).join('; ')}</div>}
              </td>
              <td>
                <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                  {f.source && (
                    <button className="btn ghost sm" onClick={() => onOpenTab(f.source.family)} title="Open this source's tab">
                      {f.source.label}
                    </button>
                  )}
                  <Authority label={f.authorityLabel} authority={f.authority} />
                  {f.corroboratedBy.length > 0 && (
                    <span className="badge good" title="Other sources report the same value">
                      <CheckCircle2 size={11} /> Corroborated by {f.corroboratedBy.join(', ')}
                    </span>
                  )}
                  {f.conflict && <span className="badge bad">Conflict</span>}
                  {f.alternatives.length > 1 && (
                    <button className="btn ghost sm" onClick={() => setOpen(open === f.field ? null : f.field)}>
                      {open === f.field ? 'Hide' : `${f.alternatives.length} values`}
                    </button>
                  )}
                </div>
                {open === f.field && (
                  <ul className="list-plain small" style={{ marginTop: 4 }}>
                    {f.alternatives.map((a: any, i: number) => (
                      <li key={i}>
                        <strong>{fmt(a.value, f.field)}</strong> — {a.source} · {a.authorityLabel}
                        {a.stage ? ` · ${a.stage}` : ''} · {relative(a.observedAt)}
                      </li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <div>
          <h3>Value</h3>
          {s.value.facts.length ? (
            <ul className="list-plain small">
              {s.value.facts.map((v: any, i: number) => (
                <li key={i}>
                  <strong>{moneyRange(v.low, v.high)}</strong> — {v.label} <Prov p={v.provenance} /> <span className="muted">({v.source}{v.award ? ` · ${v.award.piid ?? ''} ${v.award.awardee ?? ''}` : ''})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No value reported by any connected source.</p>
          )}
          <p className="small muted">Forecast ranges, award ceilings and cumulative obligations are different measures and are never combined.</p>
          <h3>Forecast and key dates</h3>
          {s.forecastDates.length ? (
            <ul className="list-plain small">
              {s.forecastDates.map((d: any, i: number) => (
                <li key={i}>
                  {d.kind.replace(/_/g, ' ')}: <strong>{fmt(d.value, 'date')}</strong> <span className="muted">— {d.source} · {d.authorityLabel}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None reported.</p>
          )}
          <h3>Incumbents and awards</h3>
          {s.incumbents.length || s.awards.length ? (
            <ul className="list-plain small">
              {s.incumbents.map((v: any, i: number) => (
                <li key={`v${i}`}>
                  {v.name} — <span className={`badge ${v.role === 'possible_incumbent' ? 'warn' : 'good'}`}>{v.label}</span>
                </li>
              ))}
              {s.awards.map((a: any, i: number) => (
                <li key={`a${i}`}>
                  <span className="mono">{a.piid ?? '—'}</span> {a.awardee ?? ''} · {a.relationship.replace(/_/g, ' ')} ({a.confidence}) · {a.source}
                  {a.popEnd ? ` · ends ${date(a.popEnd)}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None linked.</p>
          )}
          <h3>Documents and amendments</h3>
          <p className="small">{s.documents.count} document(s).</p>
          {s.amendments.length > 0 && (
            <ul className="list-plain small">
              {s.amendments.map((a: any, i: number) => (
                <li key={i}>
                  {a.title} <span className="muted">· {relative(a.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>Capture</h3>
          <ul className="list-plain small">
            <li>Decision: {s.capture.decision ? DECISION_LABELS[s.capture.decision as Decision] ?? s.capture.decision : 'Not decided'}</li>
            <li>Capture stage: {s.capture.pursuitStage ? PURSUIT_STAGE_LABELS[s.capture.pursuitStage as PursuitStage] ?? s.capture.pursuitStage : '—'} · Priority: {s.capture.priority ?? '—'}</li>
            <li>Owner: {s.team.owner ?? 'Unassigned'}{s.team.collaborators.length ? ` · Collaborators: ${s.team.collaborators.join(', ')}` : ''}</li>
            <li>
              Company fit: {s.fit.fitScore ?? '—'} · Eligibility: {s.fit.eligibility ?? '—'} · Review priority: {s.fit.priority ?? '—'} <Prov p="derived" />
            </li>
          </ul>
          <h3>Research findings</h3>
          {s.research ? (
            <div className="small">
              <Prov p="ai_extracted" /> {s.research.status}
              {s.research.completedAt ? ` · ${relative(s.research.completedAt)}` : ''}
              {s.research.executiveSummary && <p style={{ whiteSpace: 'pre-wrap' }}>{s.research.executiveSummary}</p>}
              {s.research.recommendation && <p className="muted">{s.research.recommendation}</p>}
              <p className="muted">AI research output — not government-confirmed.</p>
            </div>
          ) : (
            <p className="small muted">No research run yet.</p>
          )}
          <h3>Next actions</h3>
          {s.nextActions.length ? (
            <ul className="list-plain small">
              {s.nextActions.map((a: any, i: number) => (
                <li key={i}>
                  {a.action} <span className="muted">— {a.source}{a.due ? ` · due ${date(a.due)}` : ''}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None.</p>
          )}
          <h3>Recent material changes (30 days)</h3>
          {s.materialChanges.length ? (
            <ul className="list-plain small">
              {s.materialChanges.map((e: any, i: number) => (
                <li key={i}>
                  {e.title} <span className="muted">· {e.source ?? 'GovCheck'} · {relative(e.at)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No material changes.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Potential matches (Phase 3)
// ---------------------------------------------------------------------------
export function PotentialMatches({ id }: { id: string }) {
  const qc = useQueryClient();
  const { manager, teamAuth } = useOpportunityPermission(id);
  const q = useQuery({ queryKey: ['potential-matches', id], queryFn: () => api.get<any[]>(`/api/opportunities/${id}/potential-matches`) });
  const act = useMutation({
    mutationFn: (b: { action: string; other: string; relationshipId: string }) => api.post('/api/merge/action', { action: b.action, primaryId: id, secondaryId: b.other, relationshipId: b.relationshipId, note: 'Decided from Potential Match review' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['potential-matches', id] });
      qc.invalidateQueries({ queryKey: ['opportunity', id] });
    },
    onError: (e: Error) => toast(e.message),
  });
  if (!q.data?.length) return null;
  const canDecide = !teamAuth || manager;
  return (
    <Card id="potential-matches" title="Potential matches — review required">
      <p className="small muted">These records may describe the same procurement, or a predecessor/successor. Nothing is merged until someone decides. Merges can be undone from Merge review.</p>
      {q.data.map((m) => (
        <div key={m.relationship_id} className="callout small" style={{ marginBottom: 8 }}>
          <div className="spread">
            <div>
              <Link to={`/opportunities/${m.id}`}>{m.title}</Link> <span className="badge neutral">{STAGE_LABELS[m.stage as Stage] ?? m.stage}</span> {m.verification_status === 'research_lead' && <span className="badge warn">Research lead</span>}
              <div className="muted">
                {m.relationship_type.replace(/_/g, ' ')} · {Math.round(Number(m.confidence ?? 0) * 100)}% · {m.department_name ?? 'Agency unknown'}
                {m.solicitation_number ? ` · ${m.solicitation_number}` : ''}
              </div>
            </div>
          </div>
          <div>Evidence: {(m.evidence ?? []).join('; ') || '—'}</div>
          {m.conflicts.length > 0 && <div style={{ color: 'var(--bad)' }}>Conflicts: {m.conflicts.join('; ')}</div>}
          {canDecide ? (
            <div className="row" style={{ marginTop: 6, gap: 6, flexWrap: 'wrap' }}>
              <button className="btn sm primary" disabled={act.isPending} onClick={() => act.mutate({ action: 'merge', other: m.id, relationshipId: m.relationship_id })}>
                Link to this opportunity (merge)
              </button>
              <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ action: 'keep_separate', other: m.id, relationshipId: m.relationship_id })}>
                Keep as separate procurement
              </button>
              <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ action: 'mark_predecessor', other: m.id, relationshipId: m.relationship_id })}>
                Mark as predecessor
              </button>
              <button className="btn sm" disabled={act.isPending} onClick={() => act.mutate({ action: 'mark_successor', other: m.id, relationshipId: m.relationship_id })}>
                Mark as successor
              </button>
              <button className="btn sm ghost" disabled={act.isPending} onClick={() => act.mutate({ action: 'keep_separate', other: m.id, relationshipId: m.relationship_id })}>
                Dismiss suggestion
              </button>
            </div>
          ) : (
            <p className="muted">A manager decides potential matches.</p>
          )}
        </div>
      ))}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Source tabs
// ---------------------------------------------------------------------------
export function SourceTab({ tab, opportunityId }: { tab: any; opportunityId: string }) {
  return (
    <div className="stack">
      <Card title={`${tab.label}`}>
        <p className="small muted">
          {tab.type}
          {tab.authority === 'official_forecast' ? ' — forecast information is planned, not government-confirmed procurement data.' : ''}
        </p>
        {tab.session && <G2xSession tab={tab} />}
        {tab.discovery.length > 0 && (
          <>
            <h3>Discovery attribution</h3>
            <ul className="list-plain small">
              {tab.discovery.map((d: any, i: number) => (
                <li key={i}>
                  {d.leadOrigin ? 'Research lead created' : 'Discovered'} {d.discoveredBy ? `by ${d.discoveredBy}` : ''} · {date(d.discoveredAt)}{' '}
                  {d.url && (
                    <a className="btn sm" href={d.url} target="_blank" rel="noreferrer">
                      <ExternalLink size={12} /> View original source
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {tab.records.map((r: any) => (
          <div key={r.sourceRecordId} className="card" style={{ marginTop: 10 }}>
            <div className="card-head">
              <div>
                <strong>{r.title ?? r.recordId}</strong>
                <div className="small muted">
                  {r.connectorName} · {r.kind}
                  {r.noticeType ? ` · ${r.noticeType}` : ''}
                  {r.stage ? ` · ${STAGE_LABELS[r.stage as Stage] ?? r.stage}` : ''}
                </div>
              </div>
              {r.url && (
                <a className="btn sm" href={r.url} target="_blank" rel="noreferrer">
                  <ExternalLink size={12} /> View original source
                </a>
              )}
            </div>
            <div className="card-body small">
              <div className="facts">
                <div>
                  <div className="muted">Record ID</div>
                  <span className="mono">{r.recordId}</span>
                </div>
                <div>
                  <div className="muted">Record status</div>
                  {r.status === 'active' ? <span className="badge good">Listed at source</span> : <span className="badge warn">{r.status.replace(/_/g, ' ')}</span>}
                </div>
                <div>
                  <div className="muted">Last successful retrieval</div>
                  {date(r.lastRetrieved)} ({relative(r.lastRetrieved)})
                </div>
                <div>
                  <div className="muted">Versions</div>
                  {r.versionCount}
                </div>
                <div>
                  <div className="muted">Linked by</div>
                  {r.linkMethod} {Array.isArray(r.linkEvidence) && r.linkEvidence.length ? `(${r.linkEvidence.join('; ')})` : ''}
                </div>
              </div>
              <h3>Fields contributed</h3>
              <table className="data">
                <tbody>
                  {r.fieldsContributed.map((f: any) => (
                    <tr key={f.field}>
                      <td className="nowrap">{f.field.replace(/_/g, ' ')}</td>
                      <td>{fmt(f.value, f.field)}</td>
                      <td>
                        <Prov p={f.provenance} /> {f.differsFromSummary && <span className="badge warn">Differs from summary</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {r.changesSincePrevious.length > 0 && (
                <>
                  <h3>Changes since previous retrieval</h3>
                  <ul className="list-plain">
                    {r.changesSincePrevious.slice(0, 15).map((c: any, i: number) => (
                      <li key={i}>
                        {c.field.replace(/_/g, ' ')}: previously <strong>{fmt(c.previous, c.field)}</strong> · replaced {relative(c.supersededAt)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {r.versions.length > 0 && (
                <details>
                  <summary>Version history ({r.versions.length})</summary>
                  <ul className="list-plain">
                    {r.versions.map((v: any) => (
                      <li key={v.content_hash} className="mono">
                        {date(v.retrieved_at)} · {String(v.content_hash).slice(0, 12)} · parser {v.parser_version}
                      </li>
                    ))}
                  </ul>
                  <a href={`/api/opportunities/${opportunityId}/sources.json`}>Download source records and versions (JSON)</a>
                </details>
              )}
            </div>
          </div>
        ))}
        {tab.awards.length > 0 && (
          <>
            <h3>Related awards</h3>
            <table className="data">
              <thead>
                <tr>
                  <th>PIID</th>
                  <th>Awardee</th>
                  <th>Relationship</th>
                  <th>Obligated to date</th>
                  <th>Base + all options</th>
                  <th>PoP end</th>
                </tr>
              </thead>
              <tbody>
                {tab.awards.map((a: any, i: number) => (
                  <tr key={i}>
                    <td className="mono">{a.piid ?? '—'}</td>
                    <td>{a.awardee ?? '—'}</td>
                    <td>
                      {a.relationship.replace(/_/g, ' ')} ({a.confidence}){a.status !== 'active' ? ' · rejected' : ''}
                    </td>
                    <td>{moneyRange(a.obligated, a.obligated)}</td>
                    <td>{moneyRange(a.potential, a.potential)}</td>
                    <td>{a.popEnd ? date(a.popEnd) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {tab.documents.length > 0 && (
          <>
            <h3>Documents</h3>
            <ul className="list-plain small">
              {tab.documents.map((d: any) => (
                <li key={d.id}>
                  <a href={d.url} target="_blank" rel="noreferrer">
                    {d.filename ?? d.url}
                  </a>{' '}
                  {d.postedAt ? `· ${date(d.postedAt)}` : ''} {d.changed ? <span className="badge warn">changed</span> : null}
                </li>
              ))}
            </ul>
          </>
        )}
        {tab.signals.length > 0 && (
          <ul className="list-plain small">
            {tab.signals.map((s: any) => (
              <li key={s.id}>
                <a href={s.source_url} target="_blank" rel="noreferrer">
                  {s.category}
                </a>{' '}
                · {s.verification_status} · {s.notes}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const G2X_ID = /\/opportunities\/[a-z_]+\/([0-9a-f-]{36})/i;

function G2xSession({ tab }: { tab: any }) {
  const [result, setResult] = useState<any>(null);
  const url = tab.discovery.find((d: any) => d.url)?.url as string | undefined;
  const g2xId = url?.match(G2X_ID)?.[1];
  const load = useMutation({ mutationFn: () => api.get(`/api/g2x/record/${g2xId}`), onSuccess: setResult });
  return (
    <div className="callout small" style={{ marginBottom: 10 }}>
      <div>
        G2X connection: {tab.session.connected ? <span className="badge good">Your account is connected</span> : <span className="badge warn">Not connected</span>} · Persistent storage: <span className="badge neutral">Not authorized</span> · Team sharing: <span className="badge neutral">Not authorized</span>
      </div>
      <p>{tab.session.note}</p>
      {tab.session.connected && g2xId ? (
        <>
          <button className="btn sm" disabled={load.isPending} onClick={() => load.mutate()}>
            Load in my G2X session
          </button>
          {load.error && <ErrorBox error={load.error} />}
          {result && (
            <div>
              <p className="muted">{result.retention}</p>
              <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 360, overflow: 'auto' }}>{(result.result?.content ?? []).map((b: any) => b.text ?? '').join('\n') || JSON.stringify(result.result, null, 2)}</pre>
              <button className="btn sm" onClick={() => setResult(null)}>
                Clear
              </button>
            </div>
          )}
        </>
      ) : (
        !tab.session.connected && (
          <p>
            <Link to="/integrations">Connect your own G2X account</Link> to view this record.
          </p>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compare sources
// ---------------------------------------------------------------------------
export function CompareSources({ id, compare }: { id: string; compare: any }) {
  const qc = useQueryClient();
  const { canEdit } = useOpportunityPermission(id);
  const [editing, setEditing] = useState<any>(null);
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => api.put(`/api/opportunities/${id}/overrides`, { field: editing.field === 'set_aside' ? 'set_aside_code' : editing.field, value: value.trim() || null, note: reason }),
    onSuccess: () => {
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['opportunity', id] });
      toast('Override saved. All source values are preserved.');
    },
    onError: (e: Error) => toast(e.message),
  });
  return (
    <Card title={<h2><GitCompare size={15} style={{ verticalAlign: -2 }} /> Compare sources</h2>}>
      <p className="small muted">Each column shows only what that source reported. A forecast range, an award ceiling and cumulative obligations are separate rows.{compare.sessionOnly.length ? ` ${compare.sessionOnly.join(', ')} content is session-only and not stored, so it is not compared here.` : ''}</p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Field</th>
              <th>Summary</th>
              {compare.columns.map((c: any) => (
                <th key={c.key}>{c.label}</th>
              ))}
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {compare.rows.map((r: any) => (
              <tr key={r.field}>
                <td className="nowrap">{r.label}</td>
                <td>{fmt(r.summary, r.field)}</td>
                {r.cells.map((cell: any) => (
                  <td key={cell.tab} className={cell.state === 'value' ? '' : 'muted small'}>
                    {cell.state === 'value' ? cell.values.map((v: any) => fmt(v, r.field)).join(' | ') : cell.state === 'not_applicable' ? 'Not applicable' : 'Not available'}
                  </td>
                ))}
                {canEdit && (
                  <td>
                    {r.overridable && (
                      <button
                        className="btn ghost sm"
                        onClick={() => {
                          setEditing(r);
                          setValue('');
                          setReason('');
                        }}
                      >
                        Override
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && (
        <Modal
          title={`Override ${editing.label}`}
          onClose={() => setEditing(null)}
          footer={
            <button className="btn primary" disabled={save.isPending || reason.trim().length < 3} onClick={() => save.mutate()}>
              Save override
            </button>
          }
        >
          <p className="small muted">The override becomes the canonical value. Every source value stays visible. Leave the value empty to remove an existing override.</p>
          <label className="field">
            New value
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={editing.field === 'response_deadline' ? 'YYYY-MM-DDTHH:MM' : ''} />
          </label>
          <label className="field">
            Reason (required)
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
          </label>
        </Modal>
      )}
    </Card>
  );
}
