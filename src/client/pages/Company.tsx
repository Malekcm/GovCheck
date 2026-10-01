import { useState } from 'react';
import { Card } from '../components/ui';
import { CapabilitiesSection, CertificationsSection, CodesSection, CompanyInfoSection, PastPerformanceSection, PreferencesSection, WeightsSection, useCompany } from './companySections';

const TABS = [
  ['info', 'Company & eligibility'],
  ['capabilities', 'Capabilities'],
  ['codes', 'NAICS / PSC'],
  ['certs', 'Certifications & vehicles'],
  ['prefs', 'Preferred work'],
  ['pp', 'Past performance'],
  ['weights', 'Scoring weights'],
] as const;

export function CompanyPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('info');
  const company = useCompany();
  const counts = company.data?.capabilityCounts;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Company profile</h1>
          <p>Everything the matching engine knows about you. You control every value — nothing here is inferred from source data, and certifications are only counted when you confirm them.</p>
        </div>
        <div className="row">
          {counts && (
            <span className="small muted">
              {counts.confirmed} capabilities confirmed · {company.data.naics.length} NAICS · {company.data.pastPerformance.length} past performance
            </span>
          )}
          <a className="btn sm" href="/api/export/backup.json" title="Download everything you created: profile, decisions, notes, tags, links, merges, model history">
            Export backup
          </a>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)} role="tab" aria-selected={tab === k}>
            {l}
          </button>
        ))}
      </div>
      <Card>
        {tab === 'info' && <CompanyInfoSection />}
        {tab === 'capabilities' && <CapabilitiesSection />}
        {tab === 'codes' && <CodesSection />}
        {tab === 'certs' && <CertificationsSection />}
        {tab === 'prefs' && <PreferencesSection />}
        {tab === 'pp' && <PastPerformanceSection />}
        {tab === 'weights' && <WeightsSection />}
      </Card>
    </div>
  );
}
