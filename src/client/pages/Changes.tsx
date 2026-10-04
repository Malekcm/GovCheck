import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { EVENT_LABELS } from '../../shared/domain';
import { api } from '../api';
import { date } from '../format';
import { Card, Empty, ErrorBox, Loading, Score, StageBadge } from '../components/ui';

/** One-click answers to the questions BD teams actually ask. */
const PRESETS: { id: string; label: string; days: number; type: string | null; scope: 'all' | 'tracked'; meaningful: boolean }[] = [
  { id: 'yesterday', label: 'What changed since yesterday?', days: 1, type: null, scope: 'all', meaningful: true },
  { id: 'new-week', label: 'New opportunities this week', days: 7, type: 'NEW_OPPORTUNITY', scope: 'all', meaningful: false },
  { id: 'tracked-amend', label: 'Amendments on watched / pursued', days: 30, type: 'AMENDMENT,NEW_DOCUMENT,DEADLINE_CHANGED,SCOPE_CHANGED', scope: 'tracked', meaningful: false },
  { id: 'tracked-all', label: 'Everything on watched / pursued', days: 14, type: null, scope: 'tracked', meaningful: true },
];

export function ChangesPage() {
  const [type, setType] = useState<string | null>(null);
  const [days, setDays] = useState(14);
  const [minFit, setMinFit] = useState(0);
  const [scope, setScope] = useState<'all' | 'tracked'>('all');
  const [meaningful, setMeaningful] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['changes', type, days, minFit, scope, meaningful],
    queryFn: () => api.get<any>(`/api/changes?days=${days}&minFit=${minFit}&scope=${scope}${meaningful ? '&meaningful=true' : ''}${type ? `&type=${type}` : ''}`),
  });
  const apply = (p: (typeof PRESETS)[number]) => {
    setPreset(p.id);
    setDays(p.days);
    setType(p.type);
    setScope(p.scope);
    setMeaningful(p.meaningful);
  };
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Recent changes</h1>
          <p>What changed across all sources: new profiles and sources, deadline/value/status changes, amendments, new documents, awards, forecast links, incumbents and recompete signals.</p>
        </div>
        <div className="row">
          <select value={scope} onChange={(e) => (setScope(e.target.value as 'all' | 'tracked'), setPreset(null))}>
            <option value="all">All opportunities</option>
            <option value="tracked">Watched / pursued / in capture</option>
          </select>
          <label className="row small nowrap">
            <input type="checkbox" checked={meaningful} onChange={(e) => (setMeaningful(e.target.checked), setPreset(null))} /> Meaningful changes only
          </label>
          <select value={days} onChange={(e) => (setDays(Number(e.target.value)), setPreset(null))}>
            {[1, 2, 7, 14, 30, 90].map((d) => (
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
      <div className="chips" style={{ marginBottom: 8 }}>
        {PRESETS.map((p) => (
          <span key={p.id} className={`chip ${preset === p.id ? 'on' : ''}`} onClick={() => apply(p)}>
            {p.label}
          </span>
        ))}
      </div>
      {q.data?.summary && (
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          {q.data.summary.events.toLocaleString()} change(s) across {q.data.summary.opportunities.toLocaleString()} opportunit{q.data.summary.opportunities === 1 ? 'y' : 'ies'} in the last {days} day{days > 1 ? 's' : ''}.
        </p>
      )}
      {q.data && (
        <div className="chips" style={{ marginBottom: 12 }}>
          <span className={`chip ${!type ? 'on' : ''}`} onClick={() => (setType(null), setPreset(null))}>
            All
          </span>
          {q.data.counts.map((c: any) => (
            <span key={c.event_type} className={`chip ${type === c.event_type ? 'on' : ''}`} onClick={() => (setType(c.event_type), setPreset(null))}>
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
                    {e.decision && <div className="small muted">Your decision: {e.decision}</div>}
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
