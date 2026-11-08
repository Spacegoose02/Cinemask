import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field, SecretInput, Toggle } from '../../components/ui';
import { api, formatDate } from '../../lib/api';
import { serverName } from '../../lib/media';
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

function EmbySettings() {
  const s = useSettingsSection('emby');
  if (s.loading) return null;
  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Emby</h2>
      <Toggle label="Use Emby" checked={s.values.enabled} onChange={(v) => s.set('enabled', v)} />
      <Field label="Server URL" hint="e.g. http://192.168.1.10:8096">
        <input className="input" value={s.values.url} onChange={(e) => s.set('url', e.target.value)} />
      </Field>
      <Field label="API key" hint="Emby Settings → Advanced → API Keys. Emby titles count as available, show in Now playing and are rescanned after imports; collections and posters stay Plex and Jellyfin only.">
        <SecretInput isSet={s.secretsSet['apiKey']!} value={s.secrets['apiKey']} onChange={(v) => s.setSecret('apiKey', v)} />
      </Field>
      <TestButton service="emby" beforeTest={s.save} />
    </section>
  );
}

function BingeBanditSettings() {
  const s = useSettingsSection('bingebandit');
  if (s.loading) return null;
  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">BingeBandit</h2>
      <Toggle label="Use BingeBandit" checked={s.values.enabled} onChange={(v) => s.set('enabled', v)} />
      <Field label="Server URL" hint="e.g. http://192.168.1.10:8080">
        <input className="input" value={s.values.url} onChange={(e) => s.set('url', e.target.value)} />
      </Field>
      <Field label="API key" hint="BingeBandit Settings → API keys, signed in as an admin so Cinemask can ask for scans and set posters.">
        <SecretInput isSet={s.secretsSet['apiKey']!} value={s.secrets['apiKey']} onChange={(v) => s.setSecret('apiKey', v)} />
      </Field>
      <TestButton service="bingebandit" beforeTest={s.save} />
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
        <select className="input w-auto max-w-full" value={s.values.autoMonitor} onChange={(e) => s.set('autoMonitor', e.target.value)}>
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
          {serverName(server)}: {r.ok ? `${r.movies} movies, ${r.shows} shows, ${r.episodes} episodes` : r.error}
        </Alert>
      ))}
    </section>
  );
}

interface OverlayStatus {
  enabled: boolean;
  applied: number;
  running: boolean;
  lastRun: { at: number; updated: number; unchanged: number; failed: number; errors: string[] } | null;
  sample: { kind: 'movie' | 'show'; tmdbId: number; title: string } | null;
}

/** Badges on posters (4K, score, New…), drawn here and uploaded to the servers. */
function OverlaySettings() {
  const qc = useQueryClient();
  const s = useSettingsSection('overlays');
  const status = useQuery({ queryKey: ['overlays'], queryFn: () => api<OverlayStatus>('/api/overlays'), refetchInterval: (q) => (q.state.data?.running ? 3000 : false) });
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  if (s.loading) return null;
  const act = async (path: string, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    setError(null);
    try {
      await api(path, { method: 'POST' });
    } catch (err) {
      setError((err as Error).message);
    }
    await qc.invalidateQueries({ queryKey: ['overlays'] });
  };
  const d = status.data;
  const sample = d?.sample;
  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">Poster overlays</h2>
      <p className="text-sm text-muted">
        Draws badges on posters and uploads them to Plex, Jellyfin, Emby and BingeBandit, so the quality and score show while browsing there. Badges go on the poster chosen in Cinemask (or TMDB's), never on top of an old badge. Updated every night, after the library sync.
      </p>
      <Toggle label="Put badges on posters" checked={s.values.enabled} onChange={(v) => s.set('enabled', v)} />
      <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
        <div className="space-y-3">
          <Toggle label="Resolution (4K, 1080p…)" checked={s.values.resolution} onChange={(v) => s.set('resolution', v)} />
          <Toggle label="TMDB score" checked={s.values.rating} onChange={(v) => s.set('rating', v)} />
          <Toggle label="Show status (Returning, Ended, Canceled)" checked={s.values.showStatus} onChange={(v) => s.set('showStatus', v)} />
          <Toggle label="Age rating" checked={s.values.certification} onChange={(v) => s.set('certification', v)} />
          <Field label='"New" banner for (days)' hint="Titles added, or shows with episodes added, this recently. 0 turns it off.">
            <input className="input w-24" type="number" min={0} max={90} value={s.values.newDays} onChange={(e) => s.set('newDays', Number(e.target.value))} />
          </Field>
        </div>
        {sample && (
          <figure className="w-40 space-y-1">
            <img key={version} className="w-40 rounded-md border border-border" alt={`Preview: ${sample.title}`} src={`/api/overlays/preview/${sample.kind}/${sample.tmdbId}?v=${version}`} />
            <figcaption className="text-xs text-muted">Preview: {sample.title} (after saving)</figcaption>
          </figure>
        )}
      </div>
      <SaveBar
        onSave={() => void s.save().then(() => setVersion((v) => v + 1))}
        saving={s.saving}
        message={s.message}
      />
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <button className="btn-primary" disabled={!d?.enabled || d.running} onClick={() => act('/api/overlays/run')}>
          {d?.running ? 'Updating…' : 'Update posters now'}
        </button>
        <button className="btn-secondary" disabled={!d?.applied || d.running} onClick={() => act('/api/overlays/remove', 'Put the clean posters back on every title that has badges?')}>
          Remove all badges
        </button>
        <span className="text-sm text-muted">
          {d ? `${d.applied} title${d.applied === 1 ? '' : 's'} with badges` : ''}
          {d?.lastRun ? ` · last run ${formatDate(d.lastRun.at)}: ${d.lastRun.updated} updated${d.lastRun.failed ? `, ${d.lastRun.failed} failed` : ''}` : ''}
        </span>
      </div>
      {!!d?.lastRun?.errors.length && (
        <Alert kind="info">
          {d.lastRun.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Alert>
      )}
    </section>
  );
}

export function MediaServerSettings() {
  return (
    <div className="max-w-2xl space-y-6">
      <BingeBanditSettings />
      <PlexSettings />
      <JellyfinSettings />
      <EmbySettings />
      <SyncSettings />
      <OverlaySettings />
    </div>
  );
}
