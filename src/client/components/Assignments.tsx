import { useMutation,useQuery,useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Card,ErrorBox,Loading,toast } from './ui';

const statuses=['Not Started','Researching','Awaiting Review','Complete','Blocked'];
export function Assignments({id}:{id:string}) {
  const qc=useQueryClient();
  const me=useQuery({queryKey:['me'],queryFn:()=>api.get<any>('/api/auth/me')});
  const team=!!me.data?.teamAuth;
  const queryKey=['assignments',id];
  const state=useQuery({queryKey,queryFn:()=>api.get<any>(`/api/opportunities/${id}/assignments`),enabled:team});
  const members=useQuery({queryKey:['team-members'],queryFn:()=>api.get<any[]>('/api/team/members'),enabled:team});
  const manager=['admin','manager'].includes(me.data?.user?.role);
  const save=useMutation({mutationFn:(assignments:any[])=>api.put(`/api/opportunities/${id}/assignments`,{requestId:crypto.randomUUID(),revision:state.data.revision,assignments}),
    onSuccess:data=>{qc.setQueryData(queryKey,data);qc.invalidateQueries({queryKey:['workload']});toast('Assignments saved.');},onError:()=>{qc.invalidateQueries({queryKey});}});
  const progress=useMutation({mutationFn:({assignmentId,...change}:any)=>api.put(`/api/opportunities/${id}/assignment-progress/${assignmentId}`,change),onSuccess:()=>{qc.invalidateQueries({queryKey});qc.invalidateQueries({queryKey:['workload']});toast('Progress saved.');}});
  if(!team)return null;
  const rows=state.data?.assignments??[];
  const normalized=rows.map((a:any)=>({userId:a.user_id,role:a.assignment_role,status:a.status,nextAction:a.next_action,dueDate:a.due_date}));
  const add=(userId:string,role:string)=>({userId,role,status:'Not Started',nextAction:null,dueDate:null});
  const change=(row:any,values:any)=>{
    if(manager)save.mutate(normalized.map((a:any)=>a.userId===row.user_id?{...a,...values}:a));
    else progress.mutate({assignmentId:row.id,status:values.status??row.status,nextAction:values.nextAction===undefined?row.next_action:values.nextAction,dueDate:values.dueDate===undefined?row.due_date:values.dueDate});
  };
  return <Card id="assignments" title="Opportunity ownership and collaboration">
    {state.isLoading&&<Loading/>}{state.error&&<ErrorBox error={state.error}/>}{save.error&&<ErrorBox error={save.error}/>}{progress.error&&<ErrorBox error={progress.error}/>}
    {manager&&state.data&&<div className="row"><label className="field">Primary Owner<select disabled={save.isPending} value={rows.find((a:any)=>a.assignment_role==='owner')?.user_id??''} onChange={e=>{
      const user=e.target.value;save.mutate([...normalized.filter((a:any)=>a.role!=='owner'&&a.userId!==user),...(user?[{...(normalized.find((a:any)=>a.userId===user)??add(user,'owner')),role:'owner'}]:[])]);
    }}><option value="">Unassigned</option>{members.data?.filter(m=>m.active).map(m=><option key={m.user_id} value={m.user_id}>{m.name} ({m.email})</option>)}</select></label>
      <label className="field">Collaborators<select multiple disabled={save.isPending} value={rows.filter((a:any)=>a.assignment_role==='collaborator').map((a:any)=>a.user_id)} onChange={e=>{
        save.mutate([...normalized.filter((a:any)=>a.role==='owner'),...[...e.target.selectedOptions].map(o=>normalized.find((a:any)=>a.userId===o.value)??add(o.value,'collaborator'))]);
      }}>{members.data?.filter(m=>m.active&&!rows.some((a:any)=>a.user_id===m.user_id&&a.assignment_role==='owner')).map(m=><option key={m.user_id} value={m.user_id}>{m.name} ({m.email})</option>)}</select></label></div>}
    {rows.map((row:any)=>{const editable=manager||(me.data?.user?.role==='member'&&row.user_id===me.data?.user?.user_id);return <div key={`${row.id}-${row.version}`} style={{marginTop:16}}><strong>{row.name} · {row.assignment_role}</strong>
      <div className="row"><label className="field">Status<select value={row.status} disabled={!editable||save.isPending||progress.isPending} onChange={e=>change(row,{status:e.target.value})}>{statuses.map(s=><option key={s}>{s}</option>)}</select></label>
      <label className="field">Next action<input defaultValue={row.next_action??''} disabled={!editable||save.isPending||progress.isPending} onBlur={e=>{if(e.target.value!==(row.next_action??''))change(row,{nextAction:e.target.value||null});}}/></label>
      <label className="field">Due date<input type="date" value={row.due_date??''} disabled={!editable||save.isPending||progress.isPending} onChange={e=>change(row,{dueDate:e.target.value||null})}/></label></div>
      <p className="small muted">Assigned by {row.assigned_by_name??'Historical actor unknown'} · {new Date(row.assigned_at).toLocaleString()}</p></div>;})}
    {!rows.length&&<p>No structured assignments. Legacy capture owner text is retained in the capture plan.</p>}
    <details><summary>Recent assignment history</summary>{state.data?.history.map((h:any)=><p key={h.id}>{new Date(h.created_at).toLocaleString()} · {h.actor_name??'Historical actor unknown'} · {h.changes.type ? h.changes.type.replace(/_/g,' ') : h.changes.request?.map((a:any)=>`${members.data?.find(m=>m.user_id===a.userId)?.name??a.userId}: ${a.role}, ${a.status}`).join('; ')||'Assignments cleared'}</p>)}</details>
  </Card>;
}
