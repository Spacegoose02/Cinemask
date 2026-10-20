import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field, SecretInput, Toggle } from '../../components/ui';
import { api, formatDate } from '../../lib/api';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';
import { TestButton } from './TestButton';

interface PlexServer {
  name: string;
  machineId: string;
  owned: boolean;
  connections: { uri: string; local: boolean; relay: boolean }[];
}

interface SyncStatus {
  running: boolean;
  lastRunAt: number | null;
  results: Record<string, { ok: boolean; movies?: number; shows?: number; episodes?: number; error?: string }>;
  autoMonitored?: number;
}

function PlexSettings() {
  const s = useSettingsSection('plex');
  const [servers, setServers] = useState<PlexServer[] | null>(null);
  const [error, setError] = useState('');
  if (s.loading) return null;
  const find = async () => {
    setError('');
    try {
      setServers(await api<PlexServer[]>('/api/integrations/plex/servers', { body: { token: s.secrets['token'] || undefined } }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Plex</h2>
      <Toggle label="Use Plex" checked={s.values.enabled} onChange={(v) => s.set('enabled', v)} />
      <Field label="Plex token" hint="Your X-Plex-Token. Only admins can see or change it.">
        <SecretInput isSet={s.secretsSet['token']!} value={s.secrets['token']} onChange={(v) => s.setSecret('token', v)} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary" onClick={find}>
          Find my Plex servers
        </button>
        {error && <Alert>{error}</Alert>}
      </div>
      {servers && (
        <ul className="space-y-2 text-sm">
          {servers.map((srv) => (
            <li key={srv.machineId} className="rounded-md border border-border p-3">
              <div className="font-medium">{srv.name}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {srv.connections.map((c) => (
                  <button
                    key={c.uri}
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => {
                      s.set('url', c.uri);
                      s.set('name', srv.name);
                    }}
                  >
                    {c.local ? 'Local' : c.relay ? 'Relay' : 'Remote'}: {c.uri}
                  </button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Field label="Server URL" hint="e.g. http://192.168.1.10:32400">
        <input className="input" value={s.values.url} onChange={(e) => s.set('url', e.target.value)} />
      </Field>
      {s.values.machineId && <p className="hint">Server ID: {s.values.machineId}</p>}
      <TestButton service="plex" beforeTest={s.save} />
    </section>
  );
}

function JellyfinSettings() {
  const s = useSettingsSection('jellyfin');
  if (s.loading) return null;
  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Jellyfin</h2>
      <Toggle label="Use Jellyfin" checked={s.values.enabled} onChange={(v) => s.set('enabled', v)} />
      <Field label="Server URL" hint="e.g. http://192.168.1.10:8096">
        <input className="input" value={s.values.url} onChange={(e) => s.set('url', e.target.value)} />
      </Field>
      <Field label="API key" hint="Jellyfin Dashboard → API Keys.">
        <SecretInput isSet={s.secretsSet['apiKey']!} value={s.secrets['apiKey']} onChange={(v) => s.setSecret('apiKey', v)} />
      </Field>
      <TestButton service="jellyfin" beforeTest={s.save} />
    </section>
  );
}

function SyncSettings() {
  const qc = useQueryClient();
  const s = useSettingsSection('library');
  const status = useQuery({ queryKey: ['sync-status'], queryFn: () => api<SyncStatus>('/api/library/sync'), refetchInterval: (q) => (q.state.data?.running ? 2000 : false) });
  if (s.loading) return null;
  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Library sync</h2>
      <p className="text-sm text-muted">Reads what's on your servers so the app knows what you already have and in what quality.</p>
      <Toggle label="Sync automatically" checked={s.values.syncEnabled} onChange={(v) => s.set('syncEnabled', v)} />
      <Field label="Every (hours)">
        <select className="input w-32" value={s.values.syncIntervalHours} onChange={(e) => s.set('syncIntervalHours', Number(e.target.value))}>
          {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
            <option key={h}>{h}</option>
          ))}
        </select>
      </Field>
      <Field label="Monitor what the sync finds" hint="Who can change it per title: managers, with Monitor / Unmonitor on its page. Titles removed by hand stay removed.">
        <select className="input w-auto" value={s.values.autoMonitor} onChange={(e) => s.set('autoMonitor', e.target.value)}>
          <option value="new">New episodes only (nothing already out is searched)</option>
          <option value="all">Everything (fill missing episodes and upgrade by quality profile)</option>
          <option value="off">Don't monitor</option>
        </select>
      </Field>
      <SaveBar onSave={s.save} saving={s.saving} message={s.message} />
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <button
          className="btn-primary"
          disabled={status.data?.running}
          onClick={async () => {
            await api('/api/library/sync', { method: 'POST' });
            await qc.invalidateQueries({ queryKey: ['sync-status'] });
          }}
        >
          {status.data?.running ? 'Syncing…' : 'Sync now'}
        </button>
        <span className="text-sm text-muted">
          Last sync: {formatDate(status.data?.lastRunAt)}
          {status.data?.autoMonitored ? ` · started monitoring ${status.data.autoMonitored} title${status.data.autoMonitored === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      {Object.entries(status.data?.results ?? {}).map(([server, r]) => (
        <Alert key={server} kind={r.ok ? 'success' : 'error'}>
          {server === 'plex' ? 'Plex' : 'Jellyfin'}: {r.ok ? `${r.movies} movies, ${r.shows} shows, ${r.episodes} episodes` : r.error}
        </Alert>
      ))}
    </section>
  );
}

export function MediaServerSettings() {
  return (
    <div className="max-w-2xl space-y-6">
      <PlexSettings />
      <JellyfinSettings />
      <SyncSettings />
    </div>
  );
}
