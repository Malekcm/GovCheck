import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { Copy, Printer } from 'lucide-react';
import { SCORE_COMPONENT_LABELS, STAGE_LABELS, setAsideLabel, type ScoreComponent, type Stage } from '../../shared/domain';
import { api } from '../api';
import { date, money, moneyRange, titleize } from '../format';
import { ErrorBox, Loading, toast } from '../components/ui';

const PROV: Record<string, string> = { official: 'OFFICIAL', derived: 'DERIVED', estimated: 'ESTIMATED', ai_extracted: 'AI', user_entered: 'USER', unknown: 'UNKNOWN' };

/** Build a plain-text capture brief (copyable into email/docs). Every value carries its provenance label. */
function briefText(d: any): string {
  const o = d.opportunity;
  const ex = (k: string) => d.explanations.filter((e: any) => e.kind === k).map((e: any) => e.text);
  const lines: string[] = [];
  const h = (t: string) => lines.push('', t.toUpperCase(), '-'.repeat(t.length));
  lines.push(`CAPTURE BRIEF — ${o.title}`, `Generated ${new Date().toLocaleString()} by GovCheck`);
  if (o.is_signal) lines.push('*** INTELLIGENCE SIGNAL — NOT AN ACTIVE SOLICITATION ***');
  h('Opportunity');
  lines.push(`Stage: ${STAGE_LABELS[o.stage as Stage] ?? o.stage} | Class: ${o.opportunity_class} | Status: ${o.status}`);
  lines.push(`Solicitation #: ${o.solicitation_number ?? '—'} | Notice ID: ${o.primary_notice_id ?? '—'}`);
  lines.push(`NAICS: ${o.naics_code ?? '—'} | PSC: ${o.psc_code ?? '—'} | Set-aside: ${setAsideLabel(o.set_aside_code, o.set_aside)}`);
  h('Agency');
  lines.push([o.department_name, o.subtier_name, o.office_name].filter(Boolean).join(' > ') || '—');
  h('Fit & eligibility');
  lines.push(`Fit ${o.fit_score ?? '—'}/100 | Preference ${o.preference_score ?? '—'}/100 | Eligibility: ${titleize(o.eligibility_status)}`);
  for (const c of d.components) lines.push(`  ${SCORE_COMPONENT_LABELS[c.component as ScoreComponent]}: ${Number(c.points).toFixed(1)}/${c.max_points}`);
  h('Why we match');
  for (const m of d.explanations.filter((e: any) => e.kind === 'matched_capability')) lines.push(`  ✓ ${m.detail.name} — "${m.detail.matchedTerm}"`);
  for (const s of ex('strength')) lines.push(`  + ${s}`);
  h('Concerns');
  for (const s of [...ex('hard_block'), ...ex('verify'), ...ex('gap')]) lines.push(`  ! ${s}`);
  h('Scope');
  lines.push(o.summary ? `[AI] ${o.summary}` : '(see source description)');
  for (const r of d.requirements.filter((r: any) => ['task', 'deliverable', 'technology', 'clearance', 'evaluation_factor', 'page_limit'].includes(r.category)).slice(0, 25))
    lines.push(`  - [${PROV[r.provenance]}] ${titleize(r.category)}: ${r.text}`);
  h('Value');
  for (const f of d.financials) lines.push(`  [${PROV[f.provenance]}] ${f.label ?? titleize(f.kind)}: ${moneyRange(f.amount_low, f.amount_high)}${f.confidence ? ` (${f.confidence} confidence)` : ''}${f.basis ? ` — ${f.basis}` : ''}`);
  if (!d.financials.length) lines.push('  Official value: not provided');
  h('Dates');
  for (const x of d.dates) lines.push(`  [${PROV[x.provenance]}] ${titleize(x.kind)}: ${x.date_text && !x.date_value ? x.date_text : date(x.date_value)}`);
  h('Contacts');
  for (const c of d.contacts) lines.push(`  ${titleize(c.role)}: ${c.full_name ?? ''} ${c.email ?? ''} ${c.phone ?? ''}`.trimEnd());
  h('Incumbent');
  for (const v of d.vendors) lines.push(`  ${v.role === 'possible_incumbent' ? 'POSSIBLE' : 'CONFIRMED'} ${v.name} (UEI ${v.uei ?? '—'}) — ${(v.evidence ?? []).join('; ')}`);
  if (!d.vendors.length) lines.push('  None identified');
  h('Historical contracts');
  for (const a of d.awards.slice(0, 12)) lines.push(`  ${titleize(a.relationship)} ${a.piid} ${a.awardee_name ?? ''} ${money(a.base_and_all_options ?? a.total_obligated)} ${a.pop_start ?? ''}→${a.pop_current_end ?? ''}`);
  h('Timeline');
  for (const e of d.events.filter((e: any) => e.is_lifecycle)) lines.push(`  ${date(e.occurred_at ?? e.detected_at)} ${e.title}`);
  h('Documents');
  for (const doc of d.documents) lines.push(`  ${doc.filename ?? doc.url} (${doc.doc_type ?? 'document'}) ${doc.url}`);
  h('Sources');
  for (const s of d.sources) lines.push(`  ${s.connector_name}: ${s.external_id} ${s.source_url ?? ''}`);
  h('Our notes');
  if (d.currentDecision) lines.push(`  Decision: ${d.currentDecision.decision}${d.currentDecision.explanation ? ` — ${d.currentDecision.explanation}` : ''}`);
  for (const n of d.notes) lines.push(`  • ${n.body}`);
  return lines.join('\n');
}

export function CaptureBriefPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['opportunity', id], queryFn: () => api.get<any>(`/api/opportunities/${id}`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const d = q.data;
  const text = briefText(d);
  return (
    <div>
      <div className="page-head no-print">
        <div>
          <h1>Capture brief</h1>
          <p>
            Printable / copyable summary of <Link to={`/opportunities/${id}`}>{d.opportunity.title}</Link>. Every value is labeled OFFICIAL, DERIVED, ESTIMATED, AI or USER.
          </p>
        </div>
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              navigator.clipboard
                .writeText(text)
                .then(() => toast('Capture brief copied to clipboard.'))
                .catch(() => toast('Clipboard unavailable — select the text and copy.'))
            }
          >
            <Copy size={14} /> Copy text
          </button>
          <button className="btn primary" onClick={() => window.print()}>
            <Printer size={14} /> Print / save PDF
          </button>
        </div>
      </div>
      <pre className="card" style={{ padding: 16, whiteSpace: 'pre-wrap', fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.5 }}>
        {text}
      </pre>
    </div>
  );
}
