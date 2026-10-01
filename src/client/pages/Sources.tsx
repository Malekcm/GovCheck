import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, RotateCw, Stethoscope } from 'lucide-react';
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
        <div className="k">Scheduled sync</div>
        <div>{config?.schedulerEnabled ? <span className="badge good">In-process scheduler on</span> : <span className="badge neutral">Off (use “Refresh all sources” or the cron endpoint)</span>}</div>
        <div className="k">Cron endpoint secret</div>
        <div>{config?.cronSecret ? <span className="badge good">Configured</span> : <span className="badge neutral">Not set</span>}</div>
      </div>
      <div className="callout small">
        <strong>Adding the SAM.gov API key</strong>
        <ol className="list-plain">
          <li>Sign in at sam.gov → Profile → Account Details → request a <em>Public API Key</em> (free).</li>
          <li>Put it in the server environment as <code>SAM_API_KEY=...</code> (the <code>.env</code> file locally, or your host’s secret settings). Never put it in frontend code.</li>
          <li>Restart the server. Keys are never sent to the browser; this page only shows whether one is set.</li>
          <li>Non-federal personal keys are limited to <strong>10 requests/day</strong>. Set <code>SAM_DAILY_REQUEST_LIMIT</code> to 1000 if your account has a role or you use a system account key.</li>
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

export function SourcesPage() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ['sources'], queryFn: () => api.get<any>('/api/sources'), refetchInterval: (q) => (q.state.data?.status?.running ? 3000 : 30000) });
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<any>('/api/meta') });
  const [history, setHistory] = useState<any | null>(null);
  const [adding, setAdding] = useState(false);
  const [archiveFy, setArchiveFy] = useState(String(new Date().getFullYear() - 1));
  const invalidate = () => qc.invalidateQueries({ queryKey: ['sources'] });
  const run = useMutation({
    mutationFn: ({ id, mode, params }: { id: string; mode: string; params?: any }) => api.post(`/api/sources/${id}/sync`, { mode, params }),
    onSuccess: () => {
      toast('Sync started.');
      invalidate();
      qc.invalidateQueries({ queryKey: ['sync-status'] });
    },
    onError: (e: Error) => toast(e.message),
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

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Sources & sync</h1>
          <p>Source registry, health and sync history. Each connector runs in isolation — a broken source is marked Degraded/Error and never blocks the others. Raw records are stored verbatim and never deleted.</p>
        </div>
        <div className="row">
          <span className="small muted">
            SAM.gov requests today: <span className="num">{data.budget.sam.used}/{data.budget.sam.limit}</span>
          </span>
          <button className="btn" onClick={() => setAdding(true)}>
            + Add public feed
          </button>
          <button className="btn" disabled={running} onClick={() => api.post('/api/sync/all', { mode: 'reconcile' }).then(() => (toast('Reconciliation started (bulk files and full listings).'), invalidate())).catch((e) => toast(e.message))}>
            <RotateCw size={14} /> Reconcile all
          </button>
        </div>
      </div>
      {running && <div className="callout" style={{ marginBottom: 12 }}><span className="spinner" /> {data.status.label} — in progress.</div>}

      <Card title="Data sources" bodyClass="">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Last successful sync</th>
                <th>Last run</th>
                <th>Retrieved / new / updated / unchanged / failed</th>
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
                    {s.health_message && <div className="small muted" style={{ minWidth: 160, maxWidth: 260 }}>{s.health_message}</div>}
                  </td>
                  <td className="small nowrap">
                    {s.last_success_at ? relative(s.last_success_at) : 'Never'}
                    {s.supportsReconcile && <div className="muted">Reconciled: {s.last_reconciled_at ? relative(s.last_reconciled_at) : 'never'}</div>}
                  </td>
                  <td className="small">
                    {s.last_status ? <span className={`badge ${s.last_status === 'success' ? 'good' : s.last_status === 'failed' ? 'bad' : s.last_status === 'partial_success' ? 'warn' : 'neutral'}`}>{titleize(s.last_status)}</span> : '—'}
                    {s.last_duration_ms != null && <div className="muted num">{(s.last_duration_ms / 1000).toFixed(1)}s</div>}
                  </td>
                  <td className="num small">{s.last_status ? `${s.last_retrieved} / ${s.last_created} / ${s.last_updated} / ${s.last_unchanged} / ${s.last_failed}` : '—'}</td>
                  <td className="num small">{Number(s.stored_records).toLocaleString()}</td>
                  <td className="small nowrap">
                    {s.schedule_minutes ? `every ${s.schedule_minutes >= 1440 ? `${s.schedule_minutes / 1440}d` : `${s.schedule_minutes / 60}h`}` : 'manual'}
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
                      <button className="btn sm" disabled={running || !s.enabled || !s.configured} onClick={() => run.mutate({ id: s.id, mode: 'incremental' })}>
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
            <p className="small muted">Imports an archived SAM Contract Opportunities file for one fiscal year, filtered to your NAICS industry groups. Large files may take a long time; records already stored are skipped by hash.</p>
            <div className="row">
              <input type="number" min={1998} max={2030} value={archiveFy} onChange={(e) => setArchiveFy(e.target.value)} style={{ width: 100 }} />
              <button className="btn" disabled={running} onClick={() => run.mutate({ id: 'sam_bulk', mode: 'reconcile', params: { fiscalYear: Number(archiveFy) } })}>
                Import FY{archiveFy}
              </button>
            </div>
          </Card>
        </div>
      </div>
      {history && <RunHistory connector={history} onClose={() => setHistory(null)} />}
      {adding && <AddFeed onClose={() => setAdding(false)} />}
    </div>
  );
}
