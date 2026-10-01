import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { EVENT_LABELS } from '../../shared/domain';
import { api } from '../api';
import { money, relative } from '../format';
import { OpportunityTable } from '../components/OpportunityTable';
import { Card, Empty, ErrorBox, Loading, ProvenanceLegend, Score } from '../components/ui';

function Kpi({ label, value, sub, to, tone }: { label: string; value: React.ReactNode; sub?: string; to?: string; tone?: string }) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </>
  );
  return to ? (
    <Link to={to} className={`kpi ${tone ?? ''}`}>
      {body}
    </Link>
  ) : (
    <div className={`kpi ${tone ?? ''}`}>{body}</div>
  );
}

export function DashboardPage() {
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<any>('/api/dashboard'), refetchInterval: 60_000 });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const k = d.kpis;
  const needsSetup = !d.company?.onboarding_completed_at || d.confirmedCapabilities === 0;
  const unconfigured = d.sources.filter((s: any) => s.health === 'not_configured');

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{d.company?.name ? `${d.company.name} — opportunity intelligence` : 'Opportunity intelligence'}</h1>
          <p>Every lifecycle stage across federal sources, consolidated into one profile per procurement and ranked against your company profile.</p>
        </div>
        <ProvenanceLegend />
      </div>

      {needsSetup && (
        <div className="callout" style={{ marginBottom: 12 }}>
          <strong>Finish setting up your company profile</strong> — matching depends on the capabilities, NAICS codes and certifications you confirm.{' '}
          <Link to="/onboarding">Open the setup guide →</Link>
        </div>
      )}
      {unconfigured.length > 0 && (
        <div className="callout warn" style={{ marginBottom: 12 }}>
          Not configured: {unconfigured.map((s: any) => s.name).join(', ')}. <Link to="/sources">See setup instructions →</Link>
        </div>
      )}

      <div className="kpis">
        <Kpi label="New since last visit" value={k.newSinceVisit} to="/opportunities?queue=new" tone="accent" />
        <Kpi label="High matches" value={k.highMatches} sub="Fit ≥ 70, open" to="/opportunities?queue=high-match" tone="accent" />
        <Kpi label="Unreviewed" value={k.unreviewed} sub="Fit ≥ 40, no decision" to="/opportunities?queue=needs-review" />
        <Kpi label="Due in 7 days" value={k.due7} to="/opportunities?queue=due-soon" tone={k.due7 ? 'warn' : ''} />
        <Kpi label="Due in 30 days" value={k.due30} to="/opportunities?queue=all&dueWithinDays=30&sort=deadline" />
        <Kpi label="Forecasts" value={k.forecasts} sub="Pre-solicitation" to="/opportunities?queue=forecasts" />
        <Kpi label="Possible recompetes" value={k.recompetes} sub="Intelligence signals" to="/opportunities?queue=recompetes" tone="signal" />
        <Kpi label="Subcontracts" value={k.subcontracts} to="/opportunities?queue=subcontracts" />
        <Kpi label="Recently changed" value={k.recentlyChanged} sub="Last 7 days" to="/changes" />
        <Kpi label="Coverage gaps" value={k.coverageGaps} to="/coverage" tone={k.coverageGaps ? 'warn' : ''} />
        <Kpi
          label="Potential pipeline"
          value={money(Number(k.pipeline.official) + Number(k.pipeline.estimated))}
          sub={`${k.pipeline.n} pursuing/interested · ${money(k.pipeline.official)} official${Number(k.pipeline.estimated) ? ` + ${money(k.pipeline.estimated)} estimated` : ''}${k.pipeline.unknown ? ` · ${k.pipeline.unknown} unvalued` : ''}`}
          to="/opportunities?queue=pursuing"
        />
        <Kpi label="Profiles tracked" value={k.total.toLocaleString()} to="/opportunities?queue=all" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2.4fr) minmax(280px, 1fr)' }}>
        <Card title="Top open matches (by your preference score)" bodyClass="" actions={<Link to="/opportunities?queue=high-match">View all →</Link>}>
          {d.top.length ? <OpportunityTable rows={d.top} compact /> : <Empty title="No open opportunities yet">Run <Link to="/sources">a data refresh</Link> after setting up your profile.</Empty>}
        </Card>
        <div>
          <Card title="Recent changes" actions={<Link to="/changes">All →</Link>}>
            {d.changes.length ? (
              <div className="stack">
                {d.changes.slice(0, 14).map((e: any) => (
                  <div key={e.id} className="small">
                    <span className="badge neutral">{EVENT_LABELS[e.event_type] ?? e.event_type}</span> <Link to={`/opportunities/${e.opportunity_id}`}>{e.opportunity_title}</Link>
                    <div className="muted">
                      {e.title} · {relative(e.detected_at)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted">No changes recorded yet.</span>
            )}
          </Card>
          <Card title="Source health" actions={<Link to="/sources">Manage →</Link>}>
            {d.sources.map((s: any) => (
              <div key={s.id} className="spread small" style={{ padding: '3px 0' }}>
                <span className="row">
                  <span className={`health-dot ${s.health}`} /> {s.name}
                </span>
                <span className="muted">{s.health === 'not_configured' ? 'Not configured' : s.last_success_at ? relative(s.last_success_at) : 'never'}</span>
              </div>
            ))}
          </Card>
          <Card title="Preference learning" actions={<Link to="/learning">Details →</Link>}>
            {d.model ? (
              <div className="small">
                Model v{d.model.version} · {d.model.sample_count} decisions · stage <strong>{d.model.stage.replace('_', ' ')}</strong> · learned weight{' '}
                <Score value={Number(d.model.blend_alpha) * 100} />%
              </div>
            ) : (
              <span className="muted small">No decisions yet — rankings use base fit only.</span>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
