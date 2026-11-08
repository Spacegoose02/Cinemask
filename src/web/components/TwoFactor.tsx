import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDate } from '../lib/api';
import { useAuth } from '../lib/auth';
import { addPasskey, passkeysSupported } from '../lib/passkeys';
import { Alert, Field } from './ui';

interface State {
  totp: boolean;
  passkeys: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[];
  recoveryLeft: number;
}

/** Account → Sign-in security: an authenticator app, passkeys and recovery codes. */
export function TwoFactor() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['2fa'], queryFn: () => api<State>('/api/auth/2fa') });
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ token: string; secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  if (!q.data) return null;
  const d = q.data;
  const any = d.totp || d.passkeys.length > 0;
  // Changing sign-in settings asks for the password again (or, without one, a code).
  const confirm = me?.hasPassword ? { password } : { code };
  const ready = me?.hasPassword ? password.length > 0 : !any || code.length > 0;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ kind: 'success', text: ok });
      await qc.invalidateQueries({ queryKey: ['2fa'] });
    } catch (e) {
      const err = e as Error;
      if (err.name !== 'NotAllowedError') setMsg({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="font-semibold">Two-factor sign-in</h2>
        <p className="text-sm text-muted">
          With an authenticator app or a passkey, someone who learns your password still can't sign in. A passkey (your phone, computer or security key) also signs you in on its own, without the password.
        </p>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {codes && (
        <Alert kind="info">
          <div className="space-y-2">
            <p>Save these recovery codes somewhere safe. Each one signs you in once if you lose your phone or passkey. They won't be shown again.</p>
            <pre className="grid grid-cols-2 gap-1 font-mono text-sm">{codes.join('\n')}</pre>
            <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setCodes(null)}>
              I've saved them
            </button>
          </div>
        </Alert>
      )}
      {me?.hasPassword ? (
        <Field label="Your password" hint="Needed to change these settings.">
          <input className="input max-w-xs" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      ) : (
        any && (
          <Field label="A code from your app, or a recovery code" hint="Needed to change these settings.">
            <input className="input max-w-xs" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )
      )}

      <div className="space-y-2">
        <div className="label">Authenticator app</div>
        {d.totp ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>On</span>
            <button className="btn-secondary px-2 py-1 text-xs" disabled={busy || !ready} onClick={() => run(() => api('/api/auth/2fa/totp/disable', { body: confirm }), 'Authenticator app turned off.')}>
              Turn off
            </button>
          </div>
        ) : setup ? (
          <div className="space-y-3">
            <p className="text-sm">Scan this with an authenticator app (Google Authenticator, 1Password, Bitwarden, Authy…), then type the code it shows.</p>
            <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr)}`} alt="QR code for your authenticator app" className="h-44 w-44 rounded bg-white p-2" />
            <p className="text-xs text-muted">
              Can't scan? Enter this key: <span className="font-mono">{setup.secret.match(/.{1,4}/g)!.join(' ')}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <input className="input w-36" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
              <button
                className="btn-primary"
                disabled={busy || !code || (me?.hasPassword && !password)}
                onClick={() =>
                  run(async () => {
                    const r = await api<{ recoveryCodes: string[] | null }>('/api/auth/2fa/totp/enable', { body: { token: setup.token, code, password: password || undefined } });
                    setSetup(null);
                    setCode('');
                    if (r.recoveryCodes) setCodes(r.recoveryCodes);
                  }, 'Authenticator app is on.')
                }
              >
                Turn on
              </button>
              <button className="btn-secondary" onClick={() => setSetup(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="btn-secondary" disabled={busy} onClick={() => run(async () => setSetup(await api('/api/auth/2fa/totp/setup', { body: {} })))}>
            Set up an authenticator app
          </button>
        )}
      </div>

      <div className="space-y-2">
        <div className="label">Passkeys</div>
        {d.passkeys.length > 0 && (
          <ul className="space-y-1 text-sm">
            {d.passkeys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-2">
                <span>
                  {k.name} <span className="text-xs text-muted">· added {formatDate(k.createdAt)}{k.lastUsedAt ? `, last used ${formatDate(k.lastUsedAt)}` : ''}</span>
                </span>
                <button className="btn-secondary px-2 py-1 text-xs" disabled={busy || !ready} onClick={() => run(() => api(`/api/auth/passkeys/${encodeURIComponent(k.id)}`, { method: 'DELETE', body: confirm }), 'Passkey removed.')}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {passkeysSupported() ? (
          <div className="flex flex-wrap gap-2">
            <input className="input max-w-[14rem]" placeholder="Name, like “My phone”" value={name} onChange={(e) => setName(e.target.value)} />
            <button
              className="btn-secondary"
              disabled={busy || !ready}
              onClick={() =>
                run(async () => {
                  const fresh = await addPasskey(name.trim() || 'Passkey', confirm);
                  setName('');
                  if (fresh) setCodes(fresh);
                }, 'Passkey added.')
              }
            >
              Add a passkey
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted">This browser can't use passkeys.</p>
        )}
        <p className="hint">Passkeys work on the address set as the public URL in Settings → General, or the address you're using now when none is set.</p>
      </div>

      {any && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{d.recoveryLeft} recovery codes left.</span>
          <button className="btn-secondary px-2 py-1 text-xs" disabled={busy || !ready} onClick={() => run(async () => setCodes((await api<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery', { body: confirm })).recoveryCodes))}>
            Make new ones
          </button>
        </div>
      )}
    </section>
  );
}
