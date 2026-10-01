import { type ReactNode, useEffect, useState } from 'react';
import {
  CLASS_LABELS,
  DECISION_LABELS,
  ELIGIBILITY_LABELS,
  GLOSSARY,
  PROVENANCE_DESCRIPTIONS,
  PROVENANCE_LABELS,
  STAGE_DESCRIPTIONS,
  STAGE_LABELS,
  type Decision,
  type EligibilityStatus,
  type OpportunityClass,
  type Provenance,
  type Stage,
} from '../../shared/domain';
import { daysUntil, date } from '../format';

export function Prov({ p, title }: { p: string | null | undefined; title?: string }) {
  const key = (p ?? 'unknown') as Provenance;
  return (
    <span className={`prov ${key} tip`} data-tip={title ?? PROVENANCE_DESCRIPTIONS[key] ?? ''}>
      {PROVENANCE_LABELS[key] ?? p}
    </span>
  );
}

export function Score({ value, label }: { value: number | null | undefined; label?: string }) {
  if (value === null || value === undefined) return <span className="score lo" title={label}>—</span>;
  const cls = value >= 70 ? 'hi' : value >= 45 ? 'mid' : 'lo';
  return (
    <span className={`score ${cls}`} title={label}>
      {Math.round(value)}
    </span>
  );
}

export function StageBadge({ stage, isSignal }: { stage: string; isSignal?: boolean }) {
  if (isSignal || stage === 'recompete_signal')
    return (
      <span className="badge signal tip" data-tip={STAGE_DESCRIPTIONS.recompete_signal}>
        Intelligence signal
      </span>
    );
  const label = STAGE_LABELS[stage as Stage] ?? stage;
  const tone = stage === 'forecast' || stage === 'grant_forecast' ? 'info' : stage === 'award' ? 'good' : stage === 'solicitation' || stage === 'combined_synopsis' || stage === 'grant_posted' ? 'warn' : 'neutral';
  return (
    <span className={`badge ${tone} tip`} data-tip={STAGE_DESCRIPTIONS[stage as Stage] ?? ''}>
      {label}
    </span>
  );
}

export function ClassBadge({ cls }: { cls: string }) {
  // Intelligence signals already carry the signal stage badge.
  if (cls === 'prime' || cls === 'intelligence') return null;
  const tone = cls === 'grant' ? 'good' : cls === 'subcontract' ? 'outline' : 'signal';
  return <span className={`badge ${tone}`}>{CLASS_LABELS[cls as OpportunityClass] ?? cls}</span>;
}

export function EligibilityBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="muted">—</span>;
  const tone = status === 'eligible' ? 'good' : status === 'likely_eligible' ? 'good' : status === 'unclear' ? 'warn' : 'bad';
  return <span className={`badge ${tone}`}>{ELIGIBILITY_LABELS[status as EligibilityStatus] ?? status}</span>;
}

export function DecisionBadge({ decision }: { decision: string | null | undefined }) {
  if (!decision) return <span className="muted small">Unreviewed</span>;
  const tone = decision === 'pursue' ? 'good' : decision === 'interested' ? 'good' : decision === 'pass' || decision === 'not_relevant' ? 'neutral' : 'info';
  return <span className={`badge ${tone}`}>{DECISION_LABELS[decision as Decision] ?? decision}</span>;
}

const SOURCE_SHORT: Record<string, string> = {
  sam_opportunities: 'SAM',
  sam_bulk: 'SAM bulk',
  sam_awards: 'SAM awards',
  usaspending: 'USAspending',
  gsa_forecast: 'GSA forecast',
  sba_subnet: 'SUBNet',
  grants_gov: 'Grants.gov',
};
export function SourceBadges({ ids }: { ids: string[] | null | undefined }) {
  if (!ids?.length) return <span className="muted">—</span>;
  return (
    <span className="row" style={{ gap: 3 }}>
      {ids.map((i) => (
        <span key={i} className="badge outline">
          {SOURCE_SHORT[i] ?? i.replace(/^feed_/, '').slice(0, 14)}
        </span>
      ))}
    </span>
  );
}

export function Term({ t, children }: { t: string; children?: ReactNode }) {
  const def = GLOSSARY[t];
  return (
    <span className={def ? 'term tip' : ''} data-tip={def}>
      {children ?? t}
    </span>
  );
}

export function Deadline({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="muted">—</span>;
  const d = daysUntil(value);
  const tone = d === null ? '' : d < 0 ? 'muted' : d <= 7 ? 'bad' : d <= 14 ? 'warn' : '';
  return (
    <span className="nowrap">
      {date(value)}{' '}
      {d !== null && (
        <span className={`small ${tone ? `badge ${tone === 'muted' ? 'neutral' : tone}` : 'muted'}`}>{d < 0 ? 'closed' : d === 0 ? 'today' : `${d}d`}</span>
      )}
    </span>
  );
}

export function Card({ title, actions, children, id, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string; className?: string; bodyClass?: string }) {
  return (
    <section className={`card section ${className ?? ''}`} id={id}>
      {(title || actions) && (
        <div className="card-head">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={bodyClass ?? 'card-body'}>{children}</div>
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="empty row" style={{ justifyContent: 'center' }}>
      <span className="spinner" /> {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="callout bad">{error instanceof Error ? error.message : String(error)}</div>;
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="card-body">{children}</div>
        {footer && <div className="card-head" style={{ borderTop: '1px solid var(--border)', borderBottom: 0, justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

let toastListener: ((m: string) => void) | null = null;
export function toast(message: string) {
  toastListener?.(message);
}
export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    toastListener = (m) => {
      setMsg(m);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 4500);
    };
    return () => {
      toastListener = null;
    };
  }, []);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}

export function ProvenanceLegend() {
  return (
    <div className="legend">
      <span>Data labels:</span>
      {(['official', 'derived', 'estimated', 'ai_extracted', 'user_entered', 'unknown'] as Provenance[]).map((p) => (
        <Prov key={p} p={p} />
      ))}
    </div>
  );
}

/** Tag-style list editor for string arrays (keywords, agencies, locations…). */
export function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setDraft('');
  };
  return (
    <div className="stack">
      <div className="chips">
        {value.map((v) => (
          <span key={v} className="chip on" onClick={() => onChange(value.filter((x) => x !== v))} title="Remove">
            {v} <span className="x">✕</span>
          </span>
        ))}
        {!value.length && <span className="muted small">None</span>}
      </div>
      <div className="row">
        <input type="text" value={draft} placeholder={placeholder ?? 'Type and press Enter'} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} style={{ flex: 1 }} />
        <button type="button" className="btn sm" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
