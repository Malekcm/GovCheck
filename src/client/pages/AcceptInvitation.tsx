import { useEffect,useRef,useState } from 'react';
import { api } from '../api';

export function AcceptInvitation() {
  const started=useRef(false);
  const [ready,setReady]=useState(false),[error,setError]=useState(''),[password,setPassword]=useState(''),[saving,setSaving]=useState(false);
  useEffect(()=>{
    if(started.current)return;started.current=true;
    const fragment=new URLSearchParams(window.location.hash.slice(1));
    window.history.replaceState(null,'','/auth/accept');
    const access_token=fragment.get('access_token'),refresh_token=fragment.get('refresh_token');
    if(!access_token||!refresh_token){setError('Open the secure invitation or password recovery link from your email.');return;}
    api.post('/api/auth/accept',{access_token,refresh_token}).then(()=>setReady(true)).catch(e=>setError(e.message));
  },[]);
  return <div className="card" style={{maxWidth:450,margin:'60px auto',padding:24}}><h1>Set your GovCheck password</h1><p role="status">{error}</p>{ready&&<form onSubmit={async e=>{
    e.preventDefault();setSaving(true);try{await api.post('/api/auth/password',{password});window.location.assign('/');}catch(e){setError(e instanceof Error?e.message:'Password update failed');setSaving(false);}
  }}><label className="field">New password<input type="password" autoComplete="new-password" minLength={12} required value={password} onChange={e=>setPassword(e.target.value)}/></label><button className="btn primary" disabled={saving}>Save password and continue</button></form>}</div>;
}
