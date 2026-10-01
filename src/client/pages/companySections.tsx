import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CLEARANCE_LABELS, CLEARANCE_LEVELS, DEFAULT_SCORE_WEIGHTS, SCORE_COMPONENTS, SCORE_COMPONENT_LABELS, STAGES, STAGE_LABELS } from '../../shared/domain';
import { api } from '../api';
import { money } from '../format';
import { Card, ErrorBox, ListInput, Loading, Modal, toast } from '../components/ui';

export function useCompany() {
  return useQuery({ queryKey: ['company'], queryFn: () => api.get<any>('/api/company') });
}

function useRescorePrompt() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['company'] });
    api
      .post('/api/company/rescore')
      .then((r: any) => toast(r.started ? 'Saved. Re-scoring all opportunities against the updated profile…' : `Saved. ${r.message}`))
      .catch(() => toast('Saved.'));
  };
}

/** Generic profile-field editor: renders children with local state and saves the patch. */
function ProfileForm({ fields, children }: { fields: string[]; children: (v: any, set: (k: string, val: any) => void) => React.ReactNode }) {
  const company = useCompany();
  const after = useRescorePrompt();
  const [v, setV] = useState<any>(null);
  useEffect(() => {
    if (company.data && !v) setV(Object.fromEntries(fields.map((f) => [f, company.data.profile[f]])));
  }, [company.data, v, fields]);
  const save = useMutation({ mutationFn: () => api.put('/api/company', v), onSuccess: after, onError: (e: Error) => toast(e.message) });
  if (company.isLoading || !v) return <Loading />;
  if (company.error) return <ErrorBox error={company.error} />;
  return (
    <div className="stack">
      {children(v, (k, val) => setV((x: any) => ({ ...x, [k]: val })))}
      <div>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </button>
      </div>
    </div>
  );
}

const num = (s: string) => (s === '' ? null : Number(s));

export function CompanyInfoSection() {
  return (
    <ProfileForm fields={['name', 'website', 'uei', 'cage', 'business_size', 'sam_registration_status', 'sam_registration_expires', 'include_grants', 'security_clearances', 'facility_clearance']}>
      {(v, set) => (
        <>
          <div className="form-grid">
            <label className="field">
              Company name
              <input type="text" value={v.name ?? ''} onChange={(e) => set('name', e.target.value || null)} />
            </label>
            <label className="field">
              Website
              <input type="url" value={v.website ?? ''} placeholder="https://" onChange={(e) => set('website', e.target.value || null)} />
            </label>
            <label className="field">
              UEI
              <input type="text" value={v.uei ?? ''} onChange={(e) => set('uei', e.target.value || null)} />
            </label>
            <label className="field">
              CAGE
              <input type="text" value={v.cage ?? ''} onChange={(e) => set('cage', e.target.value || null)} />
            </label>
            <label className="field">
              Business size (primary NAICS)
              <select value={v.business_size ?? ''} onChange={(e) => set('business_size', e.target.value || null)}>
                <option value="">Not set</option>
                <option value="small">Small</option>
                <option value="other_than_small">Other than small</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label className="field">
              SAM registration status
              <select value={v.sam_registration_status ?? ''} onChange={(e) => set('sam_registration_status', e.target.value || null)}>
                <option value="">Not set</option>
                <option value="active">Active</option>
                <option value="pending">Pending</option>
                <option value="inactive">Inactive / expired</option>
                <option value="not_registered">Not registered</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label className="field">
              SAM registration expires
              <input type="date" value={v.sam_registration_expires ?? ''} onChange={(e) => set('sam_registration_expires', e.target.value || null)} />
            </label>
            <label className="field">
              Facility clearance
              <select value={v.facility_clearance ?? ''} onChange={(e) => set('facility_clearance', e.target.value || null)}>
                <option value="">Not set</option>
                <option value="none">None</option>
                <option value="confidential">Confidential</option>
                <option value="secret">Secret</option>
                <option value="top_secret">Top Secret</option>
              </select>
            </label>
          </div>
          <label className="field">Personnel clearance levels your staff hold (confirmed)</label>
          <div className="chips">
            {CLEARANCE_LEVELS.filter((c) => c !== 'none').map((c) => (
              <span key={c} className={`chip ${(v.security_clearances ?? []).includes(c) ? 'on' : ''}`} onClick={() => set('security_clearances', (v.security_clearances ?? []).includes(c) ? v.security_clearances.filter((x: string) => x !== c) : [...(v.security_clearances ?? []), c])}>
                {CLEARANCE_LABELS[c]}
              </span>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={!!v.include_grants} onChange={(e) => set('include_grants', e.target.checked)} /> Include grants / funding opportunities (Grants.gov)
          </label>
        </>
      )}
    </ProfileForm>
  );
}

export function PreferencesSection({ part }: { part?: 'work' | 'size' | 'locations' } = {}) {
  const show = (p: 'work' | 'size' | 'locations') => !part || part === p;
  return (
    <ProfileForm
      fields={[
        'prime_sub_preference',
        'min_contract_value',
        'preferred_max_value',
        'max_realistic_value',
        'preferred_duration_months',
        'team_capacity',
        'remote_capable',
        'onsite_capable',
        'travel_willingness',
        'geographic_service_area',
        'preferred_locations',
        'excluded_locations',
        'preferred_agencies',
        'excluded_agencies',
        'preferred_opportunity_types',
        'excluded_opportunity_types',
        'keywords',
        'negative_keywords',
      ]}
    >
      {(v, set) => (
        <>
          {show('size') && (<>
          <h3>Contract size & capacity</h3>
          <div className="form-grid">
            <label className="field">
              Minimum worthwhile value ($)
              <input type="number" value={v.min_contract_value ?? ''} onChange={(e) => set('min_contract_value', num(e.target.value))} />
            </label>
            <label className="field">
              Preferred maximum ($)
              <input type="number" value={v.preferred_max_value ?? ''} onChange={(e) => set('preferred_max_value', num(e.target.value))} />
            </label>
            <label className="field">
              Maximum realistic project size ($)
              <input type="number" value={v.max_realistic_value ?? ''} onChange={(e) => set('max_realistic_value', num(e.target.value))} />
            </label>
            <label className="field">
              Preferred duration (months)
              <input type="number" value={v.preferred_duration_months ?? ''} onChange={(e) => set('preferred_duration_months', num(e.target.value))} />
            </label>
            <label className="field">
              Team capacity (people)
              <input type="number" value={v.team_capacity ?? ''} onChange={(e) => set('team_capacity', num(e.target.value))} />
            </label>
            <label className="field">
              Prime vs subcontract
              <select value={v.prime_sub_preference ?? ''} onChange={(e) => set('prime_sub_preference', e.target.value || null)}>
                <option value="">No preference set</option>
                <option value="prime">Prefer prime</option>
                <option value="sub">Prefer subcontract</option>
                <option value="either">Either</option>
              </select>
            </label>
          </div>
          <p className="small muted">
            Current: min {money(v.min_contract_value)} · preferred max {money(v.preferred_max_value)} · realistic max {money(v.max_realistic_value)}
          </p>
          </>)}
          {show('locations') && (<>
          <h3>Delivery & locations</h3>
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={!!v.remote_capable} onChange={(e) => set('remote_capable', e.target.checked)} /> Remote delivery
            </label>
            <label className="check">
              <input type="checkbox" checked={v.onsite_capable !== false} onChange={(e) => set('onsite_capable', e.target.checked)} /> On-site delivery possible
            </label>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center' }}>
              Travel willingness
              <select value={v.travel_willingness ?? ''} onChange={(e) => set('travel_willingness', e.target.value || null)}>
                <option value="">Not set</option>
                <option value="none">None</option>
                <option value="limited">Limited</option>
                <option value="regional">Regional</option>
                <option value="national">National</option>
              </select>
            </label>
          </div>
          <div className="grid grid-3">
            <label className="field">
              Geographic service area (states/cities)
              <ListInput value={v.geographic_service_area ?? []} onChange={(x) => set('geographic_service_area', x)} placeholder="e.g. VA, MD, DC" />
            </label>
            <label className="field">
              Preferred locations
              <ListInput value={v.preferred_locations ?? []} onChange={(x) => set('preferred_locations', x)} />
            </label>
            <label className="field">
              Excluded locations
              <ListInput value={v.excluded_locations ?? []} onChange={(x) => set('excluded_locations', x)} />
            </label>
          </div>
          </>)}
          {show('work') && (<>
          <h3>Agencies</h3>
          <div className="grid grid-2">
            <label className="field">
              Preferred agencies
              <ListInput value={v.preferred_agencies ?? []} onChange={(x) => set('preferred_agencies', x)} placeholder="e.g. Federal Aviation Administration" />
            </label>
            <label className="field">
              Excluded agencies
              <ListInput value={v.excluded_agencies ?? []} onChange={(x) => set('excluded_agencies', x)} />
            </label>
          </div>
          <h3>Opportunity types</h3>
          <div className="grid grid-2">
            {(['preferred_opportunity_types', 'excluded_opportunity_types'] as const).map((k) => (
              <div key={k}>
                <div className="small" style={{ fontWeight: 500, marginBottom: 4 }}>{k.startsWith('preferred') ? 'Preferred' : 'Excluded'} stages</div>
                <div className="chips">
                  {STAGES.filter((s) => s !== 'other').map((s) => (
                    <span key={s} className={`chip ${k.startsWith('excluded') ? 'neg' : ''} ${(v[k] ?? []).includes(s) ? 'on' : ''}`} onClick={() => set(k, (v[k] ?? []).includes(s) ? v[k].filter((x: string) => x !== s) : [...(v[k] ?? []), s])}>
                      {STAGE_LABELS[s]}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <h3>Keywords</h3>
          <div className="grid grid-2">
            <label className="field">
              Keywords (boost)
              <ListInput value={v.keywords ?? []} onChange={(x) => set('keywords', x)} />
            </label>
            <label className="field">
              Negative keywords (penalize)
              <ListInput value={v.negative_keywords ?? []} onChange={(x) => set('negative_keywords', x)} />
            </label>
          </div>
          </>)}
        </>
      )}
    </ProfileForm>
  );
}

export function WeightsSection() {
  return (
    <ProfileForm fields={['scoring_weights']}>
      {(v, set) => {
        const w = { ...DEFAULT_SCORE_WEIGHTS, ...(v.scoring_weights ?? {}) };
        const total = SCORE_COMPONENTS.reduce((s, c) => s + Number(w[c] ?? 0), 0);
        return (
          <>
            <p className="small muted">Base fit is the weighted sum of these components, normalized to 100. Total weight: {total}.</p>
            <div className="form-grid">
              {SCORE_COMPONENTS.map((c) => (
                <label key={c} className="field">
                  {SCORE_COMPONENT_LABELS[c]} (default {DEFAULT_SCORE_WEIGHTS[c]})
                  <input type="number" min={0} max={100} value={w[c]} onChange={(e) => set('scoring_weights', { ...w, [c]: Number(e.target.value) })} />
                </label>
              ))}
            </div>
            <button className="btn sm" onClick={() => set('scoring_weights', null)}>
              Reset to defaults
            </button>
          </>
        );
      }}
    </ProfileForm>
  );
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------
export function CapabilitiesSection() {
  const qc = useQueryClient();
  const caps = useQuery({ queryKey: ['capabilities'], queryFn: () => api.get<any[]>('/api/capabilities') });
  const company = useCompany();
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<any | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newKeywords, setNewKeywords] = useState<string[]>([]);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['capabilities'] });
  const setCap = useMutation({ mutationFn: ({ id, body }: { id: string; body: any }) => api.put(`/api/company/capabilities/${id}`, body), onSuccess: invalidate });
  const unset = useMutation({ mutationFn: (id: string) => api.del(`/api/company/capabilities/${id}`), onSuccess: invalidate });
  const suggest = useMutation({
    mutationFn: () => api.post<any>('/api/company/suggest-capabilities', {}),
    onSuccess: (r) => {
      toast(r.suggestions.length ? `${r.suggestions.length} capabilities suggested from ${r.source}. Review and confirm them below.` : 'No new capabilities found on the website.');
      invalidate();
    },
    onError: (e: Error) => toast(e.message),
  });
  const addCustom = useMutation({
    mutationFn: () => api.post('/api/capabilities', { name: newName, parent_id: adding === 'custom' ? null : adding, keywords: newKeywords }),
    onSuccess: () => {
      setAdding(null);
      setNewName('');
      setNewKeywords([]);
      invalidate();
    },
    onError: (e: Error) => toast(e.message),
  });
  const counts = useMemo(() => {
    const all = (caps.data ?? []).flatMap((c) => c.children);
    return { confirmed: all.filter((c: any) => c.status === 'confirmed').length, suggested: all.filter((c: any) => c.status === 'suggested').length };
  }, [caps.data]);

  if (caps.isLoading) return <Loading />;
  if (caps.error) return <ErrorBox error={caps.error} />;
  return (
    <div>
      <div className="spread" style={{ marginBottom: 10 }}>
        <div className="row">
          <input type="search" placeholder="Filter capabilities" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <span className="small muted">
            {counts.confirmed} confirmed{counts.suggested ? ` · ${counts.suggested} suggested (awaiting your confirmation)` : ''}
          </span>
        </div>
        <button className="btn sm" onClick={() => suggest.mutate()} disabled={suggest.isPending || !company.data?.profile?.website} title={company.data?.profile?.website ? 'Read your website and propose capabilities (you confirm each one)' : 'Add your website in Company info first'}>
          {suggest.isPending ? <span className="spinner" /> : null} Suggest from our website
        </button>
      </div>
      <p className="small muted">Check what the company can actually do. Suggestions are never counted until you confirm them. Strength (1–5) weights matching.</p>
      {caps.data!.map((cat) => {
        const items = cat.children.filter((c: any) => !filter || c.name.toLowerCase().includes(filter.toLowerCase()));
        if (!items.length && filter) return null;
        const on = cat.children.filter((c: any) => c.status === 'confirmed').length;
        return (
          <details key={cat.id} className="cap-cat" open={!!filter || on > 0}>
            <summary>
              {cat.name} <span className="badge neutral">{on}/{cat.children.length}</span>
            </summary>
            {items.map((c: any) => (
              <div key={c.id} className={`cap-item ${c.status === 'suggested' ? 'suggested' : ''}`}>
                <label className="check">
                  <input type="checkbox" checked={c.status === 'confirmed'} onChange={(e) => (e.target.checked ? setCap.mutate({ id: c.id, body: { status: 'confirmed', strength: c.strength ?? 3, years_experience: c.years_experience, notes: c.notes, technologies: c.technologies ?? [] } }) : unset.mutate(c.id))} />
                  {c.name} {c.is_custom && <span className="badge outline">custom</span>}
                </label>
                <select
                  value={c.status === 'confirmed' ? c.strength ?? 3 : ''}
                  disabled={c.status !== 'confirmed'}
                  onChange={(e) => setCap.mutate({ id: c.id, body: { status: 'confirmed', strength: Number(e.target.value), years_experience: c.years_experience, notes: c.notes, technologies: c.technologies ?? [] } })}
                  aria-label="Strength"
                >
                  <option value="">Strength</option>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n} — {['basic', 'working', 'solid', 'strong', 'expert'][n - 1]}
                    </option>
                  ))}
                </select>
                <span className="small muted">{c.years_experience ? `${c.years_experience} yrs` : ''}</span>
                <div className="row small" style={{ justifyContent: 'flex-end' }}>
                  {c.status === 'suggested' && (
                    <>
                      <span className="muted">{c.suggested_reason}</span>
                      <button className="btn sm" onClick={() => setCap.mutate({ id: c.id, body: { status: 'confirmed', strength: 3 } })}>
                        Confirm
                      </button>
                      <button className="btn ghost sm" onClick={() => setCap.mutate({ id: c.id, body: { status: 'rejected' } })}>
                        Reject
                      </button>
                    </>
                  )}
                  {c.status === 'confirmed' && (
                    <button className="btn ghost sm" onClick={() => setEditing(c)}>
                      Details
                    </button>
                  )}
                </div>
              </div>
            ))}
            <div className="cap-item">
              <button className="btn ghost sm" onClick={() => setAdding(cat.id)}>
                + Add custom capability
              </button>
            </div>
          </details>
        );
      })}
      {editing && <CapabilityDetails cap={editing} onClose={() => setEditing(null)} onSave={(body) => setCap.mutate({ id: editing.id, body }, { onSuccess: () => setEditing(null) })} />}
      {adding && (
        <Modal
          title="Add custom capability"
          onClose={() => setAdding(null)}
          footer={
            <button className="btn primary" disabled={newName.trim().length < 2} onClick={() => addCustom.mutate()}>
              Add & confirm
            </button>
          }
        >
          <label className="field">
            Name
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          </label>
          <label className="field" style={{ marginTop: 10 }}>
            Match keywords / synonyms
            <ListInput value={newKeywords} onChange={setNewKeywords} placeholder="Phrases that indicate this work" />
          </label>
        </Modal>
      )}
    </div>
  );
}

function CapabilityDetails({ cap, onClose, onSave }: { cap: any; onClose: () => void; onSave: (body: any) => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState({ strength: cap.strength ?? 3, years_experience: cap.years_experience ?? '', notes: cap.notes ?? '', technologies: cap.technologies ?? [], staff_qualifications: cap.staff_qualifications ?? '', evidence: cap.evidence ?? '' });
  const [keywords, setKeywords] = useState<string[]>(cap.keywords ?? []);
  return (
    <Modal
      title={cap.name}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          onClick={async () => {
            await api.put(`/api/capabilities/${cap.id}`, { keywords });
            qc.invalidateQueries({ queryKey: ['capabilities'] });
            onSave({ status: 'confirmed', strength: Number(v.strength), years_experience: v.years_experience === '' ? null : Number(v.years_experience), notes: v.notes || null, technologies: v.technologies, staff_qualifications: v.staff_qualifications || null, evidence: v.evidence || null });
          }}
        >
          Save
        </button>
      }
    >
      <div className="form-grid">
        <label className="field">
          Strength (1–5)
          <input type="number" min={1} max={5} value={v.strength} onChange={(e) => setV({ ...v, strength: Number(e.target.value) })} />
        </label>
        <label className="field">
          Years of experience
          <input type="number" min={0} value={v.years_experience} onChange={(e) => setV({ ...v, years_experience: e.target.value })} />
        </label>
      </div>
      <label className="field" style={{ marginTop: 10 }}>
        Technologies
        <ListInput value={v.technologies} onChange={(t) => setV({ ...v, technologies: t })} />
      </label>
      <label className="field" style={{ marginTop: 10 }}>
        Match keywords (what to look for in opportunity text)
        <ListInput value={keywords} onChange={setKeywords} />
      </label>
      <label className="field" style={{ marginTop: 10 }}>
        Relevant staff / qualifications
        <textarea rows={2} value={v.staff_qualifications} onChange={(e) => setV({ ...v, staff_qualifications: e.target.value })} />
      </label>
      <label className="field" style={{ marginTop: 10 }}>
        Evidence / past performance
        <textarea rows={2} value={v.evidence} onChange={(e) => setV({ ...v, evidence: e.target.value })} />
      </label>
      <label className="field" style={{ marginTop: 10 }}>
        Notes
        <textarea rows={2} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} />
      </label>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// NAICS / PSC
// ---------------------------------------------------------------------------
export function CodesSection() {
  const company = useCompany();
  const after = useRescorePrompt();
  const [naics, setNaics] = useState<{ code: string; description?: string | null; is_primary?: boolean }[] | null>(null);
  const [psc, setPsc] = useState<{ code: string; description?: string | null }[] | null>(null);
  const [draft, setDraft] = useState({ naics: '', psc: '' });
  useEffect(() => {
    if (company.data && naics === null) {
      setNaics(company.data.naics.map((n: any) => ({ code: n.code, description: n.description, is_primary: n.is_primary })));
      setPsc(company.data.psc.map((n: any) => ({ code: n.code, description: n.description })));
    }
  }, [company.data, naics]);
  const save = useMutation({
    mutationFn: async () => {
      await api.put('/api/company/naics', { codes: naics });
      await api.put('/api/company/psc', { codes: psc });
    },
    onSuccess: after,
    onError: (e: Error) => toast(e.message),
  });
  if (!naics || !psc) return <Loading />;
  return (
    <div className="grid grid-2">
      <div className="stack">
        <h3>NAICS codes</h3>
        <p className="small muted">Your industry codes drive discovery (award history scans, recompete detection) and alignment scoring.</p>
        {naics.map((n) => (
          <div key={n.code} className="spread">
            <span>
              <span className="mono">{n.code}</span> {n.description} {n.is_primary && <span className="badge info">primary</span>}
            </span>
            <span className="row">
              {!n.is_primary && (
                <button className="btn ghost sm" onClick={() => setNaics(naics.map((x) => ({ ...x, is_primary: x.code === n.code })))}>
                  Make primary
                </button>
              )}
              <button className="btn ghost sm danger" onClick={() => setNaics(naics.filter((x) => x.code !== n.code))}>
                Remove
              </button>
            </span>
          </div>
        ))}
        <div className="row">
          <input type="text" placeholder="e.g. 541511" value={draft.naics} onChange={(e) => setDraft({ ...draft, naics: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
          <button className="btn sm" disabled={draft.naics.length < 2} onClick={() => (setNaics([...naics.filter((x) => x.code !== draft.naics), { code: draft.naics, is_primary: !naics.length }]), setDraft({ ...draft, naics: '' }))}>
            Add NAICS
          </button>
        </div>
        <p className="small muted">Common IT/professional services: 541511 custom programming · 541512 systems design · 541513 facilities mgmt · 541519 other IT · 518210 data processing/hosting · 541611 management consulting · 541618 other consulting · 541690 technical consulting · 611430 training.</p>
      </div>
      <div className="stack">
        <h3>PSC preferences</h3>
        {psc.map((n) => (
          <div key={n.code} className="spread">
            <span>
              <span className="mono">{n.code}</span> {n.description}
            </span>
            <button className="btn ghost sm danger" onClick={() => setPsc(psc.filter((x) => x.code !== n.code))}>
              Remove
            </button>
          </div>
        ))}
        <div className="row">
          <input type="text" placeholder="e.g. DA01" value={draft.psc} onChange={(e) => setDraft({ ...draft, psc: e.target.value.toUpperCase().slice(0, 4) })} />
          <button className="btn sm" disabled={!draft.psc} onClick={() => (setPsc([...psc.filter((x) => x.code !== draft.psc), { code: draft.psc }]), setDraft({ ...draft, psc: '' }))}>
            Add PSC
          </button>
        </div>
        <p className="small muted">Examples: DA01 IT application development · DA10 IT data/analytics · DF01 IT management support · R408 program management support · R499 other professional services · U008 training.</p>
      </div>
      <div>
        <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>
          Save codes
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Certifications & vehicles
// ---------------------------------------------------------------------------
export function CertificationsSection() {
  const company = useCompany();
  const qc = useQueryClient();
  const after = useRescorePrompt();
  const [state, setState] = useState<Record<string, string> | null>(null);
  const [vehicle, setVehicle] = useState({ name: '', vehicle_type: '', contract_number: '', role: 'prime' });
  useEffect(() => {
    if (company.data && !state) setState(Object.fromEntries(company.data.certificationTypes.map((c: any) => [c.code, company.data.certifications.find((x: any) => x.cert_type === c.code)?.status ?? 'unknown'])));
  }, [company.data, state]);
  const save = useMutation({ mutationFn: () => api.put('/api/company/certifications', { items: Object.entries(state!).map(([cert_type, status]) => ({ cert_type, status })) }), onSuccess: after });
  const addVehicle = useMutation({ mutationFn: () => api.post('/api/company/vehicles', vehicle), onSuccess: () => (setVehicle({ name: '', vehicle_type: '', contract_number: '', role: 'prime' }), qc.invalidateQueries({ queryKey: ['company'] })) });
  const delVehicle = useMutation({ mutationFn: (id: string) => api.del(`/api/company/vehicles/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['company'] }) });
  if (!state || !company.data) return <Loading />;
  return (
    <div className="grid grid-2">
      <div>
        <h3>Socio-economic certifications</h3>
        <p className="small muted">Only mark “Held” for statuses you have actually confirmed. Unknown is treated as “verify” — never as eligible or ineligible.</p>
        <table className="data">
          <tbody>
            {company.data.certificationTypes.map((c: any) => (
              <tr key={c.code}>
                <td>{c.label}</td>
                <td>
                  <select value={state[c.code]} onChange={(e) => setState({ ...state, [c.code]: e.target.value })}>
                    <option value="unknown">Unknown / not set</option>
                    <option value="held">Held (confirmed)</option>
                    <option value="pending">Pending</option>
                    <option value="not_held">Not held</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="btn primary" style={{ marginTop: 10 }} onClick={() => save.mutate()}>
          Save certifications
        </button>
      </div>
      <div>
        <h3>Contract vehicles</h3>
        {company.data.vehicles.map((v: any) => (
          <div key={v.id} className="spread" style={{ padding: '3px 0' }}>
            <span>
              <strong>{v.name}</strong> <span className="muted small">{[v.vehicle_type, v.contract_number, v.role].filter(Boolean).join(' · ')}</span>
            </span>
            <button className="btn ghost sm danger" onClick={() => delVehicle.mutate(v.id)}>
              Remove
            </button>
          </div>
        ))}
        {!company.data.vehicles.length && <p className="muted small">No vehicles. Orders under vehicles you don’t hold are flagged as eligibility concerns.</p>}
        <div className="form-grid" style={{ marginTop: 8 }}>
          <input type="text" placeholder="Vehicle (e.g. GSA MAS, OASIS+, 8(a) STARS III)" value={vehicle.name} onChange={(e) => setVehicle({ ...vehicle, name: e.target.value })} />
          <input type="text" placeholder="Type (GWAC, IDIQ, BPA…)" value={vehicle.vehicle_type} onChange={(e) => setVehicle({ ...vehicle, vehicle_type: e.target.value })} />
          <input type="text" placeholder="Contract number" value={vehicle.contract_number} onChange={(e) => setVehicle({ ...vehicle, contract_number: e.target.value })} />
          <select value={vehicle.role} onChange={(e) => setVehicle({ ...vehicle, role: e.target.value })}>
            <option value="prime">Prime holder</option>
            <option value="sub">Team member / sub</option>
          </select>
        </div>
        <button className="btn sm" style={{ marginTop: 8 }} disabled={!vehicle.name} onClick={() => addVehicle.mutate()}>
          Add vehicle
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Past performance
// ---------------------------------------------------------------------------
const EMPTY_PP = { project_name: '', client: '', agency: '', is_government: true, start_date: '', end_date: '', dollar_value: '', role: 'prime', naics: [] as string[], psc: [] as string[], technologies: [] as string[], capability_ids: [] as string[], description: '', outcomes: '', contract_number: '', reference_name: '', reference_contact: '' };

export function PastPerformanceSection() {
  const company = useCompany();
  const caps = useQuery({ queryKey: ['capabilities'], queryFn: () => api.get<any[]>('/api/capabilities') });
  const qc = useQueryClient();
  const after = useRescorePrompt();
  const [editing, setEditing] = useState<any | null>(null);
  const confirmedCaps = (caps.data ?? []).flatMap((c) => c.children).filter((c: any) => c.status === 'confirmed');
  const save = useMutation({
    mutationFn: (p: any) => {
      const body = { ...p, dollar_value: p.dollar_value === '' || p.dollar_value == null ? null : Number(p.dollar_value), start_date: p.start_date || null, end_date: p.end_date || null };
      return p.id ? api.put(`/api/company/past-performance/${p.id}`, body) : api.post('/api/company/past-performance', body);
    },
    onSuccess: () => {
      setEditing(null);
      after();
    },
    onError: (e: Error) => toast(e.message),
  });
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/company/past-performance/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['company'] }) });
  if (!company.data) return <Loading />;
  return (
    <div>
      <div className="spread" style={{ marginBottom: 8 }}>
        <p className="small muted">Past performance is a major matching component: similar scope, same agency, same NAICS and comparable size all raise fit.</p>
        <button className="btn primary sm" onClick={() => setEditing({ ...EMPTY_PP })}>
          + Add project
        </button>
      </div>
      {company.data.pastPerformance.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Project</th>
              <th>Client / agency</th>
              <th>Role</th>
              <th>Value</th>
              <th>Dates</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {company.data.pastPerformance.map((p: any) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.project_name}</strong>
                  <div className="small muted truncate" style={{ maxWidth: 360 }}>{p.description}</div>
                </td>
                <td className="small">{p.agency ?? p.client}</td>
                <td>{p.role}</td>
                <td className="num">{money(p.dollar_value)}</td>
                <td className="small nowrap">
                  {p.start_date ?? '?'} → {p.end_date ?? 'present'}
                </td>
                <td className="nowrap">
                  <button className="btn ghost sm" onClick={() => setEditing({ ...EMPTY_PP, ...p, dollar_value: p.dollar_value ?? '' })}>
                    Edit
                  </button>
                  <button className="btn ghost sm danger" onClick={() => del.mutate(p.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No projects yet.</p>
      )}
      {editing && (
        <Modal
          title={editing.id ? 'Edit project' : 'Add past performance'}
          onClose={() => setEditing(null)}
          footer={
            <button className="btn primary" disabled={!editing.project_name} onClick={() => save.mutate(editing)}>
              Save
            </button>
          }
        >
          <div className="form-grid">
            {(
              [
                ['project_name', 'Project name', 'text'],
                ['client', 'Client', 'text'],
                ['agency', 'Agency (if government)', 'text'],
                ['contract_number', 'Contract number', 'text'],
                ['start_date', 'Start', 'date'],
                ['end_date', 'End', 'date'],
                ['dollar_value', 'Dollar value', 'number'],
                ['reference_name', 'Reference (optional)', 'text'],
                ['reference_contact', 'Reference contact (optional)', 'text'],
              ] as const
            ).map(([k, l, t]) => (
              <label key={k} className="field">
                {l}
                <input type={t} value={editing[k] ?? ''} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
              </label>
            ))}
            <label className="field">
              Role
              <select value={editing.role ?? 'prime'} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                <option value="prime">Prime</option>
                <option value="sub">Subcontractor</option>
                <option value="commercial">Commercial</option>
              </select>
            </label>
          </div>
          <label className="field" style={{ marginTop: 10 }}>
            Description of work
            <textarea rows={3} value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </label>
          <label className="field" style={{ marginTop: 10 }}>
            Outcomes
            <textarea rows={2} value={editing.outcomes ?? ''} onChange={(e) => setEditing({ ...editing, outcomes: e.target.value })} />
          </label>
          <div className="grid grid-3" style={{ marginTop: 10 }}>
            <label className="field">
              NAICS
              <ListInput value={editing.naics ?? []} onChange={(v) => setEditing({ ...editing, naics: v })} />
            </label>
            <label className="field">
              PSC
              <ListInput value={editing.psc ?? []} onChange={(v) => setEditing({ ...editing, psc: v })} />
            </label>
            <label className="field">
              Technologies
              <ListInput value={editing.technologies ?? []} onChange={(v) => setEditing({ ...editing, technologies: v })} />
            </label>
          </div>
          <div className="field" style={{ marginTop: 10 }}>
            Capabilities demonstrated
            <div className="chips">
              {confirmedCaps.map((c: any) => (
                <span key={c.id} className={`chip ${(editing.capability_ids ?? []).includes(c.id) ? 'on' : ''}`} onClick={() => setEditing({ ...editing, capability_ids: (editing.capability_ids ?? []).includes(c.id) ? editing.capability_ids.filter((x: string) => x !== c.id) : [...(editing.capability_ids ?? []), c.id] })}>
                  {c.name}
                </span>
              ))}
              {!confirmedCaps.length && <span className="muted small">Confirm capabilities first.</span>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <Card title={title}>{children}</Card>;
}
