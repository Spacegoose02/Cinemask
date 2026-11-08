import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Brand } from '../components/Brand';
import { Alert, Field } from '../components/ui';
import { api } from '../lib/api';

interface InviteInfo {
  valid: boolean;
  message?: string;
  label?: string | null;
  password?: boolean;
  plex?: boolean;
  plexShare?: boolean;
  jellyfin?: boolean;
}

/** /invite/:code — someone with an invite link makes their own account. */
export function InvitePage() {
  const { code = '' } = useParams();
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['invite', code], queryFn: () => api<InviteInfo>(`/api/invites/open/${encodeURIComponent(code)}`), retry: false });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const done = () => qc.invalidateQueries();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/api/invites/open/${encodeURIComponent(code)}`, { body: { username, password, email } });
      await done();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const plex = async () => {
    setBusy(true);
    setError('');
    const popup = window.open('about:blank', 'plex-auth', 'width=600,height=700');
    try {
      const { state, authUrl } = await api<{ state: string; authUrl: string }>(`/api/invites/open/${encodeURIComponent(code)}/plex`, { body: {} });
      if (popup) popup.location.href = authUrl;
      else window.open(authUrl, '_blank', 'noopener');
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await api<{ done: boolean; ok?: boolean; error?: string }>('/api/invites/plex/poll', { body: { state } });
        if (!res.done) continue;
        popup?.close();
        if (!res.ok) throw new Error(res.error ?? 'Joining with Plex failed');
        await done();
        return;
      }
      throw new Error('That took too long. Try again.');
    } catch (err) {
      popup?.close();
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const d = info.data;
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4">
      <Brand />
      <div className="card w-full max-w-sm space-y-4">
        {!d ? (
          <p className="text-muted">{info.isError ? (info.error as Error).message : 'Loading…'}</p>
        ) : !d.valid ? (
          <>
            <Alert>{d.message}</Alert>
            <Link to="/login" className="text-sm underline">
              Go to sign in
            </Link>
          </>
        ) : (
          <>
            <div>
              <h1 className="text-xl font-semibold">You're invited</h1>
              <p className="text-sm text-muted">Make your account to browse, request and follow what the household is watching.{d.plexShare ? ' Joining with Plex also shares the Plex server with you.' : ''}</p>
            </div>
            {error && <Alert>{error}</Alert>}
            {d.plex && (
              <button className="btn-primary w-full" onClick={plex} disabled={busy}>
                Join with Plex
              </button>
            )}
            {d.plex && d.password && <div className="text-center text-xs text-muted">or</div>}
            {d.password && (
              <form onSubmit={submit} className="space-y-3">
                <Field label="Username">
                  <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
                </Field>
                <Field label="Password" hint="At least 12 characters.">
                  <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </Field>
                <Field label="Email (optional)" hint="For notifications, if you want them.">
                  <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <button className="btn-secondary w-full" disabled={busy}>
                  Make my account
                </button>
                {d.jellyfin && <p className="hint">You'll get a Jellyfin account with the same username and password.</p>}
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
