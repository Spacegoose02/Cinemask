import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, Field, LoadError } from '../components/ui';
import { api, formatDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { signInWithPlex } from '../lib/plex';
import { ApiKeys } from '../components/ApiKeys';
import { ThemePicker } from '../components/ThemePicker';

interface SessionRow {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  ip: string | null;
  userAgent: string | null;
}

export function AccountPage() {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(
    params.get('linked') ? { kind: 'success', text: 'Account linked.' } : null,
  );
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<SessionRow[]>('/api/auth/sessions') });
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api<{ methods: { oidc: { label: string } | null; plex: boolean } }>('/api/auth/status') });

  const changePassword = useMutation({
    mutationFn: () => api('/api/auth/password', { body: { currentPassword: current || undefined, newPassword: next } }),
    onSuccess: async () => {
      setCurrent('');
      setNext('');
      setMsg({ kind: 'success', text: 'Password changed. Your other devices were signed out.' });
      await refresh();
    },
    onError: (e) => setMsg({ kind: 'error', text: (e as Error).message }),
  });

  const revoke = async (id: string) => {
    setMsg(null);
    try {
      await api(`/api/auth/sessions/${id}`, { method: 'DELETE' });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
    await qc.invalidateQueries({ queryKey: ['sessions'] });
  };

  const linkPlex = async () => {
    try {
      await signInWithPlex(true);
      setMsg({ kind: 'success', text: 'Plex account linked.' });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Account</h1>
      <LoadError queries={[sessions]} />
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}

      <section className="card space-y-3">
        <h2 className="font-semibold">Appearance</h2>
        <ThemePicker current={me?.theme ?? null} />
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">{me?.hasPassword ? 'Change password' : 'Set a password'}</h2>
        {me?.hasPassword && (
          <Field label="Current password">
            <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
        )}
        <Field label="New password" hint="At least 12 characters.">
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <button className="btn-primary" disabled={!next || changePassword.isPending} onClick={() => changePassword.mutate()}>
          Save password
        </button>
      </section>

      {(status.data?.methods.oidc || status.data?.methods.plex) && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Linked sign-in</h2>
          <p className="text-sm text-muted">Link an outside account so you can sign in with it.</p>
          <div className="flex flex-wrap gap-2">
            {status.data.methods.oidc && (
              <a className="btn-secondary" href="/api/auth/oidc/start?link=1">
                Link {status.data.methods.oidc.label}
              </a>
            )}
            {status.data.methods.plex && (
              <button className="btn-secondary" onClick={linkPlex}>
                Link Plex
              </button>
            )}
          </div>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="font-semibold">Signed-in devices</h2>
        <ul className="divide-y divide-border">
          {sessions.data?.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate">{s.userAgent || 'Unknown device'}</div>
                <div className="text-xs text-muted">
                  {s.ip} · last active {formatDate(s.lastSeenAt)}
                </div>
              </div>
              {s.current ? (
                <span className="text-xs text-success">This device</span>
              ) : (
                <button className="btn-danger" onClick={() => revoke(s.id)}>
                  Sign out
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
      <ApiKeys />
    </div>
  );
}
