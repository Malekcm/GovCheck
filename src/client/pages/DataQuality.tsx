import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { STAGE_LABELS, type Stage } from '../../shared/domain';
import { api } from '../api';
import { relative, titleize } from '../format';
import { Card, ErrorBox, Loading } from '../components/ui';

const GAP_LABELS: [string, string, string | null][] = [
  ['active_total', 'Active / upcoming profiles', '/opportunities?queue=all&openOnly=true'],
  ['missing_value', 'No value information', null],
  ['estimated_value_only', 'Value is estimated/derived only', null],
  ['missing_contacts', 'No contacts', null],
  ['solicitations_missing_documents', 'Solicitations without documents', null],
  ['documents_needing_ocr', 'Have scanned docs needing OCR', null],
  ['missing_deadline', 'Actionable but no deadline', null],
  ['missing_naics', 'No NAICS', null],
  ['unresolved_agency', 'Agency unresolved', null],
  ['unresolved_office', 'Office unresolved (prime)', null],
  ['recompete_without_incumbent', 'Recompete without incumbent', '/opportunities?queue=recompetes&hasIncumbent='],
  ['thin_description', 'Thin / missing description', null],
  ['stale', 'Stale (not seen ≥ 30 days)', null],
  ['unscored', 'Not scored', null],
];

/** "Is GovCheck actually seeing the market?" — source health beyond a green icon, and the data gaps that matter. */
export function DataQualityPage() {
  const q = useQuery({ queryKey: ['data-quality'], queryFn: () => api.get<any>('/api/data-quality'), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const stages = [...new Set<string>(d.byStage.map((r: any) => r.stage))];
  const connectors = [...new Set<string>(d.byStage.map((r: any) => r.connector))];
  const cell = (stage: string, c: string) => d.byStage.find((r: any) => r.stage === stage && r.connector === c)?.n ?? 0;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Data quality & coverage</h1>
          <p>Source health, measured coverage problems, and the facts GovCheck is missing. A source is only “healthy” if it returned what the source says exists.</p>
        </div>
      </div>

      <Card title="Source health" bodyClass="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Source</th>
              <th>Health</th>
              <th>Last success</th>
              <th>Last run</th>
              <th>Stored</th>
              <th>Not seen</th>
              <th>Errors 7d</th>
              <th>Coverage warnings 30d</th>
              <th>Failed runs 7d</th>
            </tr>
          </thead>
          <tbody>
            {d.sources.map((s: any) => (
              <tr key={s.id}>
                <td>
                  <strong>{s.name}</strong>
                  {!s.enabled && <span className="badge neutral">disabled</span>}
                  {s.health_message && <div className="small muted" style={{ maxWidth: 420 }}>{s.health_message}</div>}
                </td>
                <td>
                  <span className={`badge ${s.health === 'healthy' ? 'good' : s.health === 'degraded' ? 'warn' : s.health === 'error' ? 'bad' : 'neutral'}`}>{titleize(s.health)}</span>
                </td>
                <td className="small nowrap">{s.last_success_at ? relative(s.last_success_at) : <span className="badge warn">never</span>}</td>
                <td className="small num">
                  {s.last_status ? (
                    <>
                      {s.last_status} · {s.last_retrieved ?? 0} fetched · {s.last_created ?? 0} new · {s.last_updated ?? 0} changed{s.last_failed ? ` · ${s.last_failed} failed` : ''}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="num">{s.stored_records}</td>
                <td className="num">{s.not_seen_records}</td>
                <td className="num">{s.errors_7d ? <span className="badge bad">{s.errors_7d}</span> : 0}</td>
                <td className="num">{s.coverage_warnings_30d ? <span className="badge warn">{s.coverage_warnings_30d}</span> : 0}</td>
                <td className="num">{s.failed_runs_7d ? <span className="badge bad">{s.failed_runs_7d}</span> : 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-2">
        <Card title="Missing information (active profiles)">
          <div className="kpis">
            {GAP_LABELS.map(([k, label, to]) => {
              const inner = (
                <>
                  <div className="label">{label}</div>
                  <div className="value">{d.gaps?.[k] ?? 0}</div>
                </>
              );
              return to ? (
                <Link key={k} className="kpi" to={to}>
                  {inner}
                </Link>
              ) : (
                <div key={k} className="kpi">
                  {inner}
                </div>
              );
            })}
          </div>
          <div className="row small">
            <Link to="/merge">{d.pendingDuplicates} duplicate candidate(s) awaiting review</Link> · <span>{d.unmatchedSourceRecords} unlinked source record(s)</span> ·{' '}
            <Link to="/coverage?type=ORPHAN_AWARD">{d.orphanAwards} orphan award(s)</Link>
          </div>
        </Card>
        <Card title="Documents">
          <table className="data">
            <thead>
              <tr>
                <th>Retrieval</th>
                <th>Text</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {d.documents.map((x: any, i: number) => (
                <tr key={i}>
                  <td>{titleize(x.retrieval_status)}</td>
                  <td>{titleize(x.text_status)}</td>
                  <td className="num">{x.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">“Skipped” SAM attachments need SAM_DOWNLOAD_DOCUMENTS=true (uses the SAM request budget). “OCR needed” = scanned PDFs; OCR is not enabled.</p>
        </Card>
      </div>

      <Card title="Coverage by lifecycle stage × source" bodyClass="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Stage</th>
              {connectors.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stages.map((s) => (
              <tr key={s}>
                <td>{STAGE_LABELS[s as Stage] ?? s}</td>
                {connectors.map((c) => (
                  <td key={c} className="num">
                    {cell(s, c) || <span className="muted">·</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-2">
        <Card title="Coverage by agency" bodyClass="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Department</th>
                <th>Active</th>
                <th>On SAM</th>
                <th>Forecasts</th>
                <th>Recompete signals</th>
                <th>Fit ≥ 60</th>
              </tr>
            </thead>
            <tbody>
              {d.byAgency.map((a: any) => (
                <tr key={a.agency}>
                  <td className="small">{a.agency}</td>
                  <td className="num">{a.n}</td>
                  <td className="num">{a.on_sam}</td>
                  <td className="num">{a.forecasts}</td>
                  <td className="num">{a.recompete_signals}</td>
                  <td className="num">{a.strong_fit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Recent sync errors & warnings (7 days)" bodyClass="table-wrap">
          {d.recentErrors.length ? (
            <table className="data">
              <tbody>
                {d.recentErrors.map((e: any, i: number) => (
                  <tr key={i}>
                    <td className="small nowrap">{relative(e.created_at)}</td>
                    <td className="small">
                      <span className={`badge ${e.step === 'coverage' ? 'warn' : 'bad'}`}>{e.connector_id} · {e.step}</span> {e.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small" style={{ padding: 12 }}>No errors in the last 7 days.</p>
          )}
          {d.budget.length > 0 && (
            <p className="small muted" style={{ padding: '0 12px 12px' }}>
              API usage: {d.budget.map((b: any) => `${b.connector_id} ${String(b.usage_date).slice(0, 10)}: ${b.requests}`).join(' · ')}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
