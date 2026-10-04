import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Radio, Search } from 'lucide-react';
import { api } from '../api';
import { date, relative } from '../format';
import { Card, DecisionBadge, Deadline, Empty, ErrorBox, ListInput, Loading, Modal, Score, StageBadge, toast } from '../components/ui';

interface Filters {
  naics: string[];
  titlePhrase: string;
  keywords: string[];
  psc: string;
  organization: string;
  setAside: string[];
  states: string[];
  noticeTypes: string[];
  solicitationNumber: string;
  noticeId: string;
  postedFrom: string;
  postedTo: string;
  deadlineFrom: string;
  deadlineTo: string;
}

const EMPTY: Filters = {
  naics: [],
  titlePhrase: '',
  keywords: [],
  psc: '',
  organization: '',
  setAside: [],
  states: [],
  noticeTypes: [],
  solicitationNumber: '',
  noticeId: '',
  postedFrom: '',
  postedTo: '',
  deadlineFrom: '',
  deadlineTo: '',
};

/** Drop empty values so the server receives only what the user actually set. */
function clean(f: Filters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) ? v.length : typeof v === 'string' ? v.trim() : v) out[k] = Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

function ResultsTable({ rows }: { rows: any[] }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Opportunity</th>
            <th>Fit</th>
            <th>Stage</th>
            <th>Agency</th>
            <th>NAICS</th>
            <th>Set-aside</th>
            <th>Deadline</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td style={{ minWidth: 260 }}>
                <Link to={`/opportunities/${o.id}`}>{o.title}</Link>
                {o.is_new && <span className="badge good" style={{ marginLeft: 6 }}>New</span>}
                <div className="small muted mono">{o.solicitation_number ?? ''}</div>
              </td>
              <td>
                <Score value={o.fit_score} />
              </td>
              <td>
                <StageBadge stage={o.stage} isSignal={o.is_signal} />
              </td>
              <td className="small">{o.department_name ?? '—'}</td>
              <td className="small mono">{o.naics_code ?? '—'}</td>
              <td className="small">{o.set_aside_code ?? '—'}</td>
              <td className="small nowrap">
                <Deadline value={o.response_deadline} />
              </td>
              <td>
                <DecisionBadge decision={o.decision} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TargetedSearchPage() {
  const qc = useQueryClient();
  const options = useQuery({ queryKey: ['ts-options'], queryFn: () => api.get<any>('/api/targeted-search/options') });
  const company = useQuery({ queryKey: ['company'], queryFn: () => api.get<any>('/api/company') });
  const history = useQuery({ queryKey: ['ts-history'], queryFn: () => api.get<any[]>('/api/targeted-search/history') });
  const [f, setF] = useState<Filters>(EMPTY);
  const [maxRequests, setMaxRequests] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [liveResult, setLiveResult] = useState<any | null>(null);
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => setF((p) => ({ ...p, [k]: v }));
  const toggle = (k: 'setAside' | 'noticeTypes', code: string) => setF((p) => ({ ...p, [k]: p[k].includes(code) ? p[k].filter((x) => x !== code) : [...p[k], code] }));
  const max = maxRequests ?? options.data?.defaultMaxRequests ?? 3;

  // Searching GovCheck is free. It runs only when the form is submitted, never while typing.
  const preview = useMutation({ mutationFn: () => api.post<any>('/api/targeted-search/preview', { filters: clean(f), maxRequests: max }), onError: (e: Error) => toast(e.message) });
  // The ONLY call that spends SAM requests: invoked from the confirmation dialog's button.
  const live = useMutation({
    mutationFn: () => api.post<any>('/api/targeted-search/live', { filters: clean(f), maxRequests: max, confirm: true }),
    onSuccess: (r) => {
      setLiveResult(r);
      setConfirming(false);
      toast(`Live search: ${r.kept} result(s), ${r.newRecords} new — ${r.requestsUsed} SAM request(s) used.`);
      qc.invalidateQueries({ queryKey: ['ts-history'] });
      qc.invalidateQueries({ queryKey: ['sources'] });
      preview.mutate();
    },
    onError: (e: Error) => {
      setConfirming(false);
      toast(e.message);
    },
  });

  const plan = preview.data?.live;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Targeted search</h1>
          <p>Search GovCheck’s stored intelligence first — it’s free. If you need fresh results, run a live SAM.gov search: you will see exactly how many of today’s limited SAM requests it costs before anything is sent. Live results are saved with full history, like any other source.</p>
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setLiveResult(null);
          preview.mutate();
        }}
      >
        <Card
          title="Filters"
          actions={
            company.data?.naics?.length ? (
              <button type="button" className="btn ghost sm" onClick={() => set('naics', company.data.naics.map((n: any) => n.code))}>
                Use my NAICS codes
              </button>
            ) : null
          }
        >
          <div className="form-grid">
            <label className="field">
              NAICS codes <span className="muted small">(one SAM request each)</span>
              <ListInput value={f.naics} onChange={(v) => set('naics', v)} placeholder="e.g. 541511" />
            </label>
            <label className="field">
              Title phrase <span className="muted small">(sent to SAM)</span>
              <input type="text" value={f.titlePhrase} onChange={(e) => set('titlePhrase', e.target.value)} placeholder="e.g. data analytics" />
            </label>
            <label className="field">
              Keywords <span className="muted small">(filtered by GovCheck)</span>
              <ListInput value={f.keywords} onChange={(v) => set('keywords', v)} placeholder="e.g. Power BI" />
            </label>
            <label className="field">
              PSC / classification
              <input type="text" value={f.psc} onChange={(e) => set('psc', e.target.value)} placeholder="e.g. DA01" />
            </label>
            <label className="field">
              Agency / organization
              <input type="text" value={f.organization} onChange={(e) => set('organization', e.target.value)} placeholder="e.g. Homeland Security" />
            </label>
            <label className="field">
              Place of performance (states)
              <ListInput value={f.states} onChange={(v) => set('states', v.map((s) => s.toUpperCase().slice(0, 2)))} placeholder="e.g. VA" />
            </label>
            <label className="field">
              Posted from
              <input type="date" value={f.postedFrom} onChange={(e) => set('postedFrom', e.target.value)} />
            </label>
            <label className="field">
              Posted to
              <input type="date" value={f.postedTo} onChange={(e) => set('postedTo', e.target.value)} />
            </label>
            <label className="field">
              Response deadline from
              <input type="date" value={f.deadlineFrom} onChange={(e) => set('deadlineFrom', e.target.value)} />
            </label>
            <label className="field">
              Response deadline to
              <input type="date" value={f.deadlineTo} onChange={(e) => set('deadlineTo', e.target.value)} />
            </label>
            <label className="field">
              Solicitation number
              <input type="text" value={f.solicitationNumber} onChange={(e) => set('solicitationNumber', e.target.value)} />
            </label>
            <label className="field">
              SAM notice ID
              <input type="text" value={f.noticeId} onChange={(e) => set('noticeId', e.target.value)} />
            </label>
          </div>
          <div className="stack" style={{ marginTop: 10 }}>
            <div>
              <div className="small muted">Notice types</div>
              <div className="chips">
                {(options.data?.noticeTypes ?? []).map((t: any) => (
                  <span key={t.code} className={`chip ${f.noticeTypes.includes(t.code) ? 'on' : ''}`} onClick={() => toggle('noticeTypes', t.code)}>
                    {t.label}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <div className="small muted">Set-asides</div>
              <div className="chips">
                {(options.data?.setAsides ?? []).map((t: any) => (
                  <span key={t.code} className={`chip ${f.setAside.includes(t.code) ? 'on' : ''}`} onClick={() => toggle('setAside', t.code)} title={t.label}>
                    {t.code}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn primary" type="submit" disabled={preview.isPending}>
              <Search size={14} /> Search GovCheck
            </button>
            <button type="button" className="btn ghost" onClick={() => (setF(EMPTY), preview.reset(), setLiveResult(null))}>
              Clear
            </button>
            <span className="small muted">Searching GovCheck never uses SAM.gov requests.</span>
          </div>
        </Card>
      </form>

      {preview.isPending && <Loading label="Searching GovCheck…" />}
      {preview.error && <ErrorBox error={preview.error} />}
      {preview.data && (
        <>
          <Card
            title={`In GovCheck: ${preview.data.local.total.toLocaleString()} match${preview.data.local.total === 1 ? '' : 'es'}`}
            actions={
              <button className="btn" type="button" disabled={!plan?.configured || !!plan?.plan.blocked} onClick={() => setConfirming(true)} title={!plan?.configured ? 'SAM_API_KEY is not configured on the server' : plan?.plan.blocked ?? ''}>
                <Radio size={14} /> Search live SAM…
              </button>
            }
            bodyClass=""
          >
            {plan?.plan.blocked && <div className="callout warn small" style={{ margin: 12 }}>{plan.plan.blocked}</div>}
            {preview.data.local.results.length ? <ResultsTable rows={preview.data.local.results} /> : <Empty title="Nothing stored matches these filters">Try broader filters, or search live SAM.gov.</Empty>}
            {preview.data.local.total > preview.data.local.results.length && <div className="small muted" style={{ padding: 10 }}>Showing the best {preview.data.local.results.length} by fit.</div>}
          </Card>
        </>
      )}

      {liveResult && (
        <Card title={`Live SAM.gov results: ${liveResult.kept} kept · ${liveResult.newRecords} new · ${liveResult.changedRecords} changed`} bodyClass="">
          <div className="callout small" style={{ margin: 12 }}>
            {liveResult.message}
            {liveResult.truncated && <div>Not every page was retrieved — narrow the filters or raise the request limit to see more.</div>}
          </div>
          {liveResult.opportunities.length ? <ResultsTable rows={liveResult.opportunities} /> : <Empty title="SAM.gov returned nothing for these filters" />}
        </Card>
      )}

      <Card title="Recent targeted searches" bodyClass="">
        {history.data?.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Filters</th>
                <th>SAM requests</th>
                <th>Results kept</th>
                <th>New / changed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((h) => (
                <tr key={h.id}>
                  <td className="small nowrap" title={date(h.created_at, true)}>
                    {relative(h.created_at)}
                  </td>
                  <td className="small mono" style={{ maxWidth: 420 }}>
                    {Object.entries(h.filters)
                      .filter(([, v]) => (Array.isArray(v) ? v.length : v))
                      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('|') : v}`)
                      .join(' · ')}
                  </td>
                  <td className="num">{h.requests_used}</td>
                  <td className="num">{h.results_kept}</td>
                  <td className="num">
                    {h.records_new} / {h.records_changed}
                  </td>
                  <td>
                    <span className={`badge ${h.status === 'success' ? 'good' : h.status === 'failed' ? 'bad' : 'warn'}`}>{h.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="card-body muted small">No live searches yet.</div>
        )}
      </Card>

      {confirming && plan && (
        <Modal
          title="Search live SAM.gov?"
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={live.isPending || !plan.affordable} onClick={() => live.mutate()}>
                {live.isPending ? 'Searching…' : `Confirm — use up to ${plan.plan.estimatedRequests} SAM request${plan.plan.estimatedRequests === 1 ? '' : 's'}`}
              </button>
            </>
          }
        >
          <div className="kv">
            <div className="k">Estimated SAM requests</div>
            <div>
              <strong>{plan.plan.estimatedRequests}</strong> <span className="small muted">(this search may use at most {plan.plan.maxRequests})</span>
            </div>
            <div className="k">Remaining today</div>
            <div>
              {plan.budget.remaining} of {plan.budget.limit} <span className="small muted">· resets {relative(plan.budget.resetsAt)}</span>
            </div>
            <div className="k">Request limit for this search</div>
            <div>
              <input type="number" min={1} max={plan.budget.limit} value={max} onChange={(e) => setMaxRequests(Math.max(1, Number(e.target.value) || 1))} style={{ width: 80 }} />
              <span className="small muted"> Re-run “Search GovCheck” after changing it to refresh the estimate.</span>
            </div>
          </div>
          {!plan.affordable && <div className="callout bad small" style={{ marginTop: 10 }}>Not enough SAM requests left today for this search.</div>}
          {plan.plan.warnings.map((w: string) => (
            <div key={w} className="callout warn small" style={{ marginTop: 8 }}>
              {w}
            </div>
          ))}
          <h3 style={{ marginTop: 12 }}>Parameters sent to SAM.gov</h3>
          {plan.plan.calls.map((c: any, i: number) => (
            <div key={i} className="small mono" style={{ wordBreak: 'break-all' }}>
              {i + 1}. {Object.entries(c)
                .map(([k, v]) => `${k}=${v}`)
                .join('&')}
            </div>
          ))}
          <div className="small muted" style={{ marginTop: 6 }}>Your API key is added on the server and never shown in the browser.</div>
          {plan.plan.localFilters.length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>Applied by GovCheck to the results</h3>
              <ul className="list-plain small">
                {plan.plan.localFilters.map((l: string) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
