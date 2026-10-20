import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field, SecretInput } from '../../components/ui';
import { api } from '../../lib/api';
import { useSettingsSection } from '../../lib/settings';
import { TestButton } from './TestButton';

type Source = 'radarr' | 'sonarr' | 'overseerr';

interface Run {
  running: boolean;
  total: number;
  done: number;
  added: number;
  skipped: number;
  errors: string[];
  finishedAt: number | null;
}

const ABOUT: Record<Source, { name: string; port: string; text: string; button: string }> = {
  radarr: {
    name: 'Radarr',
    port: '7878',
    text: 'Every movie in Radarr is added to Cinemask with the quality profile of the same name (or your default). Files are found where they already are in your movie folders, so nothing is downloaded or moved.',
    button: 'Import movies',
  },
  sonarr: {
    name: 'Sonarr',
    port: '8989',
    text: 'Every show in Sonarr is added with the seasons it monitors and the quality profile of the same name. Episodes already on disk are found in your TV folders; nothing is downloaded or moved.',
    button: 'Import shows',
  },
  overseerr: {
    name: 'Overseerr',
    port: '5055',
    text: 'Requests from Overseerr (or Jellyseerr) come over with their status and who asked, matched to Cinemask users by email or username. Nothing is searched for again.',
    button: 'Import requests',
  },
};

function ImportSection({ source }: { source: Source }) {
  const s = useSettingsSection(source);
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const about = ABOUT[source];
  const run = useQuery({
    queryKey: ['import', source],
    queryFn: () => api<Run | null>(`/api/import/${source}`),
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
  });
  if (s.loading) return null;
  const start = async () => {
    setError('');
    try {
      await s.save();
      await api(`/api/import/${source}`, { body: {} });
      await qc.invalidateQueries({ queryKey: ['import', source] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const r = run.data;
  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">{about.name}</h2>
      <p className="text-sm text-muted">{about.text}</p>
      <Field label="Address">
        <input className="input" value={s.values.url} onChange={(e) => s.set('url', e.target.value)} placeholder={`http://${source}:${about.port}`} />
      </Field>
      <Field label="API key" hint={`In ${about.name} under Settings → General.`}>
        <SecretInput isSet={s.secretsSet['apiKey']!} value={s.secrets['apiKey']} onChange={(v) => s.setSecret('apiKey', v)} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <TestButton service={source} endpoint={`/api/import/${source}/test`} beforeTest={s.save} />
        <button className="btn-primary" disabled={r?.running} onClick={() => void start()}>
          {r?.running ? 'Importing…' : about.button}
        </button>
      </div>
      {error && <Alert>{error}</Alert>}
      {r && (
        <div className="space-y-2 text-sm">
          {r.running && (
            <div className="h-1.5 overflow-hidden rounded bg-surface-2" role="progressbar" aria-valuenow={r.done} aria-valuemax={r.total}>
              <div className="h-full bg-accent" style={{ width: `${r.total ? Math.round((r.done / r.total) * 100) : 0}%` }} />
            </div>
          )}
          <p className="text-muted">
            {r.running ? `Working through ${r.done} of ${r.total}.` : `Finished: ${r.added} added, ${r.skipped} skipped${r.errors.length ? `, ${r.errors.length} with problems` : ''}.`}
          </p>
          {r.errors.length > 0 && (
            <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-xs text-danger">
              {r.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function ImportSettings() {
  return (
    <div className="max-w-2xl space-y-6">
      <p className="text-sm text-muted">Moving over from Radarr, Sonarr or Overseerr? Import what they manage. You can run an import again any time; titles and requests already here are kept as they are.</p>
      <ImportSection source="radarr" />
      <ImportSection source="sonarr" />
      <ImportSection source="overseerr" />
    </div>
  );
}
