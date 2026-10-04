import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Bookmark, Download, SlidersHorizontal } from 'lucide-react';
import { DECISIONS, DECISION_LABELS, ELIGIBILITY_LABELS, ELIGIBILITY_STATUSES, PURSUIT_STAGES, PURSUIT_STAGE_LABELS, SET_ASIDE_LABELS, STAGES, STAGE_LABELS } from '../../shared/domain';
import { api, qs } from '../api';
import { OpportunityTable } from '../components/OpportunityTable';
import { Card, Empty, ErrorBox, Loading, ProvenanceLegend, toast } from '../components/ui';

const FILTER_KEYS = [
  'q', 'minFit', 'minPref', 'eligibility', 'decision', 'stage', 'opportunityClass', 'source', 'agency', 'subagency', 'office', 'naics', 'psc', 'setAside', 'vehicle',
  'valueMin', 'valueMax', 'postedFrom', 'postedTo', 'deadlineFrom', 'deadlineTo', 'performanceFrom', 'performanceTo', 'dueWithinDays', 'changedWithinDays', 'state',
  'recompete', 'hasIncumbent', 'hasDocuments', 'newSinceVisit', 'openOnly', 'includeGrants', 'agencyId', 'officeId', 'vendorId', 'maxFit',
  'minAttractiveness', 'minConfidence', 'expiringWithinMonths', 'incumbent', 'noticeType', 'changeType', 'captureStage', 'owner', 'tag', 'status',
] as const;

const CHANGE_TYPES: [string, string][] = [
  ['SCOPE_CHANGED', 'Scope changed'],
  ['DEADLINE_CHANGED', 'Deadline changed'],
  ['DATES_CHANGED', 'Key date changed'],
  ['AMENDMENT', 'Amendment'],
  ['SOLICITATION_RELEASED', 'Solicitation released'],
  ['SET_ASIDE_CHANGED', 'Set-aside changed'],
  ['VALUE_CHANGED', 'Value changed'],
  ['CONTACT_CHANGED', 'Contact changed'],
  ['NEW_DOCUMENT', 'New document'],
  ['QA_PUBLISHED', 'Q&A published'],
  ['AWARD_POSTED', 'Award posted'],
  ['CANCELLED', 'Cancelled'],
  ['INCUMBENT_IDENTIFIED', 'Incumbent identified'],
];

const SOURCES = [
  ['sam_opportunities', 'SAM API'],
  ['sam_bulk', 'SAM bulk'],
  ['gsa_forecast', 'GSA forecast'],
  ['dhs_apfs', 'DHS forecast (APFS)'],
  ['sba_subnet', 'SUBNet'],
  ['grants_gov', 'Grants.gov'],
  ['usaspending', 'USAspending'],
  ['sam_awards', 'SAM awards'],
];

function MultiSelect({ label, options, value, onChange }: { label: string; options: [string, string][]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <label className="field">
      {label}
      <select multiple value={value} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))} style={{ height: 74, minWidth: 150 }}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export function OpportunitiesPage() {
  const [params, setParams] = useSearchParams();
  const [showFilters, setShowFilters] = useState(false);
  const queueSlug = params.get('queue') ?? 'all';
  const queues = useQuery({ queryKey: ['queues'], queryFn: () => api.get<any[]>('/api/queues') });
  const queue = queues.data?.find((q) => q.slug === queueSlug);

  // Effective filters = queue preset overlaid with explicit URL params.
  const filters = useMemo(() => {
    const f: Record<string, any> = { ...(queue?.filters ?? {}) };
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v !== null && v !== '') f[k] = v;
    }
    f.sort = params.get('sort') ?? queue?.sort ?? 'best';
    f.page = Number(params.get('page') ?? 1);
    f.pageSize = 50;
    return f;
  }, [params, queue]);

  const list = useQuery({
    queryKey: ['opportunities', filters],
    queryFn: () => api.get<{ items: any[]; total: number; page: number; pageSize: number }>(`/api/opportunities${qs(filters)}`),
    enabled: !queues.isLoading,
    placeholderData: (prev) => prev,
  });

  const set = (k: string, v: string | string[] | null | undefined) => {
    const next = new URLSearchParams(params);
    const val = Array.isArray(v) ? v.join(',') : v;
    if (val === undefined || val === null || val === '') next.delete(k);
    else next.set(k, val);
    if (k !== 'page') next.delete('page');
    setParams(next);
  };
  const arr = (k: string): string[] => {
    const v = filters[k];
    return v === undefined ? [] : Array.isArray(v) ? v : String(v).split(',').filter(Boolean);
  };
  const exportQs = qs({ ...filters, page: undefined, pageSize: undefined });
  const exportUrl = `/api/opportunities/export.csv${exportQs}`;
  const qc = useQueryClient();
  const saveView = useMutation({
    mutationFn: (name: string) => {
      const { page: _p, pageSize: _s, sort, ...rest } = filters;
      return api.post('/api/queues', { name, filters: rest, sort });
    },
    onSuccess: () => {
      toast('Saved as a work queue (left navigation).');
      qc.invalidateQueries({ queryKey: ['queues'] });
    },
    onError: (e: Error) => toast(e.message),
  });
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{queue?.name ?? 'Opportunities'}</h1>
          <p>{queue?.description || 'Search, filter and export the accumulated opportunity database.'}</p>
        </div>
        <div className="row">
          <ProvenanceLegend />
        </div>
      </div>
      <Card
        bodyClass=""
        title={
          <div className="row">
            <input type="search" placeholder="Keyword, solicitation #, PIID…" defaultValue={filters.q ?? ''} key={filters.q ?? ''} onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value)} style={{ width: 280 }} />
            <select value={filters.sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort">
              <option value="best">Review priority (eligibility-aware)</option>
              <option value="fit">Fit score</option>
              <option value="preference">Personalized score</option>
              <option value="attractiveness">Strategic attractiveness</option>
              <option value="confidence">Data confidence</option>
              <option value="expiring">Period of performance end</option>
              <option value="next_action">Next capture action</option>
              <option value="deadline">Deadline</option>
              <option value="newest">Newest</option>
              <option value="updated">Recently updated</option>
              <option value="value">Value</option>
              <option value="agency">Agency</option>
              <option value="completeness">Data completeness</option>
            </select>
            <button className={`btn sm ${showFilters ? 'active' : ''}`} onClick={() => setShowFilters((v) => !v)}>
              <SlidersHorizontal size={13} /> Filters
            </button>
            <span className="muted small num">{list.isFetching ? 'Loading…' : `${total.toLocaleString()} results`}</span>
          </div>
        }
        actions={
          <>
            <button
              className="btn sm"
              onClick={() => {
                const name = window.prompt('Name this saved search / watchlist:');
                if (name?.trim()) saveView.mutate(name.trim());
              }}
            >
              <Bookmark size={13} /> Save view
            </button>
            <a className="btn sm" href={exportUrl}>
              <Download size={13} /> CSV
            </a>
            <a className="btn sm" href={`/api/opportunities/export.xlsx${exportQs}`}>
              <Download size={13} /> Excel
            </a>
          </>
        }
      >
        {showFilters && (
          <div className="filters">
            <MultiSelect label="Stage" options={STAGES.map((s) => [s, STAGE_LABELS[s]])} value={arr('stage')} onChange={(v) => set('stage', v)} />
            <MultiSelect label="Class" options={[['prime', 'Prime'], ['subcontract', 'Subcontract'], ['grant', 'Grant'], ['intelligence', 'Intelligence signal']]} value={arr('opportunityClass')} onChange={(v) => set('opportunityClass', v)} />
            <MultiSelect label="Decision" options={[['none', 'Unreviewed'], ...DECISIONS.map((d) => [d, DECISION_LABELS[d]] as [string, string])]} value={arr('decision')} onChange={(v) => set('decision', v)} />
            <MultiSelect label="Eligibility" options={ELIGIBILITY_STATUSES.map((s) => [s, ELIGIBILITY_LABELS[s]])} value={arr('eligibility')} onChange={(v) => set('eligibility', v)} />
            <MultiSelect label="Source" options={SOURCES as [string, string][]} value={arr('source')} onChange={(v) => set('source', v)} />
            <MultiSelect label="Set-aside" options={[['NONE', 'None'], ...Object.entries(SET_ASIDE_LABELS)]} value={arr('setAside')} onChange={(v) => set('setAside', v)} />
            <MultiSelect label="Capture stage" options={PURSUIT_STAGES.map((s) => [s, PURSUIT_STAGE_LABELS[s]])} value={arr('captureStage')} onChange={(v) => set('captureStage', v)} />
            <MultiSelect label="Changed (type)" options={CHANGE_TYPES} value={arr('changeType')} onChange={(v) => set('changeType', v)} />
            <MultiSelect label="Status" options={[['active', 'Active'], ['forecast', 'Forecast'], ['signal', 'Signal'], ['closed', 'Closed'], ['archived', 'Archived'], ['awarded', 'Awarded'], ['cancelled', 'Cancelled']]} value={arr('status')} onChange={(v) => set('status', v)} />
            {(
              [
                ['minFit', 'Min fit', 'number'],
                ['minPref', 'Min preference', 'number'],
                ['minAttractiveness', 'Min attractiveness', 'number'],
                ['minConfidence', 'Min confidence', 'number'],
                ['expiringWithinMonths', 'PoP ends within (months)', 'number'],
                ['incumbent', 'Incumbent', 'text'],
                ['noticeType', 'Notice type', 'text'],
                ['owner', 'Capture owner', 'text'],
                ['tag', 'Tag', 'text'],
                ['agency', 'Agency', 'text'],
                ['office', 'Office', 'text'],
                ['naics', 'NAICS (prefix)', 'text'],
                ['psc', 'PSC (prefix)', 'text'],
                ['vehicle', 'Contract vehicle', 'text'],
                ['state', 'State', 'text'],
                ['valueMin', 'Value ≥ $', 'number'],
                ['valueMax', 'Value ≤ $', 'number'],
                ['postedFrom', 'Posted from', 'date'],
                ['postedTo', 'Posted to', 'date'],
                ['deadlineFrom', 'Deadline from', 'date'],
                ['deadlineTo', 'Deadline to', 'date'],
                ['performanceFrom', 'Performance from', 'date'],
                ['performanceTo', 'Performance to', 'date'],
                ['dueWithinDays', 'Due within (days)', 'number'],
                ['changedWithinDays', 'Changed within (days)', 'number'],
              ] as const
            ).map(([k, l, t]) => (
              <label key={k} className="field">
                {l}
                <input type={t} defaultValue={filters[k] ?? ''} key={`${k}-${filters[k] ?? ''}`} onBlur={(e) => set(k, e.target.value)} onKeyDown={(e) => e.key === 'Enter' && set(k, (e.target as HTMLInputElement).value)} style={{ width: t === 'date' ? 140 : 120 }} />
              </label>
            ))}
            <div className="stack" style={{ minWidth: 160 }}>
              {(
                [
                  ['openOnly', 'Open / upcoming only'],
                  ['recompete', 'Recompete signals'],
                  ['hasIncumbent', 'Has incumbent'],
                  ['hasDocuments', 'Has documents'],
                  ['newSinceVisit', 'New since last visit'],
                  ['includeGrants', 'Include grants'],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="check">
                  <input type="checkbox" checked={String(filters[k]) === 'true'} onChange={(e) => set(k, e.target.checked ? 'true' : null)} /> {l}
                </label>
              ))}
            </div>
            <button className="btn sm" onClick={() => setParams(new URLSearchParams({ queue: queueSlug }))}>
              Reset
            </button>
          </div>
        )}
        {list.error ? (
          <div className="card-body">
            <ErrorBox error={list.error} />
          </div>
        ) : list.isLoading ? (
          <Loading />
        ) : list.data?.items.length ? (
          <>
            <OpportunityTable rows={list.data.items} sort={filters.sort} onSort={(s) => set('sort', s)} />
            <div className="pager">
              <button className="btn sm" disabled={filters.page <= 1} onClick={() => set('page', String(filters.page - 1))}>
                ← Prev
              </button>
              <span className="small muted num">
                Page {filters.page} / {pages}
              </span>
              <button className="btn sm" disabled={filters.page >= pages} onClick={() => set('page', String(filters.page + 1))}>
                Next →
              </button>
            </div>
          </>
        ) : (
          <Empty title="Nothing here yet">Adjust filters, or refresh sources to bring in new data.</Empty>
        )}
      </Card>
    </div>
  );
}
