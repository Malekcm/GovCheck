import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { api } from '../api';
import { date } from '../format';
import { Card, ErrorBox, Modal, toast } from '../components/ui';
import { SchemaForm } from '../components/SchemaForm';
import { cleanArguments, fieldsOf, humanize, missingRequired } from '../components/schemaFields';

const GROUPS: [string, string, string][] = [
  ['in_govcheck', 'Already in GovCheck', 'Matched to an existing GovCheck opportunity. Nothing new is created.'],
  ['verifiable', 'New — official record can be verified', 'The result points to a SAM.gov notice. GovCheck can look it up on SAM.gov and ingest the official record.'],
  ['research_leads', 'G2X-only research leads — review required', 'No confirmed official record. Review possible matches, or create your own minimal research lead.'],
];

export function IntegrationsPage() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['g2x-status'], queryFn: () => api.get<any>('/api/g2x/status') });
  const ready = !!status.data?.connected && !!status.data?.interactiveResearchEnabled;
  const tools = useQuery({ queryKey: ['g2x-tools'], queryFn: () => api.get<any[]>('/api/g2x/tools'), enabled: ready });
  const connect = useMutation({ mutationFn: () => api.post<{ url: string }>('/api/g2x/connect'), onSuccess: (r) => window.location.assign(r.url) });
  const disconnect = useMutation({
    mutationFn: () => api.post('/api/g2x/disconnect'),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ['g2x-tools'] });
      qc.removeQueries({ queryKey: ['g2x-guided'] });
      qc.invalidateQueries({ queryKey: ['g2x-status'] });
    },
  });
  return (
    <>
      <h1>Integration settings</h1>
      <Card title="G2X individual interactive research">
        <p>
          Connect your own G2X membership using OAuth. G2X results stay in your current session: GovCheck does not store, refresh or share them, and never sends them to an AI provider. GovCheck only stores what you explicitly create — an official SAM.gov record it retrieves itself, a link back to the G2X record, or a research lead you write.
        </p>
        <p>
          Interactive research: {status.data?.interactiveResearchEnabled ? 'Enabled' : 'Disabled pending authorization'} · {status.data?.connected ? 'Account connected' : 'No connected account'} · Storage of G2X content: not authorized · Automated refresh: not authorized
        </p>
        {[status.error, tools.error, connect.error, disconnect.error].filter(Boolean).map((e, i) => (
          <ErrorBox key={i} error={e} />
        ))}
        <div className="row">
          <button className="btn" disabled={!status.data?.interactiveResearchEnabled || connect.isPending} onClick={() => connect.mutate()}>
            Connect G2X
          </button>
          {status.data?.connected && (
            <button className="btn" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
              Disconnect G2X
            </button>
          )}
        </div>
      </Card>
      {ready && <GuidedSearch tools={tools.data ?? []} />}
      {ready && !!tools.data?.length && <AdvancedTool tools={tools.data} />}
    </>
  );
}

function GuidedSearch({ tools }: { tools: any[] }) {
  const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true);
  const [tool, setTool] = useState('');
  const guided = useQuery({ queryKey: ['g2x-guided', tool], queryFn: () => api.get<any>(`/api/g2x/guided${tool ? `?tool=${encodeURIComponent(tool)}` : ''}`) });
  const [args, setArgs] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<any>(null);
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (guided.data) {
      setArgs(guided.data.arguments ?? {});
      if (!tool) setTool(guided.data.tool.name);
    }
  }, [guided.data, tool]);
  const schema = guided.data?.tool.inputSchema;
  const missing = missingRequired(fieldsOf(schema), args);
  const search = useMutation({
    mutationFn: (cursor?: string) => api.post('/api/g2x/search', { tool, arguments: cleanArguments(args) ?? {}, acknowledgeIndividualUse: true, ...(cursor ? { cursor } : {}) }),
    onSuccess: (r, cursor) => {
      setResult(r);
      setPage((p) => (cursor ? p + 1 : 1));
    },
  });
  const rerun = () => search.mutate(undefined);
  return (
    <Card title="Find opportunities in G2X">
      <p className="small muted">The fields below come from the search tool you choose. They start filled in from your company profile; change anything before searching. GovCheck fetches one page at a time, only when you ask.</p>
      <label className="field">
        Search tool
        <select value={tool} onChange={(e) => setTool(e.target.value)}>
          {readOnly.map((t) => (
            <option key={t.name} value={t.name}>
              {t.title ?? t.name}
            </option>
          ))}
        </select>
      </label>
      {guided.error && <ErrorBox error={guided.error} />}
      {guided.data && (
        <div className="small">
          {guided.data.tool.description && <p className="muted">{guided.data.tool.description}</p>}
          {guided.data.mapped.length > 0 && <p>Filled in from your profile: {guided.data.mapped.map((m: any) => `${humanize(m.property)} (${m.from.charAt(0).toLowerCase()}${m.from.slice(1)})`).join(' · ')}</p>}
          {guided.data.unsupported.length > 0 && <p className="muted">This tool has no field for: {guided.data.unsupported.join(', ')}</p>}
        </div>
      )}
      {guided.data && (
        <div style={{ margin: '10px 0' }}>
          <SchemaForm key={tool} schema={schema} value={args} onChange={setArgs} />
        </div>
      )}
      <div className="row">
        <button className="btn primary" disabled={search.isPending || !tool || missing.length > 0} onClick={rerun}>
          {search.isPending ? 'Searching…' : 'Search G2X'}
        </button>
        {guided.data && (
          <button className="btn ghost sm" onClick={() => setArgs(guided.data.arguments ?? {})}>
            Reset to my profile
          </button>
        )}
      </div>
      {search.error && <ErrorBox error={search.error} />}
      {result && (
        <div style={{ marginTop: 12 }}>
          <p className="small muted">
            {result.retention} · Page {page}
            {result.groups.dismissed ? ` · ${result.groups.dismissed} dismissed result(s) hidden` : ''}
          </p>
          {GROUPS.map(([key, label, help]) => (
            <ResultGroup key={key} label={label} help={help} rows={result.rows.filter((r: any) => r.group === key)} onChanged={rerun} />
          ))}
          <div className="row" style={{ gap: 8 }}>
            {result.nextCursor && (
              <button className="btn" disabled={search.isPending} onClick={() => search.mutate(result.nextCursor)}>
                Load next page from G2X
              </button>
            )}
            <button className="btn ghost" onClick={() => setResult(null)}>
              Clear results
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ResultGroup({ label, help, rows, onChanged }: { label: string; help: string; rows: any[]; onChanged: () => void }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3>
        {label} <span className="badge neutral">{rows.length}</span>
      </h3>
      <p className="small muted">{help}</p>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Opportunity</th>
                <th>Agency</th>
                <th>Solicitation #</th>
                <th>Notice status</th>
                <th>Due</th>
                <th>G2X</th>
                <th>GovCheck match</th>
                <th>Tracking</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ResultRow key={r.g2xId} row={r} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResultRow({ row, onChanged }: { row: any; onChanged: () => void }) {
  const [lead, setLead] = useState<null | { relateTo?: any }>(null);
  const [review, setReview] = useState(false);
  const m = row.match;
  const track = useMutation({
    mutationFn: (id: string) => api.post(`/api/opportunities/${id}/track`, { tracked: true, requestId: crypto.randomUUID() }),
    onSuccess: () => (toast('Tracking started.'), onChanged()),
    onError: (e: Error) => toast(e.message),
  });
  const verify = useMutation({
    mutationFn: () => api.post<any>('/api/g2x/verify', { g2xId: row.g2xId, recordUrl: row.recordUrl, solicitationNumber: row.solicitationNumber, agency: row.agency, track: true, confirmSamRequest: true }),
    onSuccess: (r) => {
      toast(r.status === 'verified' ? 'Official SAM.gov record ingested and tracked. G2X kept as discovery source.' : r.message);
      if (r.status !== 'verified') setLead({});
      onChanged();
    },
    onError: (e: Error) => toast(e.message),
  });
  const matchLabel =
    m.status === 'existing'
      ? m.opportunity?.verification_status === 'research_lead'
        ? 'Existing research lead'
        : 'Existing opportunity'
      : m.status === 'potential_match'
        ? `${m.candidates.length} potential match(es)`
        : m.status === 'official_candidate'
          ? 'Not in GovCheck — official notice referenced'
          : 'No match';
  return (
    <tr>
      <td style={{ maxWidth: 320 }}>{row.title ?? '—'}</td>
      <td className="small">{row.agency ?? '—'}</td>
      <td className="mono small">{row.solicitationNumber ?? '—'}</td>
      <td className="small">{row.noticeType ?? '—'}</td>
      <td className="small nowrap">{row.responseDeadline ? date(row.responseDeadline) : '—'}</td>
      <td>
        {row.recordUrl ? (
          <a href={row.recordUrl} target="_blank" rel="noreferrer" title="Open in G2X">
            <ExternalLink size={13} />
          </a>
        ) : (
          '—'
        )}
      </td>
      <td className="small">
        <span className={`badge ${m.status === 'existing' ? 'good' : m.status === 'potential_match' ? 'warn' : 'neutral'}`}>{matchLabel}</span>
        {m.evidence.length > 0 && <div className="muted">{m.evidence.join('; ')}</div>}
      </td>
      <td className="small">{m.opportunity ? (m.opportunity.tracked ? <span className="badge good">Tracked</span> : <span className="badge neutral">Untracked</span>) : '—'}</td>
      <td>
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {m.status === 'existing' && m.opportunity && (
            <>
              <Link className="btn sm" to={`/opportunities/${m.opportunity.id}`}>
                Open existing opportunity
              </Link>
              {!m.opportunity.tracked && (
                <button className="btn sm primary" disabled={track.isPending} onClick={() => track.mutate(m.opportunity.id)}>
                  Track
                </button>
              )}
            </>
          )}
          {(m.status === 'official_candidate' || (m.status === 'potential_match' && (row.samNoticeCandidate || row.solicitationNumber) && row.family === 'sam')) && (
            <button
              className="btn sm primary"
              disabled={verify.isPending}
              onClick={() => window.confirm('Look this notice up on SAM.gov? This uses 1–2 of today’s SAM.gov API requests. Only the official SAM.gov record is stored.') && verify.mutate()}
            >
              {verify.isPending ? 'Verifying…' : 'Verify on SAM.gov & track'}
            </button>
          )}
          {m.status === 'potential_match' && (
            <button className="btn sm" onClick={() => setReview(true)}>
              Review potential match
            </button>
          )}
          {m.status !== 'existing' && (
            <button className="btn sm" onClick={() => setLead({})}>
              Track as research lead
            </button>
          )}
        </div>
        {review && (
          <PotentialMatchModal
            row={row}
            onClose={() => setReview(false)}
            onDone={(relateTo) => {
              setReview(false);
              if (relateTo) setLead({ relateTo });
              onChanged();
            }}
          />
        )}
        {lead && (
          <LeadForm
            row={row}
            relateTo={lead.relateTo}
            onClose={() => setLead(null)}
            onDone={() => {
              setLead(null);
              onChanged();
            }}
          />
        )}
      </td>
    </tr>
  );
}

function PotentialMatchModal({ row, onClose, onDone }: { row: any; onClose: () => void; onDone: (relateTo?: { opportunityId: string; type: 'predecessor' | 'successor' }) => void }) {
  const decide = useMutation({
    mutationFn: (b: { opportunityId: string | null; decision: string }) => api.post('/api/discovery/decision', { provider: 'g2x', recordRef: row.recordUrl ?? `g2x:${row.g2xId}`, recordUrl: row.recordUrl, ...b }),
    onError: (e: Error) => toast(e.message),
  });
  const run = async (opportunityId: string | null, decision: string) => {
    await decide.mutateAsync({ opportunityId, decision });
    if (decision === 'predecessor' || decision === 'successor') onDone({ opportunityId: opportunityId!, type: decision });
    else onDone();
  };
  return (
    <Modal title="Potential match" onClose={onClose}>
      <p className="small">
        G2X result: <strong>{row.title ?? row.g2xId}</strong> · {row.agency ?? 'Agency unknown'} · {row.solicitationNumber ?? 'No solicitation number'}
      </p>
      {row.match.candidates.map((c: any) => (
        <div key={c.id} className="callout small" style={{ marginBottom: 8 }}>
          <Link to={`/opportunities/${c.id}`} target="_blank">
            {c.title}
          </Link>{' '}
          <span className="badge neutral">{c.stage}</span> · {c.department_name ?? 'Agency unknown'} · score {Math.round(c.score * 100)}%
          <div>Evidence: {c.evidence.join('; ')}</div>
          {c.conflicts.length > 0 && <div style={{ color: 'var(--bad)' }}>Conflicts: {c.conflicts.join('; ')}</div>}
          <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            <button className="btn sm primary" disabled={decide.isPending} onClick={() => run(c.id, 'linked')}>
              Link to existing opportunity
            </button>
            <button className="btn sm" disabled={decide.isPending} onClick={() => run(c.id, 'separate')}>
              Keep as separate procurement
            </button>
            <button className="btn sm" disabled={decide.isPending} onClick={() => run(c.id, 'predecessor')}>
              Existing is the predecessor
            </button>
            <button className="btn sm" disabled={decide.isPending} onClick={() => run(c.id, 'successor')}>
              Existing is the successor
            </button>
          </div>
        </div>
      ))}
      <button className="btn ghost sm" disabled={decide.isPending} onClick={() => run(null, 'dismissed')}>
        Dismiss this result
      </button>
      <p className="small muted">Your decision is remembered for future searches. Only a one-way key of the G2X link is stored with it.</p>
    </Modal>
  );
}

function LeadForm({ row, relateTo, onClose, onDone }: { row: any; relateTo?: { opportunityId: string; type: string }; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ title: '', notes: '', agency: '', solicitationNumber: '', responseDeadline: '', confirm: false });
  const create = useMutation({
    mutationFn: () =>
      api.post<any>('/api/research-leads', {
        title: form.title,
        notes: form.notes || null,
        sourceUrl: row.recordUrl,
        provider: 'g2x',
        agency: form.agency || null,
        solicitationNumber: form.solicitationNumber || null,
        responseDeadline: form.responseDeadline || null,
        track: true,
        relateTo: relateTo ?? null,
        confirmUserAuthored: true,
      }),
    onSuccess: (r) => {
      toast(r.created ? 'Research lead created and tracked.' : 'A research lead for this G2X record already exists.');
      onDone();
    },
    onError: (e: Error) => toast(e.message),
  });
  const set = (k: keyof typeof form, v: any) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      title="Track as research lead"
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!form.confirm || form.title.trim().length < 3 || !row.recordUrl || create.isPending} onClick={() => create.mutate()}>
          Create research lead
        </button>
      }
    >
      <div className="callout warn small">This creates a minimal, user-authored record labeled: Research lead · Not government verified · No official solicitation confirmed · Source discovery: G2X. Write it in your own words — do not paste G2X content.</div>
      <label className="field">
        Your title
        <input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="Describe the lead in your own words" />
      </label>
      <label className="field">
        Your notes
        <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={4} />
      </label>
      <label className="field">
        Source link
        <input value={row.recordUrl ?? ''} readOnly />
      </label>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label className="field">
          Agency (optional, your entry)
          <input value={form.agency} onChange={(e) => set('agency', e.target.value)} />
        </label>
        <label className="field">
          Solicitation # (optional, your entry)
          <input value={form.solicitationNumber} onChange={(e) => set('solicitationNumber', e.target.value)} />
        </label>
        <label className="field">
          Response date (optional)
          <input type="date" value={form.responseDeadline} onChange={(e) => set('responseDeadline', e.target.value)} />
        </label>
      </div>
      {relateTo && <p className="small">Will be linked to the selected opportunity as its {relateTo.type === 'predecessor' ? 'successor (the existing record is the predecessor)' : 'predecessor (the existing record is the successor)'}.</p>}
      <label className="check">
        <input type="checkbox" checked={form.confirm} onChange={(e) => set('confirm', e.target.checked)} /> I wrote this record myself and it contains no copied G2X content.
      </label>
    </Modal>
  );
}

function AdvancedTool({ tools }: { tools: any[] }) {
  const [tool, setTool] = useState(''),
    [args, setArgs] = useState<Record<string, unknown>>({}),
    [result, setResult] = useState<any>(null);
  const research = useMutation({ mutationFn: () => api.post('/api/g2x/research', { tool, arguments: cleanArguments(args) ?? {}, acknowledgeIndividualUse: true }), onSuccess: setResult });
  const selected = tools.find((t) => t.name === tool);
  const missing = selected ? missingRequired(fieldsOf(selected.inputSchema), args) : [];
  return (
    <Card title="Advanced: run any read-only G2X tool">
      <details>
        <summary>How to use</summary>
        <ol>
          <li>Choose a read-only research tool. The list depends on your G2X account.</li>
          <li>Fill in the fields the tool asks for (required ones are marked *), then run it. Results are not imported or saved for teammates.</li>
        </ol>
        <p>
          <a href="https://g2x.com/mcp/tools" target="_blank" rel="noreferrer">
            G2X tool reference
          </a>
        </p>
      </details>
      {research.error && <ErrorBox error={research.error} />}
      <label className="field">
        Read-only research tool
        <select
          value={tool}
          onChange={(e) => {
            setTool(e.target.value);
            setResult(null);
            setArgs({});
          }}
        >
          <option value="">Select a tool</option>
          {tools
            .filter((t) => t.annotations?.readOnlyHint === true)
            .map((t) => (
              <option key={t.name} value={t.name}>
                {t.title ?? t.name}
              </option>
            ))}
        </select>
      </label>
      {selected && (
        <>
          <p>{selected.description}</p>
          <div style={{ margin: '10px 0' }}>
            <SchemaForm key={tool} schema={selected.inputSchema} value={args} onChange={setArgs} />
          </div>
          <button className="btn primary" disabled={research.isPending || missing.length > 0} onClick={() => research.mutate()}>
            Run individual research
          </button>
        </>
      )}
      {result && (
        <div>
          <p>{result.retention}</p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(result.result, null, 2)}</pre>
          <button className="btn" onClick={() => setResult(null)}>
            Clear research results
          </button>
        </div>
      )}
    </Card>
  );
}
