import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Field } from '../../components/ui';
import { api, formatDate } from '../../lib/api';

interface GuideProfile {
  id: string;
  name: string;
  description: string;
  formats: number;
}

interface LinkedProfile {
  id: number;
  name: string;
  trash: { app: string; id: string; syncedAt: number | null } | null;
}

/** Settings → Quality: quality profiles and custom formats from the TRaSH Guides, kept in sync weekly. */
export function TrashGuides({ profiles }: { profiles: LinkedProfile[] }) {
  const qc = useQueryClient();
  const [app, setApp] = useState<'radarr' | 'sonarr'>('radarr');
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState('');
  const [target, setTarget] = useState<number | 0>(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const guide = useQuery({ queryKey: ['trash', app], queryFn: () => api<GuideProfile[]>(`/api/trash/${app}/profiles`), enabled: open, staleTime: 60 * 60 * 1000, retry: false });
  const linked = profiles.filter((p) => p.trash);
  const chosen = guide.data?.find((g) => g.id === pick);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ kind: 'success', text: await fn() });
      await qc.invalidateQueries({ queryKey: ['profiles'] });
      await qc.invalidateQueries({ queryKey: ['custom-formats'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-4">
      <div>
        <h2 className="font-semibold">TRaSH Guides</h2>
        <p className="text-sm text-muted">
          Use the community's recommended profiles: the qualities, custom formats and scores from the TRaSH Guides. Profiles made this way follow the guides and are updated every Sunday, so changes you make to them by hand are replaced. Formats Cinemask can't check (such as "original language" or indexer flags) are left out.
        </p>
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {linked.length > 0 && (
        <ul className="space-y-1 text-sm">
          {linked.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {p.name} <span className="text-xs text-muted">· follows the {p.trash!.app === 'sonarr' ? 'TV' : 'movie'} guide{p.trash!.syncedAt ? `, synced ${formatDate(p.trash!.syncedAt)}` : ''}</span>
              </span>
              <button className="btn-secondary px-2 py-1 text-xs" disabled={busy} onClick={() => run(async () => (await api('/api/trash/unlink', { body: { profileId: p.id } }), `${p.name} no longer follows the guides.`))}>
                Stop following
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {!open && (
          <button className="btn-secondary" onClick={() => setOpen(true)}>
            Browse the guides' profiles
          </button>
        )}
        {linked.length > 0 && (
          <button className="btn-secondary" disabled={busy} onClick={() => run(async () => `Synced ${(await api<{ synced: number }>('/api/trash/sync', { body: {} })).synced} profile(s).`)}>
            Sync now
          </button>
        )}
      </div>
      {open && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-4">
            <Field label="For">
              <select className="input" value={app} onChange={(e) => (setApp(e.target.value as 'radarr' | 'sonarr'), setPick(''))}>
                <option value="radarr">Movies (Radarr guide)</option>
                <option value="sonarr">Shows (Sonarr guide)</option>
              </select>
            </Field>
            <Field label="Guide profile">
              <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} disabled={!guide.data}>
                <option value="">{guide.isLoading ? 'Loading the guides…' : 'Pick one'}</option>
                {guide.data?.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Apply to">
              <select className="input" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
                <option value={0}>A new profile</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {guide.error && <Alert>{(guide.error as Error).message}</Alert>}
          {chosen && (
            <p className="whitespace-pre-line text-sm text-muted">
              {chosen.description}
              {'\n'}
              {chosen.formats} custom formats.
            </p>
          )}
          <button
            className="btn-primary"
            disabled={!pick || busy}
            onClick={() =>
              run(async () => {
                const r = await api<{ formats: number; skipped: string[]; profile: { name: string } }>('/api/trash/apply', { body: { app, trashId: pick, profileId: target || null } });
                return `${r.profile.name} now follows the guide, with ${r.formats} custom formats.${r.skipped.length ? ` Left out: ${r.skipped.join(', ')}.` : ''}`;
              })
            }
          >
            {target ? 'Replace its settings with the guide' : 'Make the profile'}
          </button>
        </div>
      )}
    </section>
  );
}
