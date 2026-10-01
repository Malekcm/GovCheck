import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { COVERAGE_SIGNAL_LABELS } from '../../shared/domain';
import { api } from '../api';
import { money, moneyRange, relative } from '../format';
import { Card, Empty, ErrorBox, Loading, Prov, Score } from '../components/ui';

export function CoveragePage() {
  const qc = useQueryClient();
  const [type, setType] = useState<string | null>(null);
  const [status, setStatus] = useState('open');
  const q = useQuery({ queryKey: ['coverage', type, status], queryFn: () => api.get<any>(`/api/coverage?status=${status}${type ? `&type=${type}` : ''}`) });
  const dismiss = useMutation({ mutationFn: ({ id, s }: { id: string; s: string }) => api.put(`/api/coverage/${id}`, { status: s }), onSuccess: () => qc.invalidateQueries({ queryKey: ['coverage'] }) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const counts: Record<string, number> = {};
  for (const c of q.data.counts) if (c.status === 'open') counts[c.signal_type] = c.n;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Coverage gaps</h1>
          <p>What you would miss relying on one source — and data gaps that need attention. Recompete signals are intelligence, not active solicitations.</p>
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option>
          <option value="dismissed">Dismissed</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>
      <div className="kpis">
        {Object.entries(COVERAGE_SIGNAL_LABELS).map(([k, v]) => (
          <button key={k} className={`kpi tip ${type === k ? 'accent' : ''}`} style={{ textAlign: 'left', cursor: 'pointer' }} data-tip={v.description} onClick={() => setType(type === k ? null : k)}>
            <div className="label">{v.label}</div>
            <div className="value">{counts[k] ?? 0}</div>
          </button>
        ))}
      </div>
      <Card title={type ? COVERAGE_SIGNAL_LABELS[type]?.label : 'All signals'} bodyClass="">
        {q.data.signals.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Signal</th>
                <th>Detail</th>
                <th>Fit</th>
                <th>Value</th>
                <th>Agency</th>
                <th>Last detected</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {q.data.signals.map((s: any) => (
                <tr key={s.id}>
                  <td>
                    <span className={`badge ${s.signal_type === 'POSSIBLE_RECOMPETE' ? 'signal' : s.severity === 'notice' ? 'warn' : 'neutral'}`}>{COVERAGE_SIGNAL_LABELS[s.signal_type]?.label ?? s.signal_type}</span>
                  </td>
                  <td>
                    {s.opportunity_id ? <Link to={`/opportunities/${s.opportunity_id}`}>{s.title}</Link> : s.title}
                    {s.detail?.other && (
                      <div className="small">
                        <Link to={`/opportunities/${s.detail.other}`}>Compare →</Link> · <Link to="/merge">Merge review</Link>
                      </div>
                    )}
                    {s.piid && <div className="small muted">Award {s.piid} · {s.awardee_name} · {money(s.total_obligated)}</div>}
                  </td>
                  <td>
                    <Score value={s.fit_score} />
                  </td>
                  <td className="num small nowrap">
                    {moneyRange(s.value_low, s.value_high)} {s.value_provenance && <Prov p={s.value_provenance} />}
                  </td>
                  <td className="small">{s.subtier_name ?? s.department_name}</td>
                  <td className="small muted nowrap">{relative(s.last_detected_at)}</td>
                  <td>
                    {status === 'open' ? (
                      <button className="btn ghost sm" onClick={() => dismiss.mutate({ id: s.id, s: 'dismissed' })}>
                        Dismiss
                      </button>
                    ) : status === 'dismissed' ? (
                      <button className="btn ghost sm" onClick={() => dismiss.mutate({ id: s.id, s: 'open' })}>
                        Reopen
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No signals">Coverage analysis runs after every sync.</Empty>
        )}
      </Card>
    </div>
  );
}
