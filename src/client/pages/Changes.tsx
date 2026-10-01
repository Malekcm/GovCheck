import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { EVENT_LABELS } from '../../shared/domain';
import { api } from '../api';
import { date } from '../format';
import { Card, Empty, ErrorBox, Loading, Score, StageBadge } from '../components/ui';

export function ChangesPage() {
  const [type, setType] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [minFit, setMinFit] = useState(0);
  const q = useQuery({ queryKey: ['changes', type, days, minFit], queryFn: () => api.get<any>(`/api/changes?days=${days}&minFit=${minFit}${type ? `&type=${type}` : ''}`) });
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Recent changes</h1>
          <p>What changed across all sources: new profiles and sources, deadline/value/status changes, amendments, new documents, awards, forecast links, incumbents and recompete signals.</p>
        </div>
        <div className="row">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 14, 30, 90].map((d) => (
              <option key={d} value={d}>
                Last {d} day{d > 1 ? 's' : ''}
              </option>
            ))}
          </select>
          <select value={minFit} onChange={(e) => setMinFit(Number(e.target.value))}>
            <option value={0}>Any fit</option>
            <option value={40}>Fit ≥ 40</option>
            <option value={60}>Fit ≥ 60</option>
            <option value={75}>Fit ≥ 75</option>
          </select>
        </div>
      </div>
      {q.data && (
        <div className="chips" style={{ marginBottom: 12 }}>
          <span className={`chip ${!type ? 'on' : ''}`} onClick={() => setType(null)}>
            All
          </span>
          {q.data.counts.map((c: any) => (
            <span key={c.event_type} className={`chip ${type === c.event_type ? 'on' : ''}`} onClick={() => setType(c.event_type)}>
              {EVENT_LABELS[c.event_type] ?? c.event_type} <span className="num">{c.n}</span>
            </span>
          ))}
        </div>
      )}
      <Card bodyClass="">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} />
        ) : q.data.events.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Detected</th>
                <th>Change</th>
                <th>Opportunity</th>
                <th>Fit</th>
                <th>Stage</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {q.data.events.map((e: any) => (
                <tr key={e.id}>
                  <td className="small nowrap">{date(e.detected_at, true)}</td>
                  <td>
                    <span className="badge neutral">{EVENT_LABELS[e.event_type] ?? e.event_type}</span>
                    <div className="small">{e.title}</div>
                  </td>
                  <td>
                    <Link to={`/opportunities/${e.opportunity_id}`}>{e.opportunity_title}</Link>
                  </td>
                  <td>
                    <Score value={e.fit_score} />
                  </td>
                  <td>
                    <StageBadge stage={e.stage} isSignal={e.is_signal} />
                  </td>
                  <td className="small muted">{e.connector_name ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No changes in this window" />
        )}
      </Card>
    </div>
  );
}
