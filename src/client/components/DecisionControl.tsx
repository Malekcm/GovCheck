import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DECISIONS, DECISION_LABELS, type Decision } from '../../shared/domain';
import { api } from '../api';
import { date } from '../format';
import { Modal, toast } from './ui';

interface Reason {
  code: string;
  label: string;
  polarity: 'positive' | 'negative';
}

const POSITIVE: Decision[] = ['pursue', 'interested', 'watch', 'maybe'];

/** Pursue / Interested / Watch / Maybe / Pass / Not relevant — with reasons and free-text explanation. */
export function DecisionControl({ opportunityId, current }: { opportunityId: string; current: any | null }) {
  const qc = useQueryClient();
  const meta = useQuery({ queryKey: ['meta'], queryFn: () => api.get<{ feedbackReasons: Reason[] }>('/api/meta') });
  const [pending, setPending] = useState<Decision | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [explanation, setExplanation] = useState('');

  const save = useMutation({
    mutationFn: (body: { decision: Decision; reasons: string[]; explanation: string | null }) => api.post(`/api/opportunities/${opportunityId}/decision`, body),
    onSuccess: (_d, v) => {
      toast(`Marked ${DECISION_LABELS[v.decision]}. Your preference model will update in the background.`);
      setPending(null);
      qc.invalidateQueries({ queryKey: ['opportunity', opportunityId] });
      qc.invalidateQueries({ queryKey: ['opportunities'] });
      qc.invalidateQueries({ queryKey: ['queues'] });
    },
    onError: (e: Error) => toast(e.message),
  });
  const clear = useMutation({
    mutationFn: () => api.del(`/api/opportunities/${opportunityId}/decision`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['opportunity', opportunityId] });
      toast('Decision cleared (history kept).');
    },
  });

  const open = (d: Decision) => {
    setPending(d);
    const same = current?.decision === d;
    setReasons(same ? current.reasons ?? [] : []);
    setExplanation(same ? current.explanation ?? '' : '');
  };
  const polarity = pending && POSITIVE.includes(pending) && pending !== 'maybe' ? 'positive' : pending === 'maybe' ? 'any' : 'negative';
  const shown = (meta.data?.feedbackReasons ?? []).filter((r) => polarity === 'any' || r.polarity === polarity);

  return (
    <div>
      <div className="decision-bar">
        {DECISIONS.map((d) => (
          <button key={d} className={`btn sm ${d} ${current?.decision === d ? 'on' : ''}`} onClick={() => open(d)}>
            {DECISION_LABELS[d]}
          </button>
        ))}
        {current && (
          <button className="btn ghost sm" onClick={() => clear.mutate()} title="Remove the current decision (history is kept)">
            Clear
          </button>
        )}
      </div>
      {current && (
        <div className="small muted" style={{ marginTop: 6 }}>
          {DECISION_LABELS[current.decision as Decision]} on {date(current.decided_at, true)}
          {current.reasons?.length ? ` · ${current.reasons.map((c: string) => meta.data?.feedbackReasons.find((r) => r.code === c)?.label ?? c).join(', ')}` : ''}
          {current.explanation && <div className="evidence" style={{ fontStyle: 'normal' }}>“{current.explanation}”</div>}
        </div>
      )}
      {pending && (
        <Modal
          title={`${DECISION_LABELS[pending]} — why?`}
          onClose={() => setPending(null)}
          footer={
            <>
              <button className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button className="btn primary" disabled={save.isPending} onClick={() => save.mutate({ decision: pending, reasons, explanation: explanation.trim() || null })}>
                Save decision
              </button>
            </>
          }
        >
          <p className="muted small">Reasons are optional but teach the preference model which aspects drove your decision (agency, size, scope, set-aside…).</p>
          <div className="chips" style={{ marginBottom: 12 }}>
            {shown.map((r) => (
              <span key={r.code} className={`chip ${r.polarity === 'negative' ? 'neg' : ''} ${reasons.includes(r.code) ? 'on' : ''}`} onClick={() => setReasons((x) => (x.includes(r.code) ? x.filter((c) => c !== r.code) : [...x, r.code]))}>
                {r.label}
              </span>
            ))}
          </div>
          <label className="field">
            Explanation (optional)
            <textarea rows={3} value={explanation} onChange={(e) => setExplanation(e.target.value)} placeholder="e.g. Mostly cybersecurity operations. We can do the reporting portion but this is not a core capability." />
          </label>
        </Modal>
      )}
    </div>
  );
}
