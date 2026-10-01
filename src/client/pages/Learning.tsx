import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { DECISION_LABELS, type Decision } from '../../shared/domain';
import { api } from '../api';
import { date, pct } from '../format';
import { Card, Empty, ErrorBox, Loading, toast } from '../components/ui';

function WeightList({ rows }: { rows: any[] }) {
  if (!rows.length) return <span className="muted small">None yet.</span>;
  const max = Math.max(...rows.map((r) => Math.abs(r.weight)), 0.001);
  return (
    <div className="bar-list">
      {rows.map((r) => (
        <div key={r.feature} className="bar-row small">
          <div>
            <span className="muted">{r.group}:</span> <span className="mono">{r.feature.split(':').slice(1).join(':')}</span> <span className="muted">({r.support} decisions)</span>
            <div className="bar" style={{ width: `${(Math.abs(r.weight) / max) * 100}%`, background: r.weight > 0 ? 'var(--good)' : 'var(--bad)' }} />
          </div>
          <div className="num right">{r.weight > 0 ? '+' : ''}{r.weight.toFixed(2)}</div>
        </div>
      ))}
    </div>
  );
}

export function LearningPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['preference-model'], queryFn: () => api.get<any>('/api/preferences/model'), refetchInterval: (x) => (x.state.data?.state?.running || x.state.data?.state?.pending ? 2000 : false) });
  const retrain = useMutation({ mutationFn: () => api.post('/api/preferences/retrain'), onSuccess: () => (toast('Retraining…'), setTimeout(() => qc.invalidateQueries({ queryKey: ['preference-model'] }), 1500)) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const m = d.active;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Preference learning</h1>
          <p>
            The base fit score objectively compares opportunities to your profile and never changes from feedback. The <strong>preference score</strong> blends base fit with a regularized logistic-regression model trained on your actual decisions and reasons. Influence grows slowly with evidence: 0–9 decisions ≈ base only, 10–24 small, 25–49 moderate, 50+ strong.
          </p>
        </div>
        <button className="btn" onClick={() => retrain.mutate()}>
          {(d.state.running || d.state.pending) && <span className="spinner" />} Retrain now
        </button>
      </div>
      {!m ? (
        <Card>
          <Empty title="No decisions yet">
            Mark opportunities <em>Pursue, Interested, Watch, Maybe, Pass</em> or <em>Not relevant</em> (with reasons) and the model starts learning. <Link to="/opportunities?queue=needs-review">Review opportunities →</Link>
          </Empty>
        </Card>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi accent">
              <div className="label">Model version</div>
              <div className="value">v{m.version}</div>
              <div className="sub">{date(m.created_at, true)} · {m.trigger}</div>
            </div>
            <div className="kpi">
              <div className="label">Training decisions</div>
              <div className="value">{m.sample_count}</div>
              <div className="sub">{d.decisionCounts.map((x: any) => `${DECISION_LABELS[x.decision as Decision]} ${x.n}`).join(' · ')}</div>
            </div>
            <div className="kpi">
              <div className="label">Stage</div>
              <div className="value" style={{ fontSize: 17 }}>{m.stage.replace('_', ' ')}</div>
              <div className="sub">Learned share of preference: {pct(m.blend_alpha)}</div>
            </div>
            <div className="kpi">
              <div className="label">Training accuracy</div>
              <div className="value">{m.metrics?.training ? pct(m.metrics.training.accuracy) : '—'}</div>
              <div className="sub">Base-fit-only baseline: {m.metrics?.baselineFitAccuracy != null ? pct(m.metrics.baselineFitAccuracy) : '—'}</div>
            </div>
            <div className="kpi">
              <div className="label">Cross-validated accuracy</div>
              <div className="value">{m.metrics?.crossValidatedAccuracy != null ? pct(m.metrics.crossValidatedAccuracy) : '—'}</div>
              <div className="sub">{m.metrics?.crossValidatedAccuracy != null ? '5-fold, honest estimate' : 'Available after 15 decisions'}</div>
            </div>
          </div>
          <div className="grid grid-2">
            <Card title="What you tend to pursue (positive weights)">
              <WeightList rows={d.positive} />
            </Card>
            <Card title="What you tend to pass on (negative weights)">
              <WeightList rows={d.negative} />
            </Card>
          </div>
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <Card title={`What changed since v${d.previous?.version ?? '—'}`}>
              {d.changes.length ? (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Feature</th>
                      <th>Before</th>
                      <th>After</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.changes.map((c: any) => (
                      <tr key={c.feature}>
                        <td className="small">
                          <span className="muted">{c.group}:</span> {c.feature.split(':').slice(1).join(':')}
                        </td>
                        <td className="num">{c.previous.toFixed(2)}</td>
                        <td className="num" style={{ color: c.delta > 0 ? 'var(--good)' : 'var(--bad)' }}>
                          {c.weight.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <span className="muted small">No meaningful weight changes.</span>
              )}
            </Card>
            <Card title="Biggest personalized re-rankings (preference − fit)">
              {d.topMovers.length ? (
                d.topMovers.map((x: any) => (
                  <div key={x.opportunity_id} className="spread small" style={{ padding: '3px 0' }}>
                    <Link to={`/opportunities/${x.opportunity_id}#score`} className="truncate" style={{ maxWidth: '75%' }}>
                      {x.title}
                    </Link>
                    <span className="num" style={{ color: x.lift > 0 ? 'var(--good)' : 'var(--bad)' }}>
                      {x.fit_score} → {x.preference_score}
                    </span>
                  </div>
                ))
              ) : (
                <span className="muted small">—</span>
              )}
            </Card>
          </div>
          <div className="grid grid-2" style={{ marginTop: 12 }}>
            <Card title="Reasons you gave">
              {d.reasonCounts.map((r: any) => (
                <div key={r.code} className="spread small">
                  <span>
                    <span className={`badge ${r.polarity === 'positive' ? 'good' : 'bad'}`}>{r.polarity === 'positive' ? '+' : '−'}</span> {r.label}
                  </span>
                  <span className="num">{r.n}</span>
                </div>
              ))}
            </Card>
            <Card title="Model history" bodyClass="">
              <table className="data">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Decisions</th>
                    <th>Stage</th>
                    <th>Learned share</th>
                    <th>Trigger</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {d.models.map((x: any) => (
                    <tr key={x.id}>
                      <td>v{x.version} {x.is_active && <span className="badge good">active</span>}</td>
                      <td className="num">{x.sample_count}</td>
                      <td>{x.stage.replace('_', ' ')}</td>
                      <td className="num">{pct(x.blend_alpha)}</td>
                      <td className="small">{x.trigger}</td>
                      <td className="small nowrap">{date(x.created_at, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
