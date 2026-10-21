import { useState } from 'react';
import { api } from '../api';

export function NeonLogin({ onDone, allowedDomains=[] }: { onDone: () => void; allowedDomains?:string[] }) {
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[otp,setOtp]=useState('');
  const [mode,setMode]=useState<'code'|'password'|'reset'>('code');
  const [sent,setSent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  async function sendCode() {
    setBusy(true);setError('');setMessage('');
    try {
      const result=await api.post<{message:string}>(mode==='reset'?'/api/auth/reset':'/api/auth/code',{email});
      setSent(true);setMessage(result.message);
    } catch(e) {setError(e instanceof Error?e.message:'Email request failed.');}
    finally {setBusy(false);}
  }
  return <div style={{display:'grid',placeItems:'center',minHeight:'100vh'}}><div className="card" style={{padding:24,width:380,maxWidth:'95vw'}}>
    <div className="row"><img src="/favicon.svg" width={28} height={28} alt=""/><h1>GovCheck</h1></div>
    <p>{mode==='reset'?'Set or reset your password':mode==='code'?'Sign in with a code sent to your email':'Sign in with your password'}</p>
    <p className="small muted">{allowedDomains.length?`Only invited ${allowedDomains.map(d=>`@${d}`).join(', ')} accounts can sign in.`:'Your administrator must add you to the team before you can sign in.'} Ask your administrator to invite you through Team Management.</p>
    <form onSubmit={async e=>{
      e.preventDefault();
      if(mode!=='password'&&!sent){await sendCode();return;}
      setBusy(true);setError('');
      try {
        if(mode==='reset') await api.post('/api/auth/password',{email,otp,password});
        else await api.post('/api/auth/login',{email,...(mode==='code'?{otp}:{password})});
        onDone();
      } catch(e) {setError(e instanceof Error?e.message:'Sign-in failed.');setBusy(false);}
    }}>
      <label className="field">Email<input type="email" autoComplete="username" required value={email} disabled={busy} onChange={e=>{setEmail(e.target.value);setSent(false);setOtp('');setMessage('');}}/></label>
      {mode!=='password'&&sent&&<label className="field">Email code<input autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6,8}" minLength={6} maxLength={8} required value={otp} onChange={e=>setOtp(e.target.value)}/></label>}
      {(mode==='password'||mode==='reset'&&sent)&&<label className="field">{mode==='reset'?'New password (12 characters minimum)':'Password'}<input type="password" autoComplete={mode==='reset'?'new-password':'current-password'} required minLength={mode==='reset'?12:1} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
      {message&&<p role="status">{message}</p>}{error&&<p className="callout bad" role="alert">{error}</p>}
      <button className="btn primary" disabled={busy} style={{marginTop:14,width:'100%',justifyContent:'center'}}>{busy?'Please wait…':mode!=='password'&&!sent?'Send email code':mode==='reset'?'Save password and sign in':'Sign in'}</button>
    </form>
    {sent&&mode!=='password'&&<button className="btn ghost" disabled={busy} onClick={sendCode}>Resend code</button>}
    <div className="row" style={{marginTop:12}}>{(['code','password','reset'] as const).filter(m=>m!==mode).map(m=><button key={m} className="btn ghost" disabled={busy} onClick={()=>{setMode(m);setSent(false);setOtp('');setPassword('');setError('');setMessage('');}}>{m==='code'?'Use email code':m==='password'?'Use password':'Set / reset password'}</button>)}</div>
  </div></div>;
}
