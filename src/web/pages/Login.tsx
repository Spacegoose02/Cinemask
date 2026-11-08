import { Brand } from '../components/Brand';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Alert, Field } from '../components/ui';
import { api, type AuthStatus } from '../lib/api';
import { useAuth } from '../lib/auth';
import { signInWithPlex } from '../lib/plex';
import { passkeysSupported, signInWithPasskey } from '../lib/passkeys';
import { useT } from '../lib/i18n';

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
  const t = useT();
  const [params] = useSearchParams();
  const { expired } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(() => {
    const code = params.get('error');
    return code ? t(SSO_ERRORS[code] ?? 'Sign-in failed.') : '';
  });
  const [busy, setBusy] = useState(false);
  const [second, setSecond] = useState<{ token: string; methods: string[] } | null>(null);
  const [code, setCode] = useState('');

  // Once signed in, the app sends them on to the page they were trying to open.
  const done = async () => {
    await qc.invalidateQueries();
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ ok: boolean; twoFactor?: { token: string; methods: string[] } }>('/api/auth/login', { body: { username, password } });
      if (res.twoFactor) {
        setSecond(res.twoFactor);
        setPassword('');
        return;
      }
      await done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const withBusy = async (fn: () => Promise<unknown>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await done();
    } catch (err) {
      const e = err as Error;
      // The person closed the passkey prompt: nothing to report.
      if (e.name !== 'NotAllowedError') setError(e.message);
      if (/Sign in again|took too long/.test(e.message)) setSecond(null);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    void withBusy(() => api('/api/auth/login/2fa', { body: { token: second!.token, code } }));
  };

  if (second) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
        <Brand />
        <div className="card w-full max-w-sm space-y-4">
          <h1 className="text-xl font-semibold">{t('One more step')}</h1>
          {error && <Alert>{error}</Alert>}
          {second.methods.includes('passkey') && passkeysSupported() && (
            <button className="btn-primary w-full" disabled={busy} onClick={() => void withBusy(() => signInWithPasskey(second.token))}>
              {t('Use a passkey')}
            </button>
          )}
          {(second.methods.includes('totp') || second.methods.includes('recovery')) && (
            <form onSubmit={submitCode} className="space-y-3">
              <Field label={t(second.methods.includes('totp') ? 'Code from your authenticator app' : 'Recovery code')} hint={second.methods.includes('recovery') ? t('Lost your phone? A recovery code works here too.') : undefined}>
                <input className="input" autoComplete="one-time-code" inputMode={second.methods.includes('totp') ? 'numeric' : 'text'} autoFocus value={code} onChange={(e) => setCode(e.target.value)} required />
              </Field>
              <button className="btn-secondary w-full" disabled={busy || !code}>
                {t('Sign in')}
              </button>
            </form>
          )}
          <button className="text-sm text-muted underline" onClick={() => (setSecond(null), setCode(''), setError(''))}>
            {t('Start again')}
          </button>
        </div>
      </div>
    );
  }

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
        <h1 className="text-xl font-semibold">{t('Sign in')}</h1>
        {error && <Alert>{error}</Alert>}
        {!error && expired && <Alert kind="info">{t('You were signed out. Sign in again to carry on.')}</Alert>}
        {status.methods.oidc && (
          <a className="btn-primary w-full" href="/api/auth/oidc/start">
            {status.methods.oidc.label}
          </a>
        )}
        {status.methods.plex && (
          <button className="btn-secondary w-full" onClick={plex} disabled={busy}>
            {t('Sign in with Plex')}
          </button>
        )}
        {status.methods.passkey && passkeysSupported() && (
          <button className="btn-secondary w-full" onClick={() => void withBusy(() => signInWithPasskey())} disabled={busy}>
            {t('Sign in with a passkey')}
          </button>
        )}
        {(status.methods.oidc || status.methods.plex || (status.methods.passkey && passkeysSupported())) && <div className="text-center text-xs text-muted">{t('or')}</div>}
        <form onSubmit={submit} className="space-y-3">
          <Field label={t('Username')}>
            <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
          </Field>
          <Field label={t('Password')}>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <button className="btn-secondary w-full" disabled={busy}>
            {t('Sign in with password')}
          </button>
          {!status.methods.local && <p className="hint">{t('Password sign-in is limited to the owner account.')}</p>}
        </form>
      </div>
    </div>
  );
}
