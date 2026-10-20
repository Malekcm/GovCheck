import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, ErrorBox } from './ui';

type Query = { resource: string; filters: Record<string, string>; limit: number; maxPages: number };
type Plan = { query: Query; endpoint: string; estimatedRequests: number; maxRecords: number; fingerprint: string; entitlement: string };
type Result = { source: string; observedAt: string; requests: number; hasMore: boolean; warnings: unknown[];
  records: { data: Record<string, unknown>; matches: { opportunities: { id: string; title: string; evidence: string }[]; companies: { id: string; name: string }[]; coverage: string } }[] };
type Status = { configured: boolean; enabled: boolean; mode: string; allowance: number; internalCap: number; used: number;
  providerRemaining: number | null; protectedReserve: number; manualReserve: number; monthlyLimit: number; monthUsed: number;
  lastTestSuccess: string | null; lastAttempt: string | null; resetsAt: string; testUsed: number;
  filters: Record<string, string[]>; suggestedNaics: string[]; suggestedKeywords: string[]; authenticationBlocked: boolean };
type Note = { id: string; source_name: string; source_url: string; notes: string; review_status: string; verification_status: string };
const resources = ['forecasts','news','events','vehicles','idvs','subawards','entities','contracts','opportunities'];
const showDate = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not yet known';
const asText = (value: unknown) => typeof value === 'string' ? value : '';
const safeLink = (value: unknown) => {
  try { const url = new URL(asText(value)); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
};

export function TangoResearch() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['tango-status'], queryFn: () => api.get<Status>('/api/tango/status') });
  const notes = useQuery({ queryKey: ['research-notes'], queryFn: () => api.get<Note[]>('/api/research/signals') });
  const [resource, setResource] = useState('forecasts');
  const [filter, setFilter] = useState('agency');
  const [value, setValue] = useState('DOT');
  const [extraFilters, setExtraFilters] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(5);
  const [pages, setPages] = useState(1);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [acknowledge, setAcknowledge] = useState(false);
  const [sourceUrl, setSourceUrl] = useState('');
  const [note, setNote] = useState('');
  const [opportunityId, setOpportunityId] = useState('');
  const [authored, setAuthored] = useState(false);
  const query = { resource, filters: { ...extraFilters, ...(value.trim() ? { [filter]: value.trim() } : {}) }, limit, maxPages: pages };
  const refresh = () => qc.invalidateQueries({ queryKey: ['tango-status'] });
  const preview = useMutation({ mutationFn: () => api.post<Plan>('/api/tango/preview', query), onSuccess: setPlan });
  // Resolve to void so React Query's mutation cache never retains provider payloads.
  const execute = useMutation({ mutationFn: async () => { setResult(await api.post<Result>('/api/tango/research', { query: plan!.query, fingerprint: plan!.fingerprint })); }, onSettled: refresh });
  const test = useMutation({ mutationFn: () => api.post('/api/tango/test', { acknowledgeRequestCost: true }), onSettled: refresh });
  const clearAuth = useMutation({ mutationFn: () => api.post('/api/tango/clear-auth-block', { keyVerified: true }), onSettled: refresh });
  const save = useMutation({ mutationFn: () => api.post('/api/research/signals', {
    sourceName: (() => { try { return /(^|\.)orangeslices\.ai$/.test(new URL(sourceUrl).hostname) ? 'OrangeSlices' : 'Manual'; } catch { return 'Manual'; } })(),
    sourceUrl, notes: note, opportunityId: opportunityId || null, category: 'other', independentlyAuthored: authored,
  }), onSuccess: () => { setNote(''); setSourceUrl(''); setAuthored(false); void qc.invalidateQueries({ queryKey: ['research-notes'] }); } });
  const review = useMutation({ mutationFn: (n: Note) => api.put(`/api/research/signals/${n.id}`, { notes: n.notes, verificationStatus: n.verification_status, reviewStatus: 'reviewed', independentlyAuthored: true }), onSuccess: () => qc.invalidateQueries({ queryKey: ['research-notes'] }) });
  const busy = execute.isPending || test.isPending;
  const s = status.data;
  const invalidatePlan = () => { setPlan(null); preview.reset(); };
  return <Card title="Tango & G2X research">
    <div className="stack">
      <p>Look up procurement intelligence deliberately. Results stay in this view until cleared or closed. Official government records remain authoritative. G2X news and events require the G2X User entitlement.</p>
      {status.error && <ErrorBox error={status.error} />}
      {s && <div className="kv">
        <div className="k">Configuration</div><div>{s.configured ? 'Key configured on server' : 'Key missing'} · {s.enabled ? 'Enabled' : 'Disabled'} · mode: {s.mode} · scheduled: disabled</div>
        <div className="k">Daily budget</div><div>{s.used}/{s.internalCap} internal requests used · Free allowance: {s.allowance}/day, 25/min</div>
        <div className="k">Provider remaining</div><div>{s.providerRemaining ?? 'Unknown until a request returns quota headers'} · protected reserve: {s.protectedReserve} · manual reserve: {s.manualReserve}</div>
        <div className="k">Monthly safeguard</div><div>{s.monthUsed}/{s.monthlyLimit} local attempts (verify account allowance in Tango)</div>
        <div className="k">Last successful test</div><div>{showDate(s.lastTestSuccess)}</div>
        <div className="k">Last attempt</div><div>{showDate(s.lastAttempt)}</div>
        <div className="k">Next daily reset</div><div>{showDate(s.resetsAt)} ({s.resetsAt} UTC)</div>
      </div>}
      <div className="row"><label><input type="checkbox" checked={acknowledge} onChange={e => setAcknowledge(e.target.checked)} /> I understand a connection test consumes one request.</label>
        <button className="btn" disabled={!acknowledge || !s?.enabled || !s.configured || busy || (s.testUsed >= 5)} onClick={() => test.mutate()}>Test Connection (1 request)</button></div>
      {test.isSuccess && <p role="status">Connection validated. One request consumed.</p>}
      {test.error && <ErrorBox error={test.error} />}
      {s?.authenticationBlocked && <div className="callout warn">Authentication is blocked after a failed request. After correcting the server key, <button className="btn" disabled={clearAuth.isPending} onClick={() => clearAuth.mutate()}>I verified the key — clear block</button></div>}
      <fieldset disabled={busy || preview.isPending}>
        <legend>Preview a scoped research query (no API cost)</legend>
        <div className="row">
          <label>Category <select value={resource} onChange={e => { const r = e.target.value; setResource(r); setFilter(s?.filters[r]?.[0] ?? 'search'); setValue(''); setExtraFilters({}); invalidatePlan(); setResult(null); }}>{resources.map(r => <option key={r}>{r}</option>)}</select></label>
          <label>Filter <select value={filter} onChange={e => { setFilter(e.target.value); invalidatePlan(); }}>{(s?.filters[resource] ?? ['agency']).map(f => <option key={f}>{f}</option>)}</select></label>
          <label>Value <input value={value} onChange={e => { setValue(e.target.value); invalidatePlan(); }} placeholder="Agency, NAICS, UEI, or capability keyword" /></label>
          <button className="btn" disabled={!value.trim()} onClick={() => { setExtraFilters({ ...extraFilters, [filter]: value.trim() }); setValue(''); invalidatePlan(); }}>Add filter</button>
          <label>Page size <input type="number" min={1} max={25} value={limit} onChange={e => { setLimit(Number(e.target.value)); invalidatePlan(); }} /></label>
          <label>Maximum pages <input type="number" min={1} max={3} value={pages} onChange={e => { setPages(Number(e.target.value)); invalidatePlan(); }} /></label>
        </div>
        {Object.entries(extraFilters).map(([k,v]) => <button className="btn" key={k} onClick={() => { setExtraFilters(Object.fromEntries(Object.entries(extraFilters).filter(([key]) => key !== k))); invalidatePlan(); }}>{k}={v} ×</button>)}
        {!!s?.suggestedNaics.length && <p className="small">Company NAICS: {s.suggestedNaics.join(', ')}. Capabilities: {s.suggestedKeywords.join(', ')}.</p>}
        <button className="btn" onClick={() => preview.mutate()}>Preview Research Query</button>
      </fieldset>
      {preview.error && <ErrorBox error={preview.error} />}
      {plan && <div className="callout"><p><code>{plan.endpoint}</code> · filters: {JSON.stringify(plan.query.filters)} · maximum {plan.query.maxPages} page(s), {plan.maxRecords} records · estimated cost: up to {plan.estimatedRequests} request(s).</p><p>{plan.entitlement}</p>
        <button className="btn primary" disabled={busy || !s?.enabled || !s.configured} onClick={() => execute.mutate()}>Execute previewed query (up to {plan.estimatedRequests} requests)</button></div>}
      {execute.error && <ErrorBox error={execute.error} />}
      {result && <div className="stack" aria-live="polite"><div className="row"><strong>{result.source}: {result.records.length} results · {result.requests} requests · {showDate(result.observedAt)}</strong><button className="btn" onClick={() => { setResult(null); execute.reset(); }}>Clear transient results</button></div>
        {result.hasMore && <p>More results exist; the previewed page cap stopped retrieval.</p>}
        {!!result.warnings.length && <p className="callout warn">Provider field restrictions or upstream warnings: {JSON.stringify(result.warnings)}</p>}
        {result.records.map((r, i) => {
          const link = safeLink(r.data.url ?? r.data.registration_link ?? r.data.source_url);
          return <div key={i} className="callout"><strong>{asText(r.data.title ?? r.data.solicitation_title ?? r.data.legal_business_name ?? r.data.description) || 'Research result'}</strong><p className="small">Unverified source intelligence · {r.matches.coverage}</p>
            {link && <a href={link} target="_blank" rel="noreferrer">Open source</a>}
            {r.matches.opportunities.map(o => <p key={o.id}><Link to={`/opportunities/${o.id}`}>{o.title}</Link> · {o.evidence}</p>)}
            {r.matches.companies.map(co => <p key={co.id}>Related company: {co.name} (exact UEI)</p>)}
            <details><summary>View transient research fields</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(r.data, null, 2)}</pre></details>
          </div>;
        })}</div>}
      <details><summary>Independent research notes & OrangeSlices links</summary><div className="stack">
        <p>Save links and your independently authored notes. Do not copy Tango or G2X response content into these notes.</p>
        <label>Source link <input type="url" value={sourceUrl} onChange={e => setSourceUrl(e.target.value)} /></label>
        <label>Related opportunity UUID (optional) <input value={opportunityId} onChange={e => setOpportunityId(e.target.value)} /></label>
        <label>Your notes <textarea value={note} onChange={e => setNote(e.target.value)} maxLength={4000} /></label>
        <label><input type="checkbox" checked={authored} onChange={e => setAuthored(e.target.checked)} /> These notes are independently authored and contain no copied provider content.</label>
        <button className="btn" disabled={!authored || !sourceUrl || !note || save.isPending} onClick={() => save.mutate()}>Save research note</button>
        {save.error && <ErrorBox error={save.error} />}{notes.error && <ErrorBox error={notes.error} />}
        {(notes.data ?? []).map(n => <div key={n.id} className="callout"><a href={safeLink(n.source_url) ?? '#'} target="_blank" rel="noreferrer">{n.source_name}</a><p>{n.notes}</p><p>{n.verification_status} · {n.review_status}</p><button className="btn" disabled={review.isPending || n.review_status === 'reviewed'} onClick={() => review.mutate(n)}>Mark reviewed</button></div>)}
        {review.error && <ErrorBox error={review.error} />}
      </div></details>
    </div>
  </Card>;
}
