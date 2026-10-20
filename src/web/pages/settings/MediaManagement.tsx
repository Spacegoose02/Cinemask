import { useQuery } from '@tanstack/react-query';
import { Field, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { useSettingsSection } from '../../lib/settings';
import { SaveBar } from './SaveBar';

/** Client-side preview of the naming templates, mirroring the server's token rules. */
function preview(template: string, v: Record<string, string>) {
  return template
    .replace(/\{([A-Za-z ]+)(?::(0+))?\}/g, (_m, token: string, pad?: string) => {
      const val = v[token.trim().toLowerCase()] ?? '';
      return pad && /^\d+$/.test(val) ? val.padStart(pad.length, '0') : val;
    })
    .replace(/:/g, ' -')
    .replace(/[<>"/\\|?*]/g, '');
}

const SAMPLE = { 'movie title': 'Paddington', 'series title': 'Expedition Unknown', year: '2014', season: '1', episode: '1', 'episode title': 'Tigers fighting', quality: 'Bluray-1080p', resolution: '1080p', 'air date': '2015-01-08', 'tmdb id': '116149' };

export function MediaManagementSettings() {
  const m = useSettingsSection('media');
  const n = useSettingsSection('naming');
  const d = useSettingsSection('downloading');
  const x = useSettingsSection('extras');
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<{ id: number; name: string }[]>('/api/profiles') });
  if (m.loading || n.loading || d.loading || x.loading) return null;
  const maps = m.values.remotePathMappings as { remote: string; local: string }[];

  return (
    <div className="max-w-3xl space-y-6">
      <section className="card space-y-4">
        <h2 className="font-semibold">Folders</h2>
        <p className="text-sm text-muted">Paths inside this container. On Unraid, map /downloads and /media to shares on the same pool so hardlinks work.</p>
        <Field label="Downloads folder">
          <input className="input" value={m.values.downloadsPath} onChange={(e) => m.set('downloadsPath', e.target.value)} />
        </Field>
        <Field label="Movies folder">
          <input className="input" value={m.values.moviesPath} onChange={(e) => m.set('moviesPath', e.target.value)} />
        </Field>
        <Field label="TV folder">
          <input className="input" value={m.values.tvPath} onChange={(e) => m.set('tvPath', e.target.value)} />
        </Field>
        <Field label="Audiobooks folder">
          <input className="input" value={m.values.audiobooksPath} onChange={(e) => m.set('audiobooksPath', e.target.value)} />
        </Field>
        <Field label="Books folder">
          <input className="input" value={m.values.booksPath} onChange={(e) => m.set('booksPath', e.target.value)} />
        </Field>
        <Field label="When a download finishes" hint="Hardlink keeps torrents seeding without using extra space. Falls back to copy across disks.">
          <select className="input" value={m.values.importMode} onChange={(e) => m.set('importMode', e.target.value)}>
            <option value="hardlink">Hardlink into the library</option>
            <option value="copy">Copy into the library</option>
            <option value="move">Move into the library</option>
          </select>
        </Field>
        <Toggle label="Remove finished downloads from the client" checked={m.values.removeCompletedDownloads} onChange={(v) => m.set('removeCompletedDownloads', v)} />
        <div>
          <div className="label">Remote path mappings</div>
          <p className="hint mb-2">Only needed when your download client sees folders at different paths, e.g. its /data/torrents is our /downloads.</p>
          {maps.map((mp, i) => (
            <div key={i} className="mb-2 flex gap-2">
              <input className="input" placeholder="Client path" value={mp.remote} onChange={(e) => m.set('remotePathMappings', maps.map((x, j) => (j === i ? { ...x, remote: e.target.value } : x)))} />
              <input className="input" placeholder="Path here" value={mp.local} onChange={(e) => m.set('remotePathMappings', maps.map((x, j) => (j === i ? { ...x, local: e.target.value } : x)))} />
              <button className="btn-secondary" onClick={() => m.set('remotePathMappings', maps.filter((_, j) => j !== i))} aria-label="Remove mapping">
                ✕
              </button>
            </div>
          ))}
          <button className="btn-secondary" onClick={() => m.set('remotePathMappings', [...maps, { remote: '', local: '' }])}>
            Add mapping
          </button>
        </div>
        <SaveBar onSave={m.save} saving={m.saving} message={m.message} />
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">File naming</h2>
        <Toggle label="Rename files" checked={n.values.renameFiles} onChange={(v) => n.set('renameFiles', v)} />
        <p className="hint">Tokens: {'{Movie Title} {Series Title} {Year} {season:00} {episode:00} {Episode Title} {Quality} {Resolution} {Air Date} {TMDB Id}'}</p>
        {(
          [
            ['movieFolder', 'Movie folder'],
            ['movieFile', 'Movie file'],
            ['seriesFolder', 'Series folder'],
            ['seasonFolder', 'Season folder'],
            ['episodeFile', 'Episode file'],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label} hint={<span className="font-mono">{preview(n.values[key], SAMPLE)}</span>}>
            <input className="input font-mono" value={n.values[key]} onChange={(e) => n.set(key, e.target.value)} />
          </Field>
        ))}
        <SaveBar onSave={n.save} saving={n.saving} message={n.message} />
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Searching</h2>
        <Field label="Check indexers for new releases every (minutes)">
          <input className="input w-28" type="number" min={10} value={d.values.rssSyncMinutes} onChange={(e) => d.set('rssSyncMinutes', Number(e.target.value))} />
        </Field>
        <Field label="Search again for missing items every (hours)">
          <input className="input w-28" type="number" min={1} value={d.values.searchMissingHours} onChange={(e) => d.set('searchMissingHours', Number(e.target.value))} />
        </Field>
        {(['defaultMovieProfile', 'defaultShowProfile'] as const).map((k) => (
          <Field key={k} label={k === 'defaultMovieProfile' ? 'Default quality for movies' : 'Default quality for shows'}>
            <select className="input" value={d.values[k] ?? ''} onChange={(e) => d.set(k, e.target.value ? Number(e.target.value) : null)}>
              <option value="">1080p or above</option>
              {profiles.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <Toggle
          label="Skip CAM and telesync copies"
          checked={d.values.skipCamReleases}
          onChange={(v) => d.set('skipCamReleases', v)}
          hint="Never grab releases filmed in a cinema or leaked early (CAM, TS, TC, screener)."
        />
        <Toggle
          label="Allow direct downloads from home-network addresses"
          checked={d.values.allowPrivateDirectUrls}
          onChange={(v) => d.set('allowPrivateDirectUrls', v)}
          hint="Off by default so a link can't be used to reach other devices on your network."
        />
        <SaveBar onSave={d.save} saving={d.saving} message={d.message} />
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Trailers and posters</h2>
        <Toggle label="Allow trailer downloads" checked={x.values.trailersEnabled} onChange={(v) => x.set('trailersEnabled', v)} hint="Trailers are saved next to each movie so Plex and Jellyfin play them as extras." />
        <Toggle label="Download a trailer for every new movie" checked={x.values.autoDownloadTrailers} onChange={(v) => x.set('autoDownloadTrailers', v)} />
        <Field label="Best trailer quality">
          <select className="input" value={x.values.trailerMaxHeight} onChange={(e) => x.set('trailerMaxHeight', Number(e.target.value))}>
            <option value={720}>720p</option>
            <option value={1080}>1080p</option>
            <option value={2160}>4K</option>
          </select>
        </Field>
        <Field label="yt-dlp location" hint="Included in the Docker image. Only change this if you run Cinemask outside Docker.">
          <input className="input" value={x.values.ytDlpPath} onChange={(e) => x.set('ytDlpPath', e.target.value)} />
        </Field>
        <Toggle label="Offer posters from ThePosterDB" checked={x.values.thePosterDb} onChange={(v) => x.set('thePosterDb', v)} hint="ThePosterDB has no official API, so this reads its search page and may stop working if the site changes." />
        <SaveBar onSave={x.save} saving={x.saving} message={x.message} />
      </section>
    </div>
  );
}
