import { Brand } from '../components/Brand';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Field } from '../components/ui';
import { api, type AuthStatus } from '../lib/api';
import { signInWithPlex } from '../lib/plex';

const SSO_ERRORS: Record<string, string> = {
  sso_disabled: 'Single sign-on is not set up.',
  base_url_missing: 'An admin needs to set the public URL in Settings before single sign-on works.',
  sso_unreachable: 'Could not reach the sign-on provider.',
  sso_state: 'That sign-in link expired. Please try again.',
  sso_failed: 'Single sign-on failed. Please try again.',
  sso_not_allowed: 'Your account is not in a group allowed to use this app.',
  sso_no_account: 'No account exists for you yet. Ask an admin to invite you.',
  sso_account_disabled: 'This account is disabled.',
  sso_already_linked: 'That account is already linked to another user.',
};

export function LoginPage({ status }: { status: AuthStatus }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => {
    const code = params.get('error');
    return code ? (SSO_ERRORS[code] ?? 'Sign-in failed.') : '';
  });
  const [busy, setBusy] = useState(false);

  const done = async () => {
    await qc.invalidateQueries();
    navigate('/');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { body: { username, password } });
      await done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const plex = async () => {
    setError('');
    setBusy(true);
    try {
      await signInWithPlex(false);
      await done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <Brand />
      <div className="card w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Sign in</h1>
        {error && <Alert>{error}</Alert>}
        {status.methods.oidc && (
          <a className="btn-primary w-full" href="/api/auth/oidc/start">
            {status.methods.oidc.label}
          </a>
        )}
        {status.methods.plex && (
          <button className="btn-secondary w-full" onClick={plex} disabled={busy}>
            Sign in with Plex
          </button>
        )}
        {(status.methods.oidc || status.methods.plex) && <div className="text-center text-xs text-muted">or</div>}
        <form onSubmit={submit} className="space-y-3">
          <Field label="Username">
            <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </Field>
          <Field label="Password">
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <button className="btn-secondary w-full" disabled={busy}>
            Sign in with password
          </button>
          {!status.methods.local && <p className="hint">Password sign-in is limited to the owner account.</p>}
        </form>
      </div>
    </div>
  );
}
