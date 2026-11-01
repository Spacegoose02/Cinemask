import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Toggle } from '../../components/ui';
import { api, formatDate } from '../../lib/api';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';

interface KeyRow {
  id: number;
  name: string;
  prefix: string;
  access: string;
  username: string;
  role: string;
  lastUsedAt: number | null;
  expiresAt: number | null;
}

export function ApiSettings() {
  const auth = useSettingsSection('auth');
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['all-api-keys'], queryFn: () => api<KeyRow[]>('/api/api-keys') });
  if (auth.loading) return null;
  const revoke = async (k: KeyRow) => {
    if (!confirm(`Revoke ${k.username}'s key "${k.name}"?`)) return;
    await api(`/api/api-keys/${k.id}`, { method: 'DELETE' });
    await qc.invalidateQueries({ queryKey: ['all-api-keys'] });
  };
  return (
    <div className="max-w-2xl space-y-6">
      <section className="card space-y-4">
        <h2 className="font-semibold">API keys</h2>
        <p className="text-sm text-muted">
          People create their own keys under Account. A key has its owner's role and can't change settings, users or other keys. See the{' '}
          <Link to="/developer" className="text-accent">
            API reference
          </Link>
          .
        </p>
        <Toggle label="Allow API keys" checked={auth.values.apiKeysEnabled} onChange={(v) => auth.set('apiKeysEnabled', v)} hint="Turning this off stops every key at once without deleting them." />
        <SaveBar onSave={auth.save} saving={auth.saving} message={auth.message} />
        {keys.data?.length ? (
          <ul className="divide-y divide-border text-sm">
            {keys.data.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {k.name} <span className="text-xs text-muted">· {k.username} ({k.role}) · {k.access === 'read' ? 'read-only' : 'read and write'}</span>
                  </div>
                  <div className="text-xs text-muted">
                    <code>{k.prefix}…</code> · {k.lastUsedAt ? `last used ${formatDate(k.lastUsedAt)}` : 'never used'}
                    {k.expiresAt ? ` · expires ${formatDate(k.expiresAt)}` : ''}
                  </div>
                </div>
                <button className="btn-danger px-2 py-1 text-xs" onClick={() => revoke(k)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nobody has created a key yet.</p>
        )}
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Apps made for Radarr and Sonarr</h2>
        <p className="text-sm text-muted">
          Overseerr, Jellyseerr, LunaSea, nzb360 and Home Assistant can talk to Cinemask as if it were Radarr and Sonarr. Add a Radarr or Sonarr server in the app with Cinemask's address and port, the URL base <code>/api/compat/radarr</code> or{' '}
          <code>/api/compat/sonarr</code>, and an API key of a manager or admin. Titles added from those apps skip approval and show in the activity log.
        </p>
      </section>

      <section className="card space-y-2">
        <h2 className="font-semibold">Webhooks</h2>
        <p className="text-sm text-muted">
          The webhook for Home Assistant and others is now with Discord, Telegram and the rest in <Link to="/settings/notifications" className="text-accent hover:underline">Settings → Notifications</Link>.
        </p>
      </section>
    </div>
  );
}

