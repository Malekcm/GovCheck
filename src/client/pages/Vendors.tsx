import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { date, money, titleize } from '../format';
import { Card, Empty, ErrorBox, Loading, Prov, Score, StageBadge, Term } from '../components/ui';

export function VendorsPage() {
  const [q, setQ] = useState('');
  const list = useQuery({ queryKey: ['vendors', q], queryFn: () => api.get<any[]>(`/api/vendors${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Vendors & incumbents</h1>
          <p>Public procurement data only (awards, UEI, CAGE). Incumbent links are labeled confirmed vs possible with evidence.</p>
        </div>
        <input type="search" placeholder="Name, UEI or CAGE" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card bodyClass="">
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <ErrorBox error={list.error} />
        ) : list.data!.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>
                  <Term t="UEI" />
                </th>
                <th>
                  <Term t="CAGE" />
                </th>
                <th>Awards stored</th>
                <th>Total</th>
                <th>Ending ≤ 18 mo</th>
                <th>Incumbencies</th>
              </tr>
            </thead>
            <tbody>
              {list.data!.map((v) => (
                <tr key={v.id}>
                  <td>
                    <Link to={`/vendors/${v.id}`}>{v.name}</Link>
                  </td>
                  <td className="mono small">{v.uei ?? '—'}</td>
                  <td className="mono small">{v.cage ?? '—'}</td>
                  <td className="num">{v.awards ?? 0}</td>
                  <td className="num">{money(v.total)}</td>
                  <td className="num">{v.ending_soon ?? 0}</td>
                  <td className="num">{v.incumbencies}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No vendors yet" />
        )}
      </Card>
    </div>
  );
}

export function VendorDetailPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['vendor', id], queryFn: () => api.get<any>(`/api/vendors/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const v = d.vendor;
  const total = d.awards.reduce((s: number, a: any) => s + Number(a.total_obligated ?? a.dollars_obligated ?? 0), 0);
  const ending = d.awards.filter((a: any) => a.pop_current_end && new Date(a.pop_current_end).getTime() > Date.now() && new Date(a.pop_current_end).getTime() < Date.now() + 548 * 86400e3);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{v.name}</h1>
          <p>
            UEI <span className="mono">{v.uei ?? '—'}</span> · CAGE <span className="mono">{v.cage ?? '—'}</span>
            {v.parent_name && ` · Parent: ${v.parent_name}`}
            {v.state && ` · ${v.city ?? ''} ${v.state}`}
          </p>
        </div>
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="label">Awards stored <Prov p="official" /></div>
          <div className="value">{d.awards.length}</div>
        </div>
        <div className="kpi">
          <div className="label">Obligated (stored)</div>
          <div className="value">{money(total)}</div>
        </div>
        <div className="kpi signal">
          <div className="label">Contracts ending ≤ 18 mo</div>
          <div className="value">{ending.length}</div>
        </div>
        <div className="kpi">
          <div className="label">Incumbent on</div>
          <div className="value">{d.roles.length}</div>
        </div>
      </div>
      <div className="grid grid-3">
        <Card title="Agencies / offices">
          {d.agencies.map((a: any, i: number) => (
            <div key={i} className="spread small">
              <span className="truncate">{a.office_name ?? a.subtier_name}</span>
              <span className="num">{money(a.total)}</span>
            </div>
          ))}
        </Card>
        <Card title="NAICS">
          {d.naics.map((a: any) => (
            <div key={a.naics_code} className="spread small">
              <span className="mono">{a.naics_code}</span>
              <span className="num">{money(a.total)}</span>
            </div>
          ))}
        </Card>
        <Card title="PSC">
          {d.psc.map((a: any) => (
            <div key={a.psc_code} className="spread small">
              <span className="mono">{a.psc_code}</span>
              <span className="num">{money(a.total)}</span>
            </div>
          ))}
        </Card>
      </div>
      <Card title="Opportunities where this vendor is awardee / incumbent" bodyClass="">
        {d.roles.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Role</th>
                <th>Opportunity</th>
                <th>Stage</th>
                <th>Fit</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {d.roles.map((r: any) => (
                <tr key={`${r.id}-${r.role}`}>
                  <td>
                    <span className={`badge ${r.role === 'possible_incumbent' ? 'warn' : 'good'}`}>{titleize(r.role)}</span>
                    <div className="small muted">{r.confidence}</div>
                  </td>
                  <td>
                    <Link to={`/opportunities/${r.id}`}>{r.title}</Link>
                  </td>
                  <td>
                    <StageBadge stage={r.stage} isSignal={r.is_signal} />
                  </td>
                  <td>
                    <Score value={r.fit_score} />
                  </td>
                  <td className="small">{(r.evidence ?? []).join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="card-body muted small">None.</div>
        )}
      </Card>
      <Card title="Awards" bodyClass="">
        <table className="data">
          <thead>
            <tr>
              <th>Award</th>
              <th>Agency / office</th>
              <th>Potential</th>
              <th>Obligated</th>
              <th>Period</th>
              <th>NAICS / PSC</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {d.awards.map((a: any) => (
              <tr key={a.id}>
                <td className="mono small">
                  {a.piid}
                  <div className="muted" style={{ fontFamily: 'var(--font)' }}>{(a.description ?? '').slice(0, 90)}</div>
                </td>
                <td className="small">{a.office_name ?? a.subtier_name}</td>
                <td className="num">{money(a.base_and_all_options)}</td>
                <td className="num">{money(a.total_obligated ?? a.dollars_obligated)}</td>
                <td className="small nowrap">
                  {date(a.pop_start)} → {date(a.pop_current_end)}
                </td>
                <td className="small mono">
                  {a.naics_code} / {a.psc_code}
                </td>
                <td className="small muted">{a.connector_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
