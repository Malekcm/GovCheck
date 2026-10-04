import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { date, money, moneyRange } from '../format';
import { Card, Deadline, DecisionBadge, Empty, ErrorBox, Loading, Prov, Score } from '../components/ui';

/** Capture pipeline: every opportunity with a capture plan or a pursue/partner decision, by pursuit stage. */
export function PipelinePage() {
  const [closed, setClosed] = useState(false);
  const q = useQuery({ queryKey: ['pipeline', closed], queryFn: () => api.get<any>(`/api/pipeline?closed=${closed}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Capture pipeline</h1>
          <p>Opportunities you are pursuing, by capture stage. Set the stage, owner and next action on each dossier. Refreshes never change this data.</p>
        </div>
        <label className="check">
          <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Show awarded / lost / no-bid
        </label>
      </div>
      <div className="kpis">
        <div className="kpi accent">
          <div className="label">Tracked pursuits</div>
          <div className="value">{d.total}</div>
        </div>
        <div className={`kpi ${d.overdueActions ? 'warn' : ''}`}>
          <div className="label">Overdue next actions</div>
          <div className="value">{d.overdueActions}</div>
        </div>
        <div className="kpi tip" data-tip="Σ value × win probability, only where both are set. Uses the headline value, which may be official, derived or estimated — check each dossier.">
          <div className="label">Probability-weighted value</div>
          <div className="value">{money(d.weightedOfficialOrEstimatedValue)}</div>
          <div className="sub">mixed provenance</div>
        </div>
      </div>
      {d.total === 0 ? (
        <Card>
          <Empty title="No pursuits yet">Mark an opportunity Strong pursue, Pursue or Partner/sub — or save a capture plan on its dossier — to track it here.</Empty>
        </Card>
      ) : (
        <div className="pipeline">
          {d.stages.map((g: any) => (
            <div className="col" key={g.stage}>
              <h3>
                {g.label} <span className="num">{g.items.length}</span>
              </h3>
              {g.items.map((o: any) => (
                <div className="item" key={o.id}>
                  <Link to={`/opportunities/${o.id}#capture`}>{o.title}</Link>
                  <div className="row small" style={{ gap: 6, marginTop: 4 }}>
                    <Score value={o.priority_score} label="Review priority" />
                    <DecisionBadge decision={o.decision} />
                    {o.capture_owner && <span className="muted">{o.capture_owner}</span>}
                  </div>
                  <div className="small muted" style={{ marginTop: 3 }}>
                    {o.subtier_name ?? o.department_name ?? ''}
                  </div>
                  <div className="small" style={{ marginTop: 3 }}>
                    Due: <Deadline value={o.proposal_deadline ?? o.response_deadline} />
                  </div>
                  {(o.value_low != null || o.value_high != null) && (
                    <div className="small">
                      {moneyRange(o.value_low, o.value_high)} <Prov p={o.value_provenance} />
                      {o.win_probability != null && <span className="muted"> · {o.win_probability}% win</span>}
                    </div>
                  )}
                  {o.next_action && (
                    <div className={`small ${o.next_action_date && String(o.next_action_date).slice(0, 10) < today ? 'badge bad' : 'muted'}`} style={{ marginTop: 3 }}>
                      → {o.next_action}
                      {o.next_action_date ? ` (${date(o.next_action_date)})` : ''}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
