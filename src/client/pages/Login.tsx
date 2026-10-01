import { useState } from 'react';
import { api } from '../api';

export function LoginPage({ onDone }: { onDone: () => void }) {
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
            await api.post('/api/auth/login', { password });
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
        <label className="field">
          Password
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="callout bad small" style={{ marginTop: 10 }}>{error}</div>}
        <button className="btn primary" style={{ marginTop: 14, width: '100%', justifyContent: 'center' }}>
          Sign in
        </button>
      </form>
    </div>
  );
}
