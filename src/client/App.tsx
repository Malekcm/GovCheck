import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Building2,
  CalendarClock,
  Database,
  Gauge,
  KanbanSquare,
  GitMerge,
  Brain,
  LayoutDashboard,
  ListFilter,
  Menu,
  RefreshCw,
  Search,
  ShieldAlert,
  Users,
  UserCog,
  Rocket,
  Crosshair,
} from 'lucide-react';
import { api, ApiError } from './api';
import { relative } from './format';
import { ToastHost, toast } from './components/ui';
import { DashboardPage } from './pages/Dashboard';
import { OpportunitiesPage } from './pages/Opportunities';
import { OpportunityDetailPage } from './pages/OpportunityDetail';
import { CaptureBriefPage } from './pages/CaptureBrief';
import { CompanyPage } from './pages/Company';
import { OnboardingPage } from './pages/Onboarding';
import { SourcesPage } from './pages/Sources';
import { CoveragePage } from './pages/Coverage';
import { ChangesPage } from './pages/Changes';
import { MergeReviewPage } from './pages/MergeReview';
import { AgenciesPage, AgencyDetailPage } from './pages/Agencies';
import { VendorsPage, VendorDetailPage } from './pages/Vendors';
import { LearningPage } from './pages/Learning';
import { LoginPage } from './pages/Login';
import { PipelinePage } from './pages/Pipeline';
import { DataQualityPage } from './pages/DataQuality';
import { ExpiringPage } from './pages/Expiring';
import { TargetedSearchPage } from './pages/TargetedSearch';

function useSyncStatus() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => api.get<{ running: boolean; label: string | null; runs: any[] }>('/api/sync/status'),
    refetchInterval: (query) => (query.state.data?.running ? 3000 : 20000),
  });
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (q.data?.running) setWasRunning(true);
    else if (wasRunning) {
      setWasRunning(false);
      qc.invalidateQueries();
      toast('Sync finished — data refreshed.');
    }
  }, [q.data?.running, wasRunning, qc]);
  return q.data;
}

function Nav({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api.get<any[]>('/api/queues'), refetchInterval: 60_000 });
  const link = (to: string, icon: React.ReactNode, label: string, n?: number) => (
    <NavLink to={to} onClick={onNavigate} end={to === '/'}>
      {icon}
      {label}
      {n !== undefined && <span className="count">{n}</span>}
    </NavLink>
  );
  return (
    <nav className={`nav ${open ? 'open' : ''}`} aria-label="Main">
      <div className="nav-brand">
        <img src="/favicon.svg" width={26} height={26} alt="" />
        <div>
          GovCheck
          <small>Opportunity intelligence</small>
        </div>
      </div>
      {link('/', <LayoutDashboard size={15} />, 'Dashboard')}
      {link('/pipeline', <KanbanSquare size={15} />, 'Capture pipeline')}
      {link('/search', <Crosshair size={15} />, 'Targeted search')}
      <div className="nav-section">Work queues</div>
      {(queues.data ?? []).map((q) => (
        <NavLink key={q.slug} to={`/opportunities?queue=${q.slug}`} onClick={onNavigate} className={() => (new URLSearchParams(window.location.search).get('queue') === q.slug && window.location.pathname === '/opportunities' ? 'active' : '')}>
          <ListFilter size={13} style={{ opacity: 0.6 }} />
          {q.name}
          <span className="count">{q.count}</span>
        </NavLink>
      ))}
      <div className="nav-section">Intelligence</div>
      {link('/coverage', <ShieldAlert size={15} />, 'Coverage gaps')}
      {link('/expiring', <CalendarClock size={15} />, 'Expiring contracts')}
      {link('/quality', <Gauge size={15} />, 'Data quality')}
      {link('/changes', <Activity size={15} />, 'Recent changes')}
      {link('/merge', <GitMerge size={15} />, 'Merge review')}
      {link('/agencies', <Building2 size={15} />, 'Agencies & offices')}
      {link('/vendors', <Users size={15} />, 'Vendors & incumbents')}
      {link('/learning', <Brain size={15} />, 'Preference learning')}
      <div className="nav-section">Setup</div>
      {link('/company', <UserCog size={15} />, 'Company profile')}
      {link('/onboarding', <Rocket size={15} />, 'Setup guide')}
      {link('/sources', <Database size={15} />, 'Sources & sync')}
      <div className="nav-footer">Inferred values are always labeled. Official data is never overwritten by estimates or AI.</div>
    </nav>
  );
}

function Topbar({ onMenu }: { onMenu: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [q, setQ] = useState('');
  const status = useSyncStatus();
  useEffect(() => {
    if (location.pathname !== '/opportunities') setQ('');
  }, [location.pathname]);
  return (
    <header className="topbar">
      <button className="btn ghost mobile-only" onClick={onMenu} aria-label="Menu">
        <Menu size={16} />
      </button>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          navigate(`/opportunities?queue=all&q=${encodeURIComponent(q)}`);
        }}
      >
        <Search size={15} />
        <input type="search" placeholder="Search title, scope, solicitation #, notice ID, PIID, agency, incumbent…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search opportunities" />
      </form>
      <div style={{ flex: 1 }} />
      {status?.running ? (
        <span className="row small muted" title={status.label ?? ''}>
          <span className="spinner" /> {status.label}
          {status.runs?.[0] && <span className="num">· {status.runs[0].records_retrieved} retrieved</span>}
        </span>
      ) : (
        <DataFreshness />
      )}
    </header>
  );
}

/**
 * Signing in only shows what the shared database already holds. Sources are checked on a
 * schedule; the manual controls live on Sources & sync.
 */
function DataFreshness() {
  const o = useQuery({ queryKey: ['sync-overview'], queryFn: () => api.get<any>('/api/sync/overview'), refetchInterval: 60_000 });
  if (!o.data) return null;
  const next = o.data.nextScheduledCheck;
  return (
    <NavLink to="/sources" className="small muted hide-mobile" title="Sources & sync" style={{ textDecoration: 'none' }}>
      <RefreshCw size={12} style={{ verticalAlign: '-1px' }} /> {o.data.dataCurrentAsOf ? `Data current as of ${relative(o.data.dataCurrentAsOf)}` : 'No source data synced yet'}
      {next && <> · next check {next === 'now' ? 'due now' : relative(next)}</>}
    </NavLink>
  );
}

/** Shown while a sleeping free-tier server wakes up (or the database is briefly unreachable). */
function WakingUp({ attempt }: { attempt: number }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 24, textAlign: 'center' }}>
      <div className="card" style={{ padding: 24, maxWidth: 420 }}>
        <div className="row" style={{ justifyContent: 'center', marginBottom: 10 }}>
          <span className="spinner" /> <strong>Connecting to GovCheck…</strong>
        </div>
        <p className="small muted">The server goes to sleep when nobody has used it for a while and takes up to a minute to wake up. This page keeps trying automatically{attempt > 1 ? ` (attempt ${attempt})` : ''}.</p>
      </div>
    </div>
  );
}

export function App() {
  const [navOpen, setNavOpen] = useState(false);
  const [unauth, setUnauth] = useState(false);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ authRequired: boolean; authenticated: boolean }>('/api/auth/me'),
    // A waking server answers 503 (or not at all) for up to a minute: keep retrying quietly.
    retry: (count, err) => count < 60 && (!(err instanceof ApiError) || err.status >= 500),
    retryDelay: 3000,
  });
  useEffect(() => {
    const h = () => setUnauth(true);
    window.addEventListener('goi:unauthorized', h);
    return () => window.removeEventListener('goi:unauthorized', h);
  }, []);
  useEffect(() => {
    api.post('/api/session/visit').catch(() => undefined);
  }, []);

  if (me.isLoading) return me.failureCount > 0 ? <WakingUp attempt={me.failureCount} /> : null;
  if (me.isError) return <WakingUp attempt={me.failureCount} />;
  if ((me.data?.authRequired && !me.data.authenticated) || unauth) return <LoginPage onDone={() => window.location.reload()} />;

  return (
    <div className="shell">
      <Nav open={navOpen} onNavigate={() => setNavOpen(false)} />
      <div className="main">
        <Topbar onMenu={() => setNavOpen((v) => !v)} />
        <main className="content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/opportunities" element={<OpportunitiesPage />} />
            <Route path="/opportunities/:id" element={<OpportunityDetailPage />} />
            <Route path="/opportunities/:id/brief" element={<CaptureBriefPage />} />
            <Route path="/company" element={<CompanyPage />} />
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/coverage" element={<CoveragePage />} />
            <Route path="/pipeline" element={<PipelinePage />} />
            <Route path="/quality" element={<DataQualityPage />} />
            <Route path="/expiring" element={<ExpiringPage />} />
            <Route path="/changes" element={<ChangesPage />} />
            <Route path="/merge" element={<MergeReviewPage />} />
            <Route path="/agencies" element={<AgenciesPage />} />
            <Route path="/agencies/:id" element={<AgencyDetailPage />} />
            <Route path="/vendors" element={<VendorsPage />} />
            <Route path="/vendors/:id" element={<VendorDetailPage />} />
            <Route path="/learning" element={<LearningPage />} />
            <Route path="/search" element={<TargetedSearchPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <ToastHost />
    </div>
  );
}
