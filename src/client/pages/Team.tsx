import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, ErrorBox, Loading, toast } from '../components/ui';

export function TeamPage() {
  const qc=useQueryClient();
  const members=useQuery({queryKey:['team-members'],queryFn:()=>api.get<any[]>('/api/team/members')});
  const me=useQuery({queryKey:['me'],queryFn:()=>api.get<any>('/api/auth/me')});
  const [email,setEmail]=useState(''),[name,setName]=useState(''),[role,setRole]=useState('member');
  const invite=useMutation({mutationFn:()=>api.post('/api/team/admin/invite',{email,name,role}),onSuccess:()=>{setEmail('');setName('');qc.invalidateQueries({queryKey:['team-members']});toast('Invitation sent.');}});
  const update=useMutation({mutationFn:(m:any)=>api.put(`/api/team/admin/members/${m.user_id}`,{name:m.name,role:m.role,active:m.active}),onSuccess:()=>{qc.invalidateQueries({queryKey:['team-members']});toast('Team member updated.');}});
  if(me.data?.user?.role!=='admin') return <p>Administrator access required.</p>;
  return <><h1>Team Management</h1><Card title="Invite a colleague"><form onSubmit={e=>{e.preventDefault();invite.mutate();}} className="row">
    <label className="field">Name<input required value={name} onChange={e=>setName(e.target.value)}/></label>
    <label className="field">Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label>
    <label className="field">Role<select value={role} onChange={e=>setRole(e.target.value)}>{['admin','manager','member','viewer'].map(r=><option key={r}>{r}</option>)}</select></label>
    <button className="btn primary" disabled={invite.isPending}>Send invitation</button>
  </form>{invite.error&&<ErrorBox error={invite.error}/>}</Card>
    <Card title="Team members">{members.isLoading&&<Loading/>}{members.error&&<ErrorBox error={members.error}/>}{update.error&&<ErrorBox error={update.error}/>}
      {(members.data??[]).map(m=><div key={`${m.user_id}-${m.name}-${m.role}-${m.active}`} className="row" style={{marginBottom:12}}>
        <label className="field">Name<input defaultValue={m.name} disabled={update.isPending} onBlur={e=>{if(e.target.value!==m.name)update.mutate({...m,name:e.target.value});}}/></label><span>{m.email}</span>
        <label className="field">Role<select value={m.role} disabled={update.isPending} onChange={e=>update.mutate({...m,role:e.target.value})}>{['admin','manager','member','viewer'].map(r=><option key={r}>{r}</option>)}</select></label>
        <button className="btn" disabled={update.isPending} onClick={()=>update.mutate({...m,active:!m.active})}>{m.active?'Deactivate':'Activate'}</button>
      </div>)}
    </Card></>;
}
export function WorkloadPage({mine=false}:{mine?:boolean}) {
  const rows=useQuery({queryKey:['workload',mine],queryFn:()=>api.get<any[]>(`/api/team/workload?mine=${mine}`)});
  return <><h1>{mine?'My Work':'Team Workload'}</h1>{rows.isLoading&&<Loading/>}{rows.error&&<ErrorBox error={rows.error}/>}
    <Card title="Assignments and research follow-up" bodyClass="table-wrap"><table className="data"><thead><tr><th>Member</th><th>Opportunity</th><th>Role and status</th><th>Capture stage</th><th>Next action</th><th>Due date</th></tr></thead><tbody>
      {(rows.data??[]).map((r,i)=><tr key={r.assignment_id??`empty-${i}`}><td>{r.name}</td><td>{r.opportunity_id?<Link to={`/opportunities/${r.opportunity_id}`}>{r.title}</Link>:'No assignments'}</td><td>{r.assignment_role} · {r.status}</td><td>{r.pursuit_stage??r.stage}</td><td>{r.next_action}</td><td style={{color:r.overdue?'#b42318':undefined}}>{r.due_date}{r.overdue?' · Overdue':''}</td></tr>)}
    </tbody></table></Card></>;
}
