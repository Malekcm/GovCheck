import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { date, money } from '../format';
import { Card, Empty, ErrorBox, Loading, Prov } from '../components/ui';

/** Contracts in your NAICS (and industry group) whose period of performance ends soon — the recompete pipeline. */
export function ExpiringPage() {
  const [months, setMonths] = useState(18);
  const [bucket, setBucket] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['expiring', months], queryFn: () => api.get<any>(`/api/intel/expiring?months=${months}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const items = bucket ? d.items.filter((i: any) => i.window === bucket) : d.items;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Expiring contracts</h1>
          <p>
            Award records (SAM Contract Awards / USAspending, incl. IDVs by last date to order) in your NAICS codes ending within {months} months. Values are OFFICIAL award amounts; “successor” links are
            derived.
          </p>
        </div>
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
          {[3, 6, 12, 18, 24, 36].map((m) => (
            <option key={m} value={m}>
              Next {m} months
            </option>
          ))}
        </select>
      </div>
      <div className="kpis">
        {d.summary.map((s: any) => (
          <button key={s.window} className={`kpi ${bucket === s.window ? 'accent' : ''}`} style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => setBucket(bucket === s.window ? null : s.window)}>
            <div className="label">Ends in {s.window} months</div>
            <div className="value">{s.contracts}</div>
            <div className="sub">
              {money(s.value)} · {s.untracked} not yet tracked
            </div>
          </button>
        ))}
      </div>
      <Card bodyClass="table-wrap">
        {items.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Ends</th>
                <th>Contract</th>
                <th>Incumbent</th>
                <th>Agency / office</th>
                <th>Value</th>
                <th>Competition</th>
                <th>Successor</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a: any) => (
                <tr key={a.id}>
                  <td className="nowrap small">
                    {date(a.pop_current_end)}
                    {a.pop_potential_end && a.pop_potential_end !== a.pop_current_end && <div className="muted">potential {date(a.pop_potential_end)}</div>}
                  </td>
                  <td className="small" style={{ maxWidth: 320 }}>
                    <span className="mono">{a.piid}</span>
                    {a.referenced_idv_piid && <span className="muted"> (order under {a.referenced_idv_piid})</span>}
                    {a.idv_type && <span className="badge outline">{a.idv_type}</span>}
                    <div className="muted truncate" title={a.description ?? ''}>
                      {a.description ?? '—'}
                    </div>
                    <div className="muted">
                      NAICS {a.naics_code ?? '—'} · PSC {a.psc_code ?? '—'}
                    </div>
                  </td>
                  <td className="small">{a.vendor_id ? <Link to={`/vendors/${a.vendor_id}`}>{a.awardee_name}</Link> : a.awardee_name ?? '—'}</td>
                  <td className="small">
                    {a.subtier_name ?? a.department_name}
                    {a.office_name && <div className="muted">{a.office_name}</div>}
                  </td>
                  <td className="small nowrap">
                    {money(a.base_and_all_options ?? a.total_obligated)} <Prov p="official" title={a.base_and_all_options ? 'Base + all options (official)' : 'Obligated to date (official)'} />
                  </td>
                  <td className="small">
                    {a.extent_competed ?? '—'}
                    {a.set_aside && <div className="muted">{a.set_aside}</div>}
                    {a.number_of_offers != null && <div className="muted">{a.number_of_offers} offer(s)</div>}
                  </td>
                  <td className="small">
                    {a.successorId ? <Link to={`/opportunities/${a.successorId}`}>{a.successorStatus}</Link> : <span className="badge warn">{a.successorStatus}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty title="No expiring contracts found">Add NAICS codes to the company profile and sync USAspending / SAM Contract Awards to build award history.</Empty>
        )}
      </Card>
    </div>
  );
}
