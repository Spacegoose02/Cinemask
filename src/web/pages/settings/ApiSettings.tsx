import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Field, SecretInput, Toggle } from '../../components/ui';
import { api, formatDate } from '../../lib/api';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';
import { TestButton } from './TestButton';

const EVENTS: { id: string; label: string }[] = [
  { id: 'request.created', label: 'Someone makes a request' },
  { id: 'request.available', label: 'A request is ready to watch or read' },
  { id: 'download.imported', label: 'A download is imported' },
  { id: 'download.failed', label: 'A download fails' },
  { id: 'health.problem', label: 'A health check starts failing' },
];

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
  const n = useSettingsSection('notifications');
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ['all-api-keys'], queryFn: () => api<KeyRow[]>('/api/api-keys') });
  if (auth.loading || n.loading) return null;
  const events: string[] = n.values.events;
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

      <section className="card space-y-4">
        <h2 className="font-semibold">Webhook (Home Assistant and others)</h2>
        <p className="text-sm text-muted">
          Cinemask POSTs a small JSON message to this address when the events below happen. In Home Assistant, create an automation with a Webhook trigger and paste its URL here. The guide in docs/home-assistant.md has examples.
        </p>
        <Toggle label="Send webhook events" checked={n.values.enabled} onChange={(v) => n.set('enabled', v)} />
        <Field label="Webhook URL" hint="Kept secret, since the id in the URL is what lets anyone call it.">
          <SecretInput isSet={n.secretsSet['webhookUrl']!} value={n.secrets['webhookUrl']} onChange={(v) => n.setSecret('webhookUrl', v)} placeholder="http://homeassistant.local:8123/api/webhook/cinemask" />
        </Field>
        <fieldset className="space-y-2">
          <legend className="label">Events</legend>
          {EVENTS.map((e) => (
            <label key={e.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={events.includes(e.id)} onChange={(ev) => n.set('events', ev.target.checked ? [...events, e.id] : events.filter((x) => x !== e.id))} />
              {e.label}
            </label>
          ))}
        </fieldset>
        <TestButton service="webhook" beforeTest={n.save} endpoint="/api/notifications/test" label="Save and send a test" />
        <SaveBar onSave={n.save} saving={n.saving} message={n.message} />
      </section>
    </div>
  );
}

