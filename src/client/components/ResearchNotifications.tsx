import { useQuery,useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';

export function ResearchNotifications() {
  const qc=useQueryClient();
  const me=useQuery({queryKey:['me'],queryFn:()=>api.get<any>('/api/auth/me')});
  const notifications=useQuery({queryKey:['research-notifications'],queryFn:()=>api.get<any[]>('/api/team/notifications'),enabled:!!me.data?.teamAuth,refetchInterval:30000});
  if(!notifications.data?.length)return null;
  return <details><summary>{notifications.data.length} research report{notifications.data.length===1?'':'s'} ready</summary>{notifications.data.map(n=><p key={n.id}><Link to={`/opportunities/${n.opportunity_id}#research`} onClick={async()=>{await api.post(`/api/team/notifications/${n.id}/read`);qc.invalidateQueries({queryKey:['research-notifications']});}}>Research ready: {n.title}</Link></p>)}</details>;
}
