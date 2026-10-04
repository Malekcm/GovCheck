import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Database, Play, RefreshCw, RotateCw, Stethoscope } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { date, relative, titleize } from '../format';
import { Card, ErrorBox, Loading, Modal, toast } from '../components/ui';

const HEALTH_LABEL: Record<string, string> = { healthy: 'Connected', degraded: 'Degraded', error: 'Error', not_configured: 'Not configured', disabled: 'Disabled', unknown: 'Not yet run' };

export function SetupInstructions({ config }: { config?: any }) {
  return (
    <div className="stack">
      <div className="kv">
        <div className="k">Database</div>
        <div>{config?.database ?? '…'}</div>
        <div className="k">SAM.gov API key</div>
        <div>{config?.samApiKey ? <span className="badge good">Configured (server-side)</span> : <span className="badge warn">Not configured</span>} {config && <span className="small muted">· {config.samRequestsUsedToday}/{config.samDailyRequestLimit} requests used today</span>}</div>
        <div className="k">Anthropic (AI)</div>
        <div>{config?.anthropicApiKey ? <span className="badge good">Configured · {config.anthropicModel}</span> : <span className="badge neutral">Optional — not configured</span>}</div>
        <div className="k">Database connection</div>
        <div>{config?.databaseTls ?? '—'}</div>
        <div className="k">In-process scheduler</div>
        <div>{config?.schedulerEnabled ? <span className="badge good">On (this server checks due sources every 5 minutes)</span> : <span className="badge neutral">Off — scheduled checks run from GitHub Actions or the cron endpoint</span>}</div>
        <div className="k">SAM bulk ingestion</div>
        <div>{config?.samBulkIngestMode === 'full' ? <span className="badge warn">Full (every notice in the window)</span> : <span className="badge good">Focused (relevant or already tracked notices only)</span>}</div>
        <div className="k">Cron endpoint secret</div>
        <div>{config?.cronSecret ? <span className="badge good">Configured</span> : <span className="badge neutral">Not set</span>}</div>
      </div>
      <div className="callout small">
        <strong>Adding the SAM.gov API key</strong>
        <ol className="list-plain">
          <li>Sign in at sam.gov → Profile → Account Details → request a <em>Public API Key</em> (free).</li>
          <li>Put it in the server environment as <code>SAM_API_KEY=...</code> (the <code>.env</code> file locally, or your host’s secret settings). Never put it in frontend code.</li>
          <li>Restart the server. Keys are never sent to the browser; this page only shows whether one is set.</li>
          <li>Non-federal personal keys are limited to <strong>10 requests/day</strong>. Set <code>SAM_DAILY_REQUEST_LIMIT</code> to 1000 if your account has a role or you use a system account key. <code>SAM_MANUAL_RESERVE_REQUESTS</code> keeps some for manual refreshes and targeted searches.</li>
        </ol>
        <strong>Optional AI</strong>: set <code>ANTHROPIC_API_KEY</code> to enable Claude requirement extraction and summaries (results cached by content hash).
      </div>
    </div>
  );
}

function RunHistory({ connector, onClose }: { connector: any; onClose: () => void }) {
  const runs = useQuery({ queryKey: ['runs', connector.id], queryFn: () => api.get<any[]>(`/api/sync/runs?connector=${encodeURIComponent(connector.id)}`) });
  const [runId, setRunId] = useState<string | null>(null);
  const detail = useQuery({ queryKey: ['run', runId], queryFn: () => api.get<any>(`/api/sync/runs/${runId}`), enabled: !!runId });
  return (
    <Modal title={`${connector.name} — sync history`} onClose={onClose}>
      {runs.isLoading ? (
        <Loading />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Started</th>
              <th>Mode</th>
              <th>Status</th>
              <th>Retrieved / new / updated / unchanged / failed</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {(runs.data ?? []).map((r) => (
              <tr key={r.id} className="clickable" onClick={() => setRunId(r.id)}>
                <td className="small nowrap">{date(r.started_at, true)}</td>
                <td>{r.mode}</td>
                <td>
                  <span className={`badge ${r.status === 'success' ? 'good' : r.status === 'failed' ? 'bad' : r.status === 'partial_success' ? 'warn' : 'neutral'}`}>{titleize(r.status)}</span>
                  {r.error_count > 0 && <span className="badge bad">{r.error_count} errors</span>}
                </td>
                <td className="num small">
                  {r.records_retrieved} / {r.records_created} / {r.records_updated} / {r.records_unchanged} / {r.records_failed}
                </td>
                <td className="num small">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {detail.data && (
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="callout small">{detail.data.run.message}</div>
          {detail.data.errors.map((e: any) => (
            <div key={e.id} className="callout bad small">
              <strong>{e.step}</strong> {e.record_ref && <span className="mono">{e.record_ref}</span>} — {e.message} <span className="muted">({date(e.created_at, true)}{e.retryable ? ', will retry next run' : ''})</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function AddFeed({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState<any>({ name: '', url: '', format: 'rss', opportunityClass: 'prime', jurisdiction: '', jurisdictionLevel: 'state', itemsPath: '', fields: {} });
  const add = useMutation({
    mutationFn: () => api.post('/api/sources', { ...v, itemsPath: v.itemsPath || undefined, jurisdiction: v.jurisdiction || undefined, fields: Object.fromEntries(Object.entries(v.fields).filter(([, x]) => x)) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sources'] });
      toast('Source added. Use “Test” to validate it.');
      onClose();
    },
    onError: (e: Error) => toast(e.message),
  });
  return (
    <Modal
      title="Add a public procurement feed"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!v.name || !v.url} onClick={() => add.mutate()}>
          Add source
        </button>
      }
    >
      <p className="small muted">For official public feeds only: agency forecasts, OSDBU pages, state/county/municipal portals, transit authorities, universities. robots.txt is honoured; authenticated or CAPTCHA-protected portals are not supported.</p>
      <div className="form-grid">
        <label className="field">
          Name
          <input type="text" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </label>
        <label className="field">
          Feed URL
          <input type="url" value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} />
        </label>
        <label className="field">
          Format
          <select value={v.format} onChange={(e) => setV({ ...v, format: e.target.value })}>
            <option value="rss">RSS</option>
            <option value="atom">Atom</option>
            <option value="json">JSON</option>
            <option value="csv">CSV</option>
          </select>
        </label>
        <label className="field">
          Class
          <select value={v.opportunityClass} onChange={(e) => setV({ ...v, opportunityClass: e.target.value })}>
            <option value="prime">Prime contract</option>
            <option value="subcontract">Subcontract</option>
            <option value="grant">Grant</option>
          </select>
        </label>
        <label className="field">
          Jurisdiction
          <input type="text" placeholder="e.g. Commonwealth of Virginia" value={v.jurisdiction} onChange={(e) => setV({ ...v, jurisdiction: e.target.value })} />
        </label>
        <label className="field">
          Level
          <select value={v.jurisdictionLevel} onChange={(e) => setV({ ...v, jurisdictionLevel: e.target.value })}>
            {['federal', 'state', 'county', 'municipal', 'authority', 'university', 'other'].map((x) => (
              <option key={x} value={x}>
                {titleize(x)}
              </option>
            ))}
          </select>
        </label>
        {(v.format === 'json' || v.format === 'csv') && (
          <>
            {v.format === 'json' && (
              <label className="field">
                Items path (JSON)
                <input type="text" placeholder="e.g. data.results" value={v.itemsPath} onChange={(e) => setV({ ...v, itemsPath: e.target.value })} />
              </label>
            )}
            {['id', 'title', 'description', 'url', 'deadline', 'posted', 'agency', 'naics', 'value', 'solicitationNumber', 'setAside'].map((k) => (
              <label key={k} className="field">
                Field for {k}
                <input type="text" value={v.fields[k] ?? ''} onChange={(e) => setV({ ...v, fields: { ...v.fields, [k]: e.target.value } })} />
              </label>
            ))}
          </>
        )}
      </div>
    </Modal>
  );
}

const CATEGORY_ORDER = ['tracked', 'active_changes', 'stale_high_fit', 'new_match', 'targeted_search', 'manual_refresh', 'discovery', 'awards', 'documents', 'test', 'other', 'unattributed'];

function SamBudgetCard() {
  const q = useQuery({ queryKey: ['sam-budget'], queryFn: () => api.get<any>('/api/sam/budget'), refetchInterval: 60_000 });
  if (q.isLoading) return <Card title="SAM.gov API budget"><Loading /></Card>;
  if (q.error) return <Card title="SAM.gov API budget"><ErrorBox error={q.error} /></Card>;
  const { status, plan } = q.data;
  const pctUsed = status.limit ? Math.round((status.used / status.limit) * 100) : 0;
  const cats = [...status.byCategory].sort((a: any, b: any) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  return (
    <Card title="SAM.gov API budget (today)">
      <div className="kv">
        <div className="k">Daily limit</div>
        <div className="num">{status.limit}</div>
        <div className="k">Used today</div>
        <div>
          <span className="num">{status.used}</span> <span className="small muted">({pctUsed}%)</span>
          <div className="scorebar" style={{ marginTop: 4 }}>
            <span style={{ width: `${Math.min(100, pctUsed)}%` }} />
          </div>
        </div>
        <div className="k">Remaining</div>
        <div>
          <span className="num">{status.remaining}</span> <span className="small muted">· {status.reserve} reserved for manual refreshes & targeted searches · {status.backgroundAvailable} available to scheduled checks</span>
        </div>
        <div className="k">Resets</div>
        <div className="small">
          {relative(status.resetsAt)} <span className="muted">(GovCheck counts per UTC day, 00:00 UTC)</span>
        </div>
      </div>
      <h3 style={{ marginTop: 12 }}>What used today’s requests</h3>
      {cats.length ? (
        <ul className="list-plain small">
          {cats.map((c: any) => (
            <li key={c.category} className="spread">
              <span>{c.label}</span>
              <span className="num">{c.requests}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="small muted">No SAM.gov requests yet today.</div>
      )}
      <h3 style={{ marginTop: 12 }}>Next scheduled checks, in priority order</h3>
      <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
        {plan.tiers.map((t: any) => (
          <li key={t.category}>
            {t.label}: <span className="num">{t.candidates.length}</span> waiting
            {t.candidates.slice(0, 3).map((c: any) => (
              <div key={c.opportunityId} className="muted truncate" style={{ maxWidth: 420 }}>
                · <Link to={`/opportunities/${c.opportunityId}`}>{c.title}</Link>
              </div>
            ))}
          </li>
        ))}
        <li>General discovery (new-notices feed): only with what is left.</li>
      </ol>
      <p className="small muted" style={{ marginTop: 8 }}>
        Today’s remaining scheduled allowance covers about {plan.willRunToday} live check(s). Broad discovery comes from the free SAM bulk file, USAspending, forecasts, SUBNet and Grants.gov — those never use this budget. SAM attachments are downloaded only when SAM_DOWNLOAD_DOCUMENTS=true.
      </p>
    </Card>
  );
}

function StorageCard() {
  const q = useQuery({ queryKey: ['storage'], queryFn: () => api.get<any>('/api/admin/storage'), refetchInterval: 5 * 60_000 });
  if (q.isLoading) return <Card title="Database & storage"><Loading /></Card>;
  if (q.error) return <Card title="Database & storage"><ErrorBox error={q.error} /></Card>;
  const d = q.data;
  const tone = d.level === 'critical' ? 'bad' : d.level === 'warning' ? 'warn' : 'good';
  const recent = d.versionGrowth.slice(-7);
  return (
    <Card title={<span className="row"><Database size={14} /> Database & storage</span>}>
      <div className="kv">
        <div className="k">Database size</div>
        <div>
          {d.sizeMb != null ? (
            <>
              <span className={`badge ${tone}`}>{d.sizeMb} MB</span> <span className="small muted">of {d.limitMb} MB plan ({d.usagePct}%) · warning at {d.warnMb} MB</span>
            </>
          ) : (
            <span className="muted">Not available</span>
          )}
        </div>
        <div className="k">Opportunities</div>
        <div className="num">{d.counts.opportunities.toLocaleString()} <span className="small muted">({d.counts.opportunities_active.toLocaleString()} active/forecast)</span></div>
        <div className="k">Raw source records</div>
        <div className="num">{d.counts.source_records.toLocaleString()}</div>
        <div className="k">Source versions</div>
        <div className="num">
          {d.counts.source_record_versions.toLocaleString()} <span className="small muted">({d.avgVersionsPerRecord ?? '—'} per record · identical versions are never stored twice)</span>
        </div>
        <div className="k">Change events / snapshots</div>
        <div className="num">
          {d.counts.opportunity_events.toLocaleString()} / {d.counts.opportunity_snapshots.toLocaleString()}
        </div>
        <div className="k">Last 7 days</div>
        <div className="small">
          {recent.reduce((s: number, x: any) => s + x.versions, 0).toLocaleString()} new versions · {recent.reduce((s: number, x: any) => s + x.events, 0).toLocaleString()} change events ·{' '}
          {d.syncVolume.slice(-7).reduce((s: number, x: any) => s + x.retrieved, 0).toLocaleString()} records checked by syncs
          {d.projectedDaysToLimit != null && <> · ~{d.projectedDaysToLimit} days to the plan limit at this rate</>}
        </div>
      </div>
      {d.warnings.map((w: string) => (
        <div key={w} className={`callout ${d.level === 'critical' ? 'bad' : 'warn'} small`} style={{ marginTop: 8 }}>
          <AlertTriangle size={13} /> {w}
        </div>
      ))}
      {d.largestTables.length > 0 && (
        <details className="small" style={{ marginTop: 8 }}>
          <summary className="muted">Largest tables</summary>
          <ul className="list-plain">
            {d.largestTables.map((t: any) => (
              <li key={t.table} className="spread">
                <span className="mono">{t.table}</span>
                <span className="num">{(t.bytes / 1024 / 1024).toFixed(1)} MB</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="small muted" style={{ marginTop: 8 }}>GovCheck never deletes history automatically to save space.</p>
    </Card>
  );
}

function DiscoveryTermsCard() {
  const q = useQuery({ queryKey: ['discovery-terms'], queryFn: () => api.get<any>('/api/discovery/terms') });
  if (!q.data) return null;
  const d = q.data;
  const usable = d.terms.filter((t: any) => !t.generic);
  const generic = d.terms.filter((t: any) => t.generic);
  return (
    <Card title="Capability discovery terms" actions={<Link className="btn ghost sm" to="/company">Edit capabilities & keywords</Link>}>
      <p className="small muted">
        SAM.gov has no capability search, so GovCheck matches these terms (from your confirmed capabilities, their keywords and your company keywords) against titles and descriptions in the free bulk file and in search results.
        Bulk ingestion mode: <strong>{d.bulk.mode}</strong>. A notice is kept when its NAICS ({d.naics.join(', ') || 'none set'}, plus 4-digit industry groups{d.bulk.extraNaicsPrefixes.length ? ` and ${d.bulk.extraNaicsPrefixes.join(', ')}` : ''}) or PSC matches, when its title contains a term or its description contains two, or when GovCheck already tracks it.
      </p>
      <div className="chips">
        {usable.map((t: any) => (
          <span key={t.term} className="chip" title={`From: ${t.sources.join(', ')}`}>
            {t.term}
          </span>
        ))}
        {!usable.length && <span className="muted small">No terms yet — confirm capabilities on the Company page.</span>}
      </div>
      {generic.length > 0 && (
        <details className="small" style={{ marginTop: 6 }}>
          <summary className="muted">{generic.length} generic word(s) used for scoring only, not discovery</summary>
          {generic.map((t: any) => t.term).join(', ')}
        </details>
      )}
      {d.negativeKeywords.length > 0 && <div className="small muted" style={{ marginTop: 6 }}>Excluded when in the title: {d.negativeKeywords.join(', ')}</div>}
    </Card>
  );
}

function schedule(mins: number | null): string {
  if (!mins) return 'manual';
  return `every ${mins >= 1440 ? `${+(mins / 1440).toFixed(1)}d` : `${+(mins / 60).toFixed(1)}h`}`;
}

export function SourcesPage() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get<any>('/api/sources'), refetchInterval: (q) => (q.state.data?.status?.running ? 3000 : 30000) });
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<any>('/api/meta') });
  const [history, setHistory] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [advanced, setAdvanced] = useState<null | 'refresh' | 'reconcile'>(null);
  const [archiveFy, setArchiveFy] = useState(String(new Date().getFullYear() - 1));
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['sources'] });
    qc.invalidateQueries({ queryKey: ['sync-status'] });
    qc.invalidateQueries({ queryKey: ['sync-overview'] });
    qc.invalidateQueries({ queryKey: ['sam-budget'] });
  };
  const run = useMutation({
    mutationFn: ({ id, mode, params }: { id: string; mode: string; params?: any }) => api.post(`/api/sources/${id}/sync`, { mode, params }),
    onSuccess: () => {
      toast('Sync started.');
      invalidate();
    },
    onError: (e: Error) => toast(e.message),
  });
  const due = useMutation({
    mutationFn: () => api.post<any>('/api/sync/due'),
    onSuccess: (r) => {
      toast(r.started ? `Checking due sources: ${[...r.work.incremental, ...r.work.reconcile.map((x: string) => `${x} (reconcile)`)].join(', ')}` : r.message);
      invalidate();
    },
    onError: (e: Error) => toast(e.message),
  });
  const heavy = useMutation({
    mutationFn: (mode: 'incremental' | 'reconcile') => api.post('/api/sync/all', { mode }),
    onSuccess: () => {
      toast('Started. You can keep working; progress shows at the top of the page.');
      setAdvanced(null);
      invalidate();
    },
    onError: (e: Error) => (toast(e.message), setAdvanced(null)),
  });
  const test = useMutation({ mutationFn: (id: string) => api.post<any>(`/api/sources/${id}/test`), onSuccess: (r) => (toast(`${HEALTH_LABEL[r.status] ?? r.status}: ${r.message}`), invalidate()), onError: (e: Error) => toast(e.message) });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: any }) => api.put(`/api/sources/${id}`, body), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: (id: string) => api.del<any>(`/api/sources/${id}`), onSuccess: (r) => (toast(r.message ?? 'Removed.'), invalidate()) });

  if (sources.isLoading) return <Loading />;
  if (sources.error) return <ErrorBox error={sources.error} />;
  const data = sources.data;
  const connectors = data.sources.filter((s: any) => s.source_type !== 'engine');
  const engines = data.sources.filter((s: any) => s.source_type === 'engine');
  const running = data.status.running;
  const ov = data.overview;
  const sam = data.budget.sam;
  const lastSched = ov.lastSchedulerRun;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sources & sync</h1>
          <p>GovCheck keeps accumulated intelligence in its database. Sources are checked on a schedule and only new or changed records are processed. Each connector runs in isolation — a broken source is marked Degraded/Error and never blocks the others. Raw records are stored verbatim and never deleted.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setAdding(true)}>
            + Add public feed
          </button>
          <button className="btn primary" disabled={running || due.isPending} onClick={() => due.mutate()} title="Runs only the sources whose schedule says they are due">
            <RefreshCw size={14} /> Check due sources now
          </button>
        </div>
      </div>

      <div className="kpis" style={{ marginBottom: 12 }}>
        <div className="kpi">
          <div className="label">Data current as of</div>
          <div className="value" style={{ fontSize: 18 }}>{ov.dataCurrentAsOf ? relative(ov.dataCurrentAsOf) : 'Never synced'}</div>
          <div className="sub">{ov.dataCurrentAsOf ? date(ov.dataCurrentAsOf, true) : ''}</div>
        </div>
        <div className="kpi">
          <div className="label">
            <CalendarClock size={12} /> Next scheduled check
          </div>
          <div className="value">{ov.nextScheduledCheck === 'now' ? 'Due now' : ov.nextScheduledCheck ? relative(ov.nextScheduledCheck) : '—'}</div>
          <div className="sub">{ov.dueNow.length ? `Due: ${ov.dueNow.join(', ')}` : ov.onboardingComplete ? 'All sources within schedule' : 'Starts after setup is complete'}</div>
        </div>
        <div className="kpi">
          <div className="label">Scheduler</div>
          <div className="value" style={{ fontSize: 14, fontFamily: 'inherit', fontWeight: 600 }}>{ov.inProcessScheduler ? 'This server (every 5 min)' : 'External (GitHub Actions)'}</div>
          <div className="sub">{lastSched ? `Last check ${relative(lastSched.at)} by ${lastSched.triggeredBy}${lastSched.ran?.length ? ` · ran ${lastSched.ran.join(', ')}` : ' · nothing was due'}` : 'No scheduled check recorded yet'}</div>
        </div>
        <div className={`kpi ${sam.remaining <= sam.reserve ? 'warn' : ''}`}>
          <div className="label">SAM.gov requests today</div>
          <div className="value">
            {sam.used} / {sam.limit}
          </div>
          <div className="sub">
            {sam.remaining} left · resets {relative(sam.resetsAt)}
          </div>
        </div>
      </div>
      {running && (
        <div className="callout" style={{ marginBottom: 12 }}>
          <span className="spinner" /> {data.status.label} — in progress{data.status.elsewhere ? ' (another GovCheck process is doing this work)' : ''}.
        </div>
      )}

      <Card title="Data sources" bodyClass="">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Last attempted / successful</th>
                <th>Last run</th>
                <th>Retrieved / new / changed / unchanged / failed</th>
                <th>Stored</th>
                <th>Schedule</th>
                <th>Enabled</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {connectors.map((s: any) => (
                <tr key={s.id}>
                  <td style={{ minWidth: 300, maxWidth: 400 }}>
                    <strong>{s.name}</strong> <span className="badge outline">{s.access_method}</span>
                    {s.auth_required && <span className="badge outline">key</span>}
                    <div className="small muted">{s.description}</div>
                    {s.notes && (
                      <details className="small">
                        <summary className="muted">Notes & limitations</summary>
                        {s.notes}
                      </details>
                    )}
                  </td>
                  <td>
                    <span className="row nowrap">
                      <span className={`health-dot ${s.health}`} /> {HEALTH_LABEL[s.health] ?? s.health}
                    </span>
                    {!s.configured && <div className="small"><span className="badge warn">Not configured</span></div>}
                    {s.health_message && <div className="small muted" style={{ minWidth: 160, maxWidth: 260 }}>{s.health_message}</div>}
                  </td>
                  <td className="small nowrap">
                    <div>Tried: {s.last_attempted_at ? relative(s.last_attempted_at) : 'never'}</div>
                    <div>OK: {s.last_success_at ? relative(s.last_success_at) : 'never'}</div>
                    {s.supportsReconcile && <div className="muted">Reconciled: {s.last_reconciled_at ? relative(s.last_reconciled_at) : 'never'}</div>}
                  </td>
                  <td className="small">
                    {s.last_status ? <span className={`badge ${s.last_status === 'success' ? 'good' : s.last_status === 'failed' ? 'bad' : s.last_status === 'partial_success' ? 'warn' : 'neutral'}`}>{titleize(s.last_status)}</span> : '—'}
                    {s.last_mode && s.last_status && <div className="muted">{s.last_mode}</div>}
                    {s.last_duration_ms != null && <div className="muted num">{(s.last_duration_ms / 1000).toFixed(1)}s</div>}
                  </td>
                  <td className="num small">{s.last_status ? `${s.last_retrieved} / ${s.last_created} / ${s.last_updated} / ${s.last_unchanged} / ${s.last_failed}` : '—'}</td>
                  <td className="num small">{Number(s.stored_records).toLocaleString()}</td>
                  <td className="small nowrap">
                    {schedule(s.schedule_minutes)}
                    {s.supportsReconcile && s.reconcileScheduleMinutes && <div className="muted">reconcile {schedule(s.config?.reconcileEveryMinutes ?? s.reconcileScheduleMinutes)}</div>}
                    {s.next_run_at && <div className="muted">next {relative(s.next_run_at)}</div>}
                  </td>
                  <td>
                    <input type="checkbox" checked={s.enabled} onChange={(e) => update.mutate({ id: s.id, body: { enabled: e.target.checked } })} aria-label={`Enable ${s.name}`} />
                  </td>
                  <td className="nowrap">
                    <button className="btn ghost sm" title="Test connection" onClick={() => test.mutate(s.id)}>
                      <Stethoscope size={13} />
                    </button>
                    {s.id !== 'sam_bulk' && (
                      <button className="btn sm" disabled={running || !s.enabled || !s.configured} onClick={() => run.mutate({ id: s.id, mode: 'incremental' })} title={s.auth_required ? 'Uses SAM.gov API requests' : 'Incremental: new and changed records only'}>
                        <Play size={12} /> Sync
                      </button>
                    )}
                    {s.supportsReconcile && (
                      <button className="btn sm" disabled={running || !s.enabled} onClick={() => run.mutate({ id: s.id, mode: 'reconcile' })}>
                        Reconcile
                      </button>
                    )}
                    <button className="btn ghost sm" onClick={() => setHistory(s)}>
                      History
                    </button>
                    {s.is_custom && (
                      <button className="btn ghost sm danger" onClick={() => remove.mutate(s.id)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-2" style={{ marginTop: 12 }}>
        <SamBudgetCard />
        <StorageCard />
      </div>

      <div style={{ marginTop: 12 }}>
        <DiscoveryTermsCard />
      </div>

      <div className="grid grid-2" style={{ marginTop: 12 }}>
        <Card title="Intelligence engines">
          {engines.map((s: any) => (
            <div key={s.id} className="spread" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
              <div>
                <span className="row">
                  <span className={`health-dot ${s.health}`} /> <strong>{s.name}</strong>
                </span>
                <div className="small muted">{s.health_message ?? s.notes}</div>
              </div>
              <div className="row nowrap">
                <span className="small muted">{s.last_success_at ? relative(s.last_success_at) : 'not run'}</span>
                <button className="btn ghost sm" onClick={() => setHistory(s)}>
                  History
                </button>
              </div>
            </div>
          ))}
        </Card>
        <div>
          <Card title="Configuration & API keys">
            <SetupInstructions config={meta.data?.configuration} />
          </Card>
          <Card title="Historical import (SAM archived fiscal years)">
            <p className="small muted">Imports an archived SAM Contract Opportunities file for one fiscal year, filtered to your profile (NAICS industry groups, PSC, capability terms) and anything already tracked. Free, but large files take a long time; records already stored are skipped by hash.</p>
            <div className="row">
              <input type="number" min={1998} max={2030} value={archiveFy} onChange={(e) => setArchiveFy(e.target.value)} style={{ width: 100 }} />
              <button className="btn" disabled={running} onClick={() => run.mutate({ id: 'sam_bulk', mode: 'reconcile', params: { fiscalYear: Number(archiveFy) } })}>
                Import FY{archiveFy}
              </button>
            </div>
          </Card>
          <Card title="Advanced (administrators)">
            <p className="small muted">Normally not needed: due sources are checked automatically. These run every enabled source regardless of its schedule.</p>
            <div className="row">
              <button className="btn" disabled={running} onClick={() => setAdvanced('refresh')}>
                <RefreshCw size={14} /> Refresh all sources
              </button>
              <button className="btn" disabled={running} onClick={() => setAdvanced('reconcile')}>
                <RotateCw size={14} /> Full reconciliation
              </button>
            </div>
          </Card>
        </div>
      </div>
      {history && <RunHistory connector={history} onClose={() => setHistory(null)} />}
      {adding && <AddFeed onClose={() => setAdding(false)} />}
      {advanced && (
        <Modal
          title={advanced === 'refresh' ? 'Refresh all sources now?' : 'Run a full reconciliation?'}
          onClose={() => setAdvanced(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setAdvanced(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={heavy.isPending} onClick={() => heavy.mutate(advanced === 'refresh' ? 'incremental' : 'reconcile')}>
                Start
              </button>
            </>
          }
        >
          <div className="callout warn small">
            <AlertTriangle size={13} />{' '}
            {advanced === 'refresh'
              ? 'This runs every enabled source immediately, ignoring schedules. It can use SAM.gov API requests that would otherwise go to watched opportunities, and it takes a while.'
              : 'This re-reads bulk files and full listings for every source (the SAM bulk file is ~220 MB). It is heavy, can take a long time, and adds load to the database. Use it after an outage or a configuration change.'}
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            SAM.gov requests left today: {sam.remaining} of {sam.limit}. Unchanged records are still skipped by content hash.
          </p>
        </Modal>
      )}
    </div>
  );
}
