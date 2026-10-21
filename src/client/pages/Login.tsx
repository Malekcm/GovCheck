import { useState } from 'react';
import { api } from '../api';

export function LoginPage({ onDone, teamAuth = false }: { onDone: () => void; teamAuth?: boolean }) {
  const [email,setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <form
        className="card"
        style={{ padding: 24, width: 340 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.post('/api/auth/login', { password, ...(teamAuth ? { email } : {}) });
            onDone();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Login failed');
          }
        }}
      >
        <div className="row" style={{ marginBottom: 14 }}>
          <img src="/favicon.svg" width={28} height={28} alt="" />
          <h1>GovCheck</h1>
        </div>
        {teamAuth && <label className="field">Email<input type="email" autoComplete="username" required value={email} onChange={e=>setEmail(e.target.value)} /></label>}
        <label className="field">
          Password
          <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {teamAuth && <button type="button" className="btn ghost" onClick={async()=>{try{await api.post('/api/auth/reset',{email});setError('If your account exists, check your email for a recovery link.');}catch(e){setError(e instanceof Error?e.message:'Recovery request failed');}}}>Reset password</button>}
        {error && <div className="callout bad small" style={{ marginTop: 10 }}>{error}</div>}
        <button className="btn primary" style={{ marginTop: 14, width: '100%', justifyContent: 'center' }}>
          Sign in
        </button>
      </form>
    </div>
  );
}
