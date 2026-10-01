import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { date, moneyRange, pct, titleize } from '../format';
import { Card, Empty, ErrorBox, Loading, SourceBadges, StageBadge, toast } from '../components/ui';

function Side({ o }: { o: any }) {
  return (
    <div className="stack small">
      <div>
        <StageBadge stage={o.stage} /> <SourceBadges ids={o.connector_ids} />
      </div>
      <Link to={`/opportunities/${o.id}`} style={{ fontWeight: 600, fontSize: 13 }}>
        {o.title}
      </Link>
      <div className="kv">
        <div className="k">Solicitation #</div>
        <div className="mono">{o.solicitation_number ?? '—'}</div>
        <div className="k">Agency / office</div>
        <div>{[o.subtier_name ?? o.department_name, o.office_name].filter(Boolean).join(' › ') || '—'}</div>
        <div className="k">NAICS / PSC</div>
        <div className="mono">
          {o.naics_code ?? '—'} / {o.psc_code ?? '—'}
        </div>
        <div className="k">Posted / deadline</div>
        <div>
          {date(o.posted_at)} / {date(o.response_deadline)}
        </div>
        <div className="k">Value</div>
        <div>{moneyRange(o.value_low, o.value_high)}</div>
      </div>
      <div className="muted" style={{ maxHeight: 90, overflow: 'hidden' }}>
        {(o.description ?? '').replace(/<[^>]+>/g, ' ').slice(0, 400)}
      </div>
    </div>
  );
}

export function MergeReviewPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState('suggested');
  const q = useQuery({ queryKey: ['merge', status], queryFn: () => api.get<any[]>(`/api/merge/candidates?status=${status}`) });
  const history = useQuery({ queryKey: ['merge-history'], queryFn: () => api.get<any[]>('/api/merge/history') });
  const act = useMutation({
    mutationFn: (b: any) => api.post('/api/merge/action', b),
    onSuccess: (_r, b) => {
      toast(b.action === 'merge' ? 'Merged. You can undo this below.' : 'Saved.');
      qc.invalidateQueries();
    },
    onError: (e: Error) => toast(e.message),
  });
  const undo = useMutation({ mutationFn: (id: string) => api.post(`/api/merge/${id}/undo`), onSuccess: () => (toast('Merge undone.'), qc.invalidateQueries()), onError: (e: Error) => toast(e.message) });
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Merge review</h1>
          <p>Possible duplicates and lifecycle links found by probabilistic matching. Nothing is merged without your decision; every merge can be undone and user notes/decisions move with the records.</p>
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="suggested">Awaiting review</option>
          <option value="confirmed">Confirmed links</option>
          <option value="rejected">Kept separate</option>
        </select>
      </div>
      {q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : q.data!.length ? (
        q.data!.map((r) => (
          <Card
            key={r.id}
            title={
              <div className="row">
                <span className="badge warn">{titleize(r.relationship_type)}</span>
                <span className="num">{pct(r.confidence)} confidence</span>
                <span className="small muted">{r.method}</span>
              </div>
            }
            actions={
              status === 'suggested' && (
                <>
                  <button className="btn sm primary" onClick={() => act.mutate({ action: 'merge', primaryId: r.a.id, secondaryId: r.b.id, relationshipId: r.id })}>
                    Merge (keep left)
                  </button>
                  <button className="btn sm" onClick={() => act.mutate({ action: 'link_related', primaryId: r.a.id, secondaryId: r.b.id, relationshipId: r.id })}>
                    Link as related
                  </button>
                  <button className="btn sm" onClick={() => act.mutate({ action: 'mark_predecessor', primaryId: r.a.id, secondaryId: r.b.id, relationshipId: r.id })} title="Right is the predecessor of left">
                    Right is predecessor
                  </button>
                  <button className="btn sm" onClick={() => act.mutate({ action: 'mark_successor', primaryId: r.a.id, secondaryId: r.b.id, relationshipId: r.id })} title="Right is the successor of left">
                    Right is successor
                  </button>
                  <button className="btn sm ghost" onClick={() => act.mutate({ action: 'keep_separate', primaryId: r.a.id, secondaryId: r.b.id, relationshipId: r.id })}>
                    Keep separate
                  </button>
                </>
              )
            }
          >
            <div className="small muted" style={{ marginBottom: 8 }}>
              Evidence: {(r.evidence ?? []).join(' · ')}
            </div>
            <div className="grid grid-2">
              <Side o={r.a} />
              <Side o={r.b} />
            </div>
          </Card>
        ))
      ) : (
        <Card>
          <Empty title="Nothing to review" />
        </Card>
      )}
      <Card title="Merge history" bodyClass="">
        {history.data?.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Profiles</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.data.map((m) => (
                <tr key={m.id}>
                  <td className="small nowrap">{date(m.created_at, true)}</td>
                  <td>
                    {titleize(m.action)} {m.undone_at && <span className="badge neutral">undone</span>}
                  </td>
                  <td className="small">
                    <Link to={`/opportunities/${m.primary_id}`}>{m.primary_title}</Link> ← <Link to={`/opportunities/${m.secondary_id}`}>{m.secondary_title}</Link>
                  </td>
                  <td>
                    {m.action === 'merge' && !m.undone_at && (
                      <button className="btn sm" onClick={() => undo.mutate(m.id)}>
                        Undo merge
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="card-body muted">No merge decisions yet.</div>
        )}
      </Card>
    </div>
  );
}
