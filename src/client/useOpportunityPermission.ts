import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export function useOpportunityPermission(id:string) {
  const me=useQuery({queryKey:['me'],queryFn:()=>api.get<any>('/api/auth/me')});
  const assignments=useQuery({queryKey:['assignments',id],queryFn:()=>api.get<any>(`/api/opportunities/${id}/assignments`),enabled:!!me.data?.teamAuth&&me.data.user?.role==='member'});
  const teamAuth=!!me.data?.teamAuth;
  const manager=['admin','manager'].includes(me.data?.user?.role);
  const assigned=me.data?.user?.role==='member'&&assignments.data?.assignments.some((a:any)=>a.user_id===me.data.user.user_id);
  return {teamAuth,canEdit:!!me.data&&(!teamAuth||manager||!!assigned),manager};
}
