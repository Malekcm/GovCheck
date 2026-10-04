import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Columns3 } from 'lucide-react';
import { PURSUIT_STAGE_LABELS, setAsideLabel, type PursuitStage } from '../../shared/domain';
import { date, moneyRange, relative } from '../format';
import { ClassBadge, Deadline, DecisionBadge, EligibilityBadge, Prov, Score, SourceBadges, StageBadge } from './ui';

export interface Column {
  key: string;
  label: string;
  sort?: string;
  render: (o: any) => React.ReactNode;
  className?: string;
}

export const COLUMNS: Column[] = [
  {
    key: 'priority',
    label: 'Priority',
    sort: 'best',
    render: (o) => (
      <span title="Review priority: personalized fit + attractiveness, capped when eligibility is doubtful">
        <Score value={o.priority_score} label="Review priority" />
        {o.eligibility_status === 'ineligible' || o.eligibility_status === 'likely_ineligible' ? <span className="badge bad" style={{ marginLeft: 3 }}>!</span> : null}
      </span>
    ),
  },
  { key: 'fit', label: 'Fit', sort: 'fit', render: (o) => <Score value={o.fit_score} label="Base company fit (0–100)" /> },
  { key: 'pref', label: 'Pref', sort: 'preference', render: (o) => <Score value={o.preference_score} label="Learned preference score (0–100)" /> },
  { key: 'eligibility', label: 'Eligibility', render: (o) => <EligibilityBadge status={o.eligibility_status} /> },
  { key: 'attractiveness', label: 'Attract.', sort: 'attractiveness', render: (o) => <Score value={o.attractiveness_score} label="Strategic attractiveness" /> },
  { key: 'confidence', label: 'Conf.', sort: 'confidence', render: (o) => <Score value={o.confidence_score} label="Data confidence" /> },
  { key: 'decision', label: 'Decision', render: (o) => <DecisionBadge decision={o.decision} /> },
  {
    key: 'capture',
    label: 'Capture',
    sort: 'next_action',
    render: (o) =>
      o.pursuit_stage ? (
        <div className="small" style={{ maxWidth: 200 }}>
          <span className="badge info">{PURSUIT_STAGE_LABELS[o.pursuit_stage as PursuitStage] ?? o.pursuit_stage}</span> {o.capture_owner && <span className="muted">{o.capture_owner}</span>}
          {o.next_action && (
            <div className="truncate muted" title={o.next_action}>
              → {o.next_action} {o.next_action_date ? `(${date(o.next_action_date)})` : ''}
            </div>
          )}
        </div>
      ) : (
        <span className="muted small">—</span>
      ),
  },
  {
    key: 'opportunity',
    label: 'Opportunity',
    render: (o) => (
      <div>
        <div className="opp-title">
          {o.title} {o.recent_changes > 0 && <span className="badge warn" title="Changed in the last 7 days">changed</span>}
        </div>
        <div className="opp-sub row" style={{ gap: 6 }}>
          <ClassBadge cls={o.opportunity_class} />
          {o.solicitation_number && <span className="mono">{o.solicitation_number}</span>}
          {o.incumbent_name && <span>Incumbent: {o.incumbent_name}</span>}
        </div>
      </div>
    ),
  },
  {
    key: 'agency',
    label: 'Agency',
    sort: 'agency',
    render: (o) => (
      <div className="small" style={{ maxWidth: 230 }}>
        <div className="truncate" title={o.subtier_name ?? o.department_name}>{o.subtier_name ?? o.department_name ?? (o.opportunity_class === 'subcontract' ? 'Prime contractor' : '—')}</div>
        {o.office_name && <div className="muted truncate" title={o.office_name}>{o.office_name}</div>}
      </div>
    ),
  },
  { key: 'stage', label: 'Stage', render: (o) => <StageBadge stage={o.stage} isSignal={o.is_signal} /> },
  { key: 'type', label: 'Type', render: (o) => <span className="small muted">{o.notice_type ?? '—'}</span> },
  {
    key: 'value',
    label: 'Value',
    sort: 'value',
    render: (o) =>
      o.value_low == null && o.value_high == null ? (
        <span className="muted">—</span>
      ) : (
        <div className="nowrap">
          <span className={`num ${o.value_provenance === 'estimated' ? 'val-estimated' : o.value_provenance === 'derived' ? 'val-derived' : ''}`}>{moneyRange(o.value_low, o.value_high)}</span>{' '}
          <Prov p={o.value_provenance} title={`${o.value_label ?? 'Value'} — ${o.value_provenance}`} />
          <div className="small muted">{o.value_label}</div>
        </div>
      ),
  },
  { key: 'setaside', label: 'Set-aside', render: (o) => <span className="small">{setAsideLabel(o.set_aside_code, o.set_aside)}</span> },
  { key: 'deadline', label: 'Deadline', sort: 'deadline', render: (o) => <Deadline value={o.response_deadline} /> },
  { key: 'source', label: 'Source', render: (o) => <SourceBadges ids={o.connector_ids} /> },
  { key: 'perfEnd', label: 'PoP end', sort: 'expiring', render: (o) => <span className="small nowrap">{o.performance_end ? date(o.performance_end) : '—'}</span> },
  { key: 'completeness', label: 'Data', sort: 'completeness', render: (o) => <span className="num small" title="Data completeness">{o.data_completeness ?? '—'}%</span> },
  { key: 'updated', label: 'Updated', sort: 'updated', render: (o) => <span className="small muted nowrap">{relative(o.last_changed_at)}</span> },
];

const DEFAULT_VISIBLE = ['priority', 'fit', 'eligibility', 'decision', 'capture', 'opportunity', 'agency', 'stage', 'value', 'setaside', 'deadline', 'source', 'updated'];
// v2: adds Priority / Capture columns (bumped so existing column choices pick them up once).
const STORAGE_KEY = 'goi.columns.v2';

function loadVisible(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return Array.isArray(v) && v.length ? v : DEFAULT_VISIBLE;
  } catch {
    return DEFAULT_VISIBLE;
  }
}

export function OpportunityTable({ rows, sort, onSort, compact }: { rows: any[]; sort?: string; onSort?: (s: string) => void; compact?: boolean }) {
  const navigate = useNavigate();
  const [visible, setVisible] = useState<string[]>(loadVisible);
  const [picker, setPicker] = useState(false);
  const cols = COLUMNS.filter((c) => visible.includes(c.key) && (!compact || ['priority', 'fit', 'opportunity', 'agency', 'stage', 'value', 'deadline', 'decision'].includes(c.key)));
  const toggle = (k: string) => {
    const next = visible.includes(k) ? visible.filter((x) => x !== k) : COLUMNS.map((c) => c.key).filter((x) => x === k || visible.includes(x));
    setVisible(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div>
      {!compact && (
        <div className="row" style={{ justifyContent: 'flex-end', padding: '6px 10px', position: 'relative' }}>
          <button className="btn ghost sm" onClick={() => setPicker((v) => !v)}>
            <Columns3 size={13} /> Columns
          </button>
          {picker && (
            <div className="card" style={{ position: 'absolute', right: 10, top: 34, zIndex: 30, padding: 10, minWidth: 180 }}>
              {COLUMNS.map((c) => (
                <label key={c.key} className="check" style={{ display: 'flex', padding: '2px 0' }}>
                  <input type="checkbox" checked={visible.includes(c.key)} onChange={() => toggle(c.key)} /> {c.label}
                </label>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={c.sort && onSort ? 'sortable' : ''} onClick={() => c.sort && onSort?.(c.sort)}>
                  {c.label}
                  {sort && c.sort === sort ? ' ↓' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr
                key={o.id}
                className={`clickable ${o.is_signal ? 'signal-row' : ''}`}
                onClick={(e) => (e.metaKey || e.ctrlKey ? window.open(`/opportunities/${o.id}`, '_blank') : navigate(`/opportunities/${o.id}`))}
              >
                {cols.map((c) => (
                  <td key={c.key}>{c.render(o)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
