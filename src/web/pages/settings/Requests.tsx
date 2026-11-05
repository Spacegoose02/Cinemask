import { useQuery } from '@tanstack/react-query';
import { Field, Toggle } from '../../components/ui';
import { useRootFolders } from '../../components/MediaActions';
import { api } from '../../lib/api';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';

interface Provider {
  id: number;
  name: string;
  logoPath: string | null;
}

/** Settings → Requests: limits, 4K requests and the "already streaming" rule. */
export function RequestSettings() {
  const r = useSettingsSection('requests');
  const iss = useSettingsSection('issues');
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<{ id: number; name: string }[]>('/api/profiles') });
  const roots = useRootFolders(true).data?.roots ?? [];
  const providers = useQuery({ queryKey: ['discover-options', 'movie'], queryFn: () => api<{ providers: Provider[]; region: string }>('/api/discover/options?kind=movie') });
  if (r.loading || iss.loading) return null;
  const chosen = (r.values.streamingProviders ?? []) as number[];
  const toggleProvider = (id: number) => r.set('streamingProviders', chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);

  return (
    <div className="space-y-6">
      <section className="card space-y-4">
        <h2 className="font-semibold">Request limits</h2>
        <p className="hint">How many movies and show seasons each user can request. Managers and admins have no limit. Declined requests don't count. Users → each person can have their own limit.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Movies" hint="0 means no limit">
            <input className="input w-28" type="number" min={0} value={r.values.movieLimit} onChange={(e) => r.set('movieLimit', Number(e.target.value))} />
          </Field>
          <Field label="Seasons" hint="A whole-show request counts every season">
            <input className="input w-28" type="number" min={0} value={r.values.seasonLimit} onChange={(e) => r.set('seasonLimit', Number(e.target.value))} />
          </Field>
          <Field label="Every (days)">
            <input className="input w-28" type="number" min={1} max={90} value={r.values.limitDays} onChange={(e) => r.set('limitDays', Number(e.target.value))} />
          </Field>
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">4K requests</h2>
        <p className="hint">People you allow (Users → Can request 4K) can tick 4K when requesting. An approved 4K request uses this profile and folder; a title already on the server switches to the 4K profile so it gets upgraded.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {(['movie', 'show'] as const).map((kind) => {
            const pk = kind === 'movie' ? 'fourKMovieProfile' : 'fourKShowProfile';
            const rk = kind === 'movie' ? 'fourKMovieRoot' : 'fourKShowRoot';
            const kindRoots = roots.filter((x) => x.kind === kind);
            return (
              <div key={kind} className="space-y-3">
                <Field label={kind === 'movie' ? 'Movie profile' : 'Show profile'}>
                  <select className="input" value={r.values[pk] ?? ''} onChange={(e) => r.set(pk, e.target.value ? Number(e.target.value) : null)}>
                    <option value="">Same as other requests</option>
                    {profiles.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                {kindRoots.length > 1 && (
                  <Field label={kind === 'movie' ? 'Movie folder' : 'Show folder'}>
                    <select className="input" value={r.values[rk] ?? ''} onChange={(e) => r.set(rk, e.target.value)}>
                      <option value="">Main folder</option>
                      {kindRoots
                        .filter((x) => x.id !== 'default')
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Already streaming</h2>
        <Field label="When a title is on a streaming service you have" hint={`Checked in ${providers.data?.region ?? 'your region'} (Settings → Metadata). Managers can always download it.`}>
          <select className="input sm:w-auto" value={r.values.streaming} onChange={(e) => r.set('streaming', e.target.value)}>
            <option value="warn">Say so, and ask before requesting</option>
            <option value="block">Don't let users request it</option>
            <option value="off">Say nothing</option>
          </select>
        </Field>
        <div>
          <div className="label">Your services</div>
          <p className="hint mb-2">Pick the ones your household pays for. None picked means any subscription service counts.</p>
          <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto">
            {providers.data?.providers.slice(0, 60).map((p) => (
              <label key={p.id} className={`flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${chosen.includes(p.id) ? 'border-accent text-accent' : 'border-border text-muted'}`}>
                <input type="checkbox" className="sr-only" checked={chosen.includes(p.id)} onChange={() => toggleProvider(p.id)} />
                {p.logoPath && <img src={`https://image.tmdb.org/t/p/w45${p.logoPath}`} alt="" className="h-4 w-4 rounded" />}
                {p.name}
              </label>
            ))}
            {providers.data && !providers.data.providers.length && <span className="text-sm text-muted">Set a TMDB key in Settings → Metadata to list services.</span>}
          </div>
        </div>
      </section>
      <SaveBar onSave={r.save} saving={r.saving} message={r.message} />

      <section className="card space-y-4">
        <h2 className="font-semibold">Problem reports</h2>
        <Toggle
          label="Fix reports automatically"
          checked={iss.values.autoFix}
          onChange={(v) => iss.set('autoFix', v)}
          hint="Wrong language, poor picture, won't play or wrong episode: blocklist that copy and download a different one straight away. Missing subtitles: fetch them. Otherwise reports wait for a manager on Problems."
        />
        <SaveBar onSave={iss.save} saving={iss.saving} message={iss.message} />
      </section>
    </div>
  );
}
