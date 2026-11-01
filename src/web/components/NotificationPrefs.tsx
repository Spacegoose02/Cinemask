import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, formatDate } from '../lib/api';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../lib/push';
import { Alert, Toggle } from './ui';

interface Prefs {
  push: boolean;
  email: boolean;
  off: string[];
}

interface Me {
  prefs: Prefs;
  events: string[];
  publicKey: string;
  devices: { id: number; device: string | null; createdAt: number; lastUsedAt: number | null }[];
  emailAvailable: boolean;
  email: string | null;
}

/** What each event is, in plain words. */
export const EVENT_LABELS: Record<string, string> = {
  'request.created': 'Someone makes a request',
  'request.approved': 'My request is approved',
  'request.declined': 'My request is declined',
  'request.available': 'Something I asked for is ready to watch',
  'download.imported': 'A download is added to the library',
  'download.failed': 'A download fails',
  'download.warning': 'A download needs a look (too big, waiting to confirm)',
  'health.problem': 'Cinemask needs attention (Health)',
  'movie_night.created': 'A movie night is planned',
  'movie_night.reminder': 'A movie night is about to start',
  'issue.created': 'Someone reports a problem with a title',
  'issue.resolved': 'A problem I reported is fixed',
};

/** Account → Notifications: this device, email, and which events. */
export function NotificationPrefs() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['notify-me'], queryFn: () => api<Me>('/api/notifications/me') });
  const [here, setHere] = useState<boolean | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void currentSubscription().then((s) => setHere(Boolean(s && q.data?.devices.length)));
  }, [q.data?.devices.length]);

  if (!q.data) return null;
  const d = q.data;
  const save = async (patch: Partial<Prefs>, address?: string) => {
    setMsg(null);
    try {
      await api('/api/notifications/me', { method: 'PUT', body: { ...d.prefs, ...patch, ...(address !== undefined ? { address } : {}) } });
      await qc.invalidateQueries({ queryKey: ['notify-me'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = (await fn()) as { ok?: boolean; message?: string } | undefined;
      if (res?.message) setMsg({ kind: res.ok === false ? 'error' : 'success', text: res.message });
      else if (ok) setMsg({ kind: 'success', text: ok });
      await qc.invalidateQueries({ queryKey: ['notify-me'] });
      setHere(Boolean(await currentSubscription()));
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Notifications</h2>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <div className="flex flex-wrap items-center gap-2">
        {!pushSupported() ? (
          <p className="text-sm text-muted">This browser can't show notifications. On iPhone, add Cinemask to the Home Screen and open it from there.</p>
        ) : here ? (
          <button className="btn-secondary" disabled={busy} onClick={() => run(disablePush, 'Notifications are off on this device.')}>
            Turn off on this device
          </button>
        ) : (
          <button className="btn-primary" disabled={busy} onClick={() => run(() => enablePush(d.publicKey), 'Notifications are on for this device.')}>
            Turn on for this device
          </button>
        )}
        <button className="btn-secondary" disabled={busy} onClick={() => run(() => api('/api/notifications/me/test', { body: {} }))}>
          Send me a test
        </button>
      </div>
      {d.devices.length > 0 && (
        <ul className="space-y-1 text-sm">
          {d.devices.map((dev) => (
            <li key={dev.id} className="flex items-center justify-between gap-2">
              <span>
                {dev.device ?? 'A device'} <span className="text-xs text-muted">· since {formatDate(dev.createdAt)}</span>
              </span>
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => run(() => api(`/api/notifications/push/${dev.id}`, { method: 'DELETE' }))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <Toggle label="Notify my devices" checked={d.prefs.push} onChange={(v) => save({ push: v })} />
      {d.emailAvailable && (
        <div className="space-y-2">
          <Toggle label="Email me too" checked={d.prefs.email} onChange={(v) => save({ email: v })} />
          <div className="flex flex-wrap gap-2">
            <input className="input max-w-xs" type="email" placeholder="you@example.com" aria-label="Email address" value={email ?? d.email ?? ''} onChange={(e) => setEmail(e.target.value)} />
            {email !== null && email !== (d.email ?? '') && (
              <button className="btn-secondary" onClick={() => save({}, email.trim()).then(() => setEmail(null))}>
                Save address
              </button>
            )}
          </div>
        </div>
      )}
      <div>
        <div className="label">Tell me when</div>
        <div className="space-y-1">
          {d.events.map((e) => (
            <label key={e} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!d.prefs.off.includes(e)} onChange={(ev) => save({ off: ev.target.checked ? d.prefs.off.filter((x) => x !== e) : [...d.prefs.off, e] })} />
              {EVENT_LABELS[e] ?? e}
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
