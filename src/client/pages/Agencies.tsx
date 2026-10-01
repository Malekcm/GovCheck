import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { DECISION_LABELS, type Decision } from '../../shared/domain';
import { api } from '../api';
import { date, money } from '../format';
import { OpportunityTable } from '../components/OpportunityTable';
import { Card, Empty, ErrorBox, Loading, Prov, toast } from '../components/ui';

export function AgenciesPage() {
  const q = useQuery({ queryKey: ['agencies'], queryFn: () => api.get<any[]>('/api/agencies') });
  const [filter, setFilter] = useState('');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const rows = q.data!.filter((a) => !filter || a.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Agencies & offices</h1>
          <p>Where the work is, how much each agency spends in your space, and where you have pursued before — built from everything accumulated so far.</p>
        </div>
        <input type="search" placeholder="Filter agencies" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <Card bodyClass="">
        {rows.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Agency</th>
                <th>Level</th>
                <th>Profiles</th>
                <th>Relevant (fit ≥ 50)</th>
                <th>Open solicitations</th>
                <th>Your pursuits</th>
                <th>Award history stored</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={`/agencies/${a.id}`}>{a.name}</Link>
                    {a.parent_name && <div className="small muted">{a.parent_name}</div>}
                  </td>
                  <td className="small">{a.level}</td>
                  <td className="num">{a.opportunities}</td>
                  <td className="num">{a.relevant}</td>
                  <td className="num">{a.open_solicitations}</td>
                  <td className="num">{a.pursuits}</td>
                  <td className="num">{money(a.award_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No agencies yet">Agencies appear as data is synced.</Empty>
        )}
      </Card>
    </div>
  );
}

function Bars({ rows, label, value, link }: { rows: any[]; label: (r: any) => React.ReactNode; value: (r: any) => number; link?: (r: any) => string | null }) {
  const max = Math.max(1, ...rows.map(value));
  return (
    <div className="bar-list">
      {rows.map((r, i) => (
        <div key={i} className="bar-row small">
          <div>
            {link?.(r) ? <Link to={link(r)!}>{label(r)}</Link> : label(r)}
            <div className="bar" style={{ width: `${Math.max(3, (value(r) / max) * 100)}%` }} />
          </div>
          <div className="num right">{money(value(r))}</div>
        </div>
      ))}
    </div>
  );
}

export function AgencyDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['agency', id], queryFn: () => api.get<any>(`/api/agencies/${id}`) });
  const enrich = useMutation({
    mutationFn: () => api.post<any>(`/api/agencies/${id}/enrich`),
    onSuccess: (r) => (toast(`${r.awardsRetrieved} award records retrieved from USAspending.`), qc.invalidateQueries({ queryKey: ['agency', id] })),
    onError: (e: Error) => toast(e.message),
  });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const opps = d.opportunities;
  const open = opps.filter((o: any) => o.status === 'active' && ['solicitation', 'combined_synopsis', 'sources_sought', 'rfi', 'presolicitation'].includes(o.stage));
  const forecasts = opps.filter((o: any) => o.stage === 'forecast');
  const recompetes = opps.filter((o: any) => o.is_signal);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{d.agency.name}</h1>
          <p>
            {d.agency.level === 'subtier' ? `Sub-agency of ${d.agency.parent_name ?? '—'}` : 'Department'} · {opps.length} profiles tracked
          </p>
        </div>
        <button className="btn" onClick={() => enrich.mutate()} disabled={enrich.isPending}>
          {enrich.isPending && <span className="spinner" />} Fetch spending history (USAspending)
        </button>
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="label">Award history stored <Prov p="official" /></div>
          <div className="value">{money(d.awards.aggregate?.total)}</div>
          <div className="sub">{d.awards.aggregate?.n ?? 0} awards</div>
        </div>
        <div className="kpi">
          <div className="label">Your NAICS spend</div>
          <div className="value">{money(d.awards.relevantNaics?.total)}</div>
          <div className="sub">{d.awards.relevantNaics?.n ?? 0} awards in {d.companyNaics.join(', ') || 'no NAICS set'}</div>
        </div>
        <div className="kpi">
          <div className="label">Average award size</div>
          <div className="value">{money(d.awards.aggregate?.avg_size)}</div>
        </div>
        <div className="kpi">
          <div className="label">Open opportunities</div>
          <div className="value">{open.length}</div>
        </div>
        <div className="kpi">
          <div className="label">Forecasts</div>
          <div className="value">{forecasts.length}</div>
        </div>
        <div className="kpi signal">
          <div className="label">Possible recompetes</div>
          <div className="value">{recompetes.length}</div>
        </div>
        <div className="kpi">
          <div className="label">Your decisions</div>
          <div className="value">{d.decisions.reduce((s: number, x: any) => s + x.n, 0)}</div>
          <div className="sub">{d.decisions.map((x: any) => `${DECISION_LABELS[x.decision as Decision]} ${x.n}`).join(' · ') || 'none'}</div>
        </div>
      </div>
      <div className="grid grid-3">
        <Card title="Top vendors">{d.awards.topVendors.length ? <Bars rows={d.awards.topVendors} label={(r) => `${r.awardee_name} (${r.awards})`} value={(r) => Number(r.total)} link={(r) => (r.vendor_id ? `/vendors/${r.vendor_id}` : null)} /> : <span className="muted small">No award history yet.</span>}</Card>
        <Card title="Spend by NAICS">{d.awards.naicsSpend.length ? <Bars rows={d.awards.naicsSpend} label={(r) => `${r.naics_code} (${r.n})`} value={(r) => Number(r.total)} /> : <span className="muted small">—</span>}</Card>
        <Card title="Offices">
          {d.offices.length ? (
            d.offices.slice(0, 15).map((o: any) => (
              <div key={o.id} className="spread small" style={{ padding: '2px 0' }}>
                <span className="truncate">{o.name}</span>
                <span className="num">
                  {o.relevant}/{o.opportunities}
                </span>
              </div>
            ))
          ) : (
            <span className="muted small">—</span>
          )}
        </Card>
      </div>
      <Card title="Contracts expiring in the next 18 months" bodyClass="">
        {d.awards.expiring.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Award</th>
                <th>Vendor</th>
                <th>Value</th>
                <th>Ends</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {d.awards.expiring.map((a: any) => (
                <tr key={a.id}>
                  <td className="mono small">{a.piid}</td>
                  <td className="small">{a.vendor_id ? <Link to={`/vendors/${a.vendor_id}`}>{a.awardee_name}</Link> : a.awardee_name}</td>
                  <td className="num">{money(a.base_and_all_options ?? a.total_obligated)}</td>
                  <td className="small nowrap">{date(a.pop_current_end)}</td>
                  <td className="small">{(a.description ?? '').slice(0, 140)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="card-body muted small">None stored for this agency.</div>
        )}
      </Card>
      <Card title="Opportunities" bodyClass="">
        {opps.length ? <OpportunityTable rows={opps} compact /> : <div className="card-body muted">None.</div>}
      </Card>
    </div>
  );
}
