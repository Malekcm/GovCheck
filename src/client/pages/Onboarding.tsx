import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Card, toast } from '../components/ui';
import { CapabilitiesSection, CertificationsSection, CodesSection, CompanyInfoSection, PastPerformanceSection, PreferencesSection, useCompany } from './companySections';
import { SetupInstructions } from './Sources';

const STEPS = [
  ['Company information', 'Who you are and your registration basics. Everything can be changed later.'],
  ['Capabilities', 'Check what the company can actually do and rate its strength. This drives capability matching.'],
  ['NAICS / PSC', 'Industry and product/service codes used for discovery and alignment.'],
  ['Certifications', 'Only confirm statuses you actually hold. Unknown is treated as “verify”, never assumed.'],
  ['Preferred work', 'Agencies, opportunity types and keywords you want more (or less) of.'],
  ['Contract size', 'Minimum worthwhile value and the largest project you could realistically perform.'],
  ['Locations', 'Where and how you can deliver.'],
  ['Past performance', 'Similar past projects strongly improve matching.'],
  ['Sources / API keys', 'Which government sources are connected and how to add the SAM.gov API key.'],
  ['Initial data sync', 'Pull real data from every connected source.'],
] as const;

export function OnboardingPage() {
  const company = useCompany();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    if (company.data && step === null) setStep(Math.min(company.data.profile.onboarding_step ?? 0, STEPS.length - 1));
  }, [company.data, step]);
  const persist = (s: number, completed = false) => api.put('/api/company/onboarding', { step: s, completed }).catch(() => undefined);
  const go = (s: number) => {
    setStep(s);
    persist(s);
    document.querySelector('.content')?.scrollTo({ top: 0 });
  };
  const sync = useMutation({
    mutationFn: async () => {
      await persist(STEPS.length - 1, true);
      return api.post('/api/sync/all', { mode: 'incremental' });
    },
    onSuccess: () => {
      toast('Initial sync started. Results stream into the dashboard as each source finishes.');
      qc.invalidateQueries();
      navigate('/');
    },
    onError: (e: Error) => toast(e.message),
  });
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<any>('/api/meta') });
  if (step === null) return null;
  const done = !!company.data?.profile.onboarding_completed_at;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Setup guide</h1>
          <p>Ten short steps. Skip anything you don’t know yet and come back later — every field also lives in the Company profile.</p>
        </div>
        {done && <span className="badge good">Setup completed</span>}
      </div>
      <div className="stepper" role="tablist">
        {STEPS.map(([t], i) => (
          <button key={t} className={i === step ? 'current' : i < step ? 'done' : ''} onClick={() => go(i)}>
            {i + 1}. {t}
          </button>
        ))}
      </div>
      <Card title={`${step + 1}. ${STEPS[step][0]}`}>
        <p className="muted">{STEPS[step][1]}</p>
        {step === 0 && <CompanyInfoSection />}
        {step === 1 && <CapabilitiesSection />}
        {step === 2 && <CodesSection />}
        {step === 3 && <CertificationsSection />}
        {step === 4 && <PreferencesSection part="work" />}
        {step === 5 && <PreferencesSection part="size" />}
        {step === 6 && <PreferencesSection part="locations" />}
        {step === 7 && <PastPerformanceSection />}
        {step === 8 && <SetupInstructions config={meta.data?.configuration} />}
        {step === 9 && (
          <div className="stack">
            <p>
              The first sync pulls: SAM.gov notices (if the API key is set; personal keys allow 10 requests/day so the window resumes daily), GSA procurement forecasts, SBA SUBNet subcontracts, Grants.gov (if enabled), and USAspending contracts in your NAICS codes that expire within 18 months — creating recompete intelligence signals. Everything is then consolidated, enriched and scored.
            </p>
            <p className="small muted">The free SAM.gov bulk extract (~220 MB) runs separately as a daily reconciliation; start it from <Link to="/sources">Sources & sync</Link> if you want broad coverage now.</p>
            <div>
              {done ? (
                <div className="callout small">
                  Setup is already complete and GovCheck’s data is shared by the whole team. Sources are checked automatically on a schedule — there is no need to run an initial sync again. See <Link to="/sources">Sources & sync</Link> for status.
                </div>
              ) : (
                <button className="btn primary" onClick={() => sync.mutate()} disabled={sync.isPending}>
                  Finish setup & run initial sync
                </button>
              )}
            </div>
          </div>
        )}
        <hr />
        <div className="spread">
          <button className="btn" disabled={step === 0} onClick={() => go(step - 1)}>
            ← Back
          </button>
          {step < STEPS.length - 1 && (
            <div className="row">
              <button className="btn ghost" onClick={() => go(step + 1)}>
                Skip for now
              </button>
              <button className="btn primary" onClick={() => go(step + 1)}>
                Next →
              </button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
