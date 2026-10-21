import { useState } from 'react';
import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Card,ErrorBox,Modal,toast } from './ui';

export function CaptureResearch({id}:{id:string}) {
  const qc=useQueryClient();
  const me=useQuery({queryKey:['me'],queryFn:()=>api.get<any>('/api/auth/me')});
  const assignments=useQuery({queryKey:['assignments',id],queryFn:()=>api.get<any>(`/api/opportunities/${id}/assignments`),enabled:!!me.data?.teamAuth});
  const [scope,setScope]=useState<any>(null),[selected,setSelected]=useState(''),[compare,setCompare]=useState('');
  const runs=useQuery({queryKey:['research',id],queryFn:()=>api.get<any[]>(`/api/opportunities/${id}/research`),enabled:!!me.data?.teamAuth,refetchInterval:q=>q.state.data?.some(r=>['queued','running'].includes(r.status))?5000:false});
  const refresh=()=>qc.invalidateQueries({queryKey:['research',id]});
  const preview=useMutation({mutationFn:()=>api.post(`/api/opportunities/${id}/research/preview`),onSuccess:setScope});
  const start=useMutation({mutationFn:()=>api.post(`/api/opportunities/${id}/research/run`,{hash:scope.hash,skillVersion:scope.skillVersion,model:scope.model,approvedCostUsd:scope.cost.estimate,acknowledgeExternalUsage:true,acknowledgeEstimatedCost:true}),onSuccess:()=>{setScope(null);refresh();toast('Research queued. You can continue working.');}});
  const action=useMutation({mutationFn:({runId,verb}:any)=>api.post(`/api/opportunities/${id}/research/${runId}/${verb}`,{acknowledgePossiblePriorCost:true}),onSuccess:refresh});
  if(!me.data?.teamAuth)return null;
  const canResearch=['admin','manager'].includes(me.data.user?.role)||(me.data.user?.role==='member'&&assignments.data?.assignments.some((a:any)=>a.user_id===me.data.user.user_id));
  const manager=['admin','manager'].includes(me.data.user?.role);
  const run=runs.data?.find(r=>r.id===selected)??runs.data?.[0];
  const prior=runs.data?.find(r=>r.id===compare);
  const deltas=run?.report&&prior?.report?run.report.answers.filter((a:any)=>{const old=prior.report.answers.find((p:any)=>p.id===a.id);return !old||old.status!==a.status||old.answer!==a.answer;}):[];
  return <Card id="research" title="Initial capture research" actions={canResearch?<button className="btn primary" disabled={preview.isPending||start.isPending} onClick={()=>preview.mutate()}>Conduct Initial Research</button>:null}>
    <p>Versioned federal opportunity capture workflow. Reports preserve evidence statuses and require human review.</p>
    {[runs.error,preview.error,start.error,action.error].filter(Boolean).map((e,i)=><ErrorBox key={i} error={e}/>)}
    {!runs.data?.length&&<p>No research runs yet.</p>}
    {!!runs.data?.length&&<><label className="field">Research run<select value={run?.id??''} onChange={e=>setSelected(e.target.value)}>{runs.data.map(r=><option key={r.id} value={r.id}>{new Date(r.created_at).toLocaleString()} · {r.status} · {r.initiated_by_name}</option>)}</select></label>
      <p role="status">{run?.status==='completed'?'Report ready':run?.status} · {run?.model} · {run?.skill_version}</p>
      {run?.error&&<p className="callout bad">{run.error}</p>}
      {canResearch&&['queued','running','failed'].includes(run?.status)&&<button className="btn" disabled={action.isPending} onClick={()=>{
        if(run.status==='failed'&&!window.confirm('Prior provider usage may have been billed. Retry this research run?'))return;
        action.mutate({runId:run.id,verb:run.status==='failed'?'retry':'cancel'});
      }}>{run.status==='failed'?'Retry with possible additional cost':'Cancel research'}</button>}
      {run?.report&&<><h3>{run.report.executiveSummary}</h3><p>{run.report.conditionalRecommendation}</p>
        <p>Initiated by {run.initiated_by_name} · Reviewed by {run.reviewed_by_name??'Awaiting review'} · Completed {new Date(run.completed_at).toLocaleString()}</p>
        <a className="btn" href={`/api/opportunities/${id}/research/${run.id}/report.docx`}>Download editable Word report</a>
        {manager&&<button className="btn" disabled={action.isPending} onClick={()=>action.mutate({runId:run.id,verb:'review'})}>Mark reviewed</button>}
        <label className="field">Compare with previous findings<select value={compare} onChange={e=>setCompare(e.target.value)}><option value="">Select a report</option>{runs.data?.filter(r=>r.report&&r.id!==run.id).map(r=><option key={r.id} value={r.id}>{new Date(r.created_at).toLocaleString()}</option>)}</select></label>
        {prior&&<div><p>{deltas.length} changed answers or verification statuses.</p>{deltas.map((a:any)=><p key={a.id}>{a.id}: {prior.report.answers.find((p:any)=>p.id===a.id)?.status??'Absent'} → {a.status} · {a.answer}</p>)}</div>}
        {run.report.sections.map((s:any,i:number)=><section key={i}><h3>{s.title}</h3><p style={{whiteSpace:'pre-wrap'}}>{s.text}</p><small>Evidence: {s.sourceIds.join(', ')||'OPEN'}</small></section>)}
        <h3>Risks</h3><ul>{run.report.risks.map((r:string,i:number)=><li key={i}>{r}</li>)}</ul>
        <h3>Capability and requirement matrix</h3><table className="data"><thead><tr><th>Requirement</th><th>Fit / evidence</th><th>Owner</th></tr></thead><tbody>{run.report.capabilityMatrix.map((m:any,i:number)=><tr key={i}><td>{m.requirement}</td><td>{m.fit} · {m.status}<p>{m.evidence}</p></td><td>{m.owner}</td></tr>)}</tbody></table>
        <h3>Next actions</h3>{run.report.nextActions.map((a:any,i:number)=><p key={i}>{a.owner} · {a.dueDate??'Due date open'} · {a.action}</p>)}
        <details><summary>Answer register and unresolved questions</summary>{run.report.answers.map((a:any)=><div key={a.id}><h4>{a.id} · {a.status}</h4><p>{a.answer}</p><p>{a.evidenceRequest} · Owner: {a.owner} · Checked: {a.checkedOn} · Sources: {a.sourceIds.join(', ')||'OPEN'}</p></div>)}</details>
        <details><summary>Source and query registers</summary>{run.report.sources.map((s:any)=><p key={s.id}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> · {s.id} · {s.retrievedAt} · {s.caveat}</p>)}{run.report.queryLog.map((q:any,i:number)=><p key={i}>{q.checkedOn} · {q.surface} · {q.query} · {q.result}</p>)}</details>
        <ResearchFeedback key={run.id} id={id} runId={run.id} editable={canResearch}/>
      </>}
    </>}
    {scope&&<Modal title="Confirm initial capture research" onClose={()=>setScope(null)}><p>Company: {scope.company??'Not configured'} · {scope.sourceCount} sources · {scope.documentCount} documents</p><p>{scope.externalUsage}</p>
      <p>Expected cost: {scope.cost.estimate==null?'Administrator must configure pricing':`$${scope.cost.estimate} USD`} · {scope.cost.notice}</p><p>Missing: {scope.missing.join('; ')||'Research will validate evidence and eligibility gates.'}</p>
      <button className="btn primary" disabled={start.isPending||scope.cost.estimate==null} onClick={()=>start.mutate()}>Approve scope, cost and external use</button>{start.error&&<ErrorBox error={start.error}/>}</Modal>}
  </Card>;
}

function ResearchFeedback({id,runId,editable}:{id:string;runId:string;editable:boolean}) {
  const [body,setBody]=useState('');
  const qc=useQueryClient();
  const queryKey=['research-feedback',runId];
  const feedback=useQuery({queryKey,queryFn:()=>api.get<any[]>(`/api/opportunities/${id}/research/${runId}/feedback`)});
  const save=useMutation({mutationFn:()=>api.post(`/api/opportunities/${id}/research/${runId}/feedback`,{body}),onSuccess:()=>{setBody('');qc.invalidateQueries({queryKey});}});
  return <section><h3>Review feedback</h3>{feedback.data?.map(f=><p key={f.id}>{f.name} · {new Date(f.created_at).toLocaleString()} · {f.body}</p>)}{feedback.error&&<ErrorBox error={feedback.error}/>}{save.error&&<ErrorBox error={save.error}/>}{editable&&<form onSubmit={e=>{e.preventDefault();save.mutate();}}><label className="field">Feedback<textarea value={body} onChange={e=>setBody(e.target.value)} required maxLength={10000}/></label><button className="btn" disabled={save.isPending}>Save feedback</button></form>}</section>;
}
