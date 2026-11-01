import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Field, SecretInput, Toggle } from '../../components/ui';
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

type ExtraFolder = { id: string; name: string; kind: 'movie' | 'show'; path: string; category: string };

interface LibraryFolder {
  id: string;
  name: string;
  kind: 'movie' | 'show';
  bingePath: string;
  path: string | null;
  existing: string | null;
}

/**
 * Adds BingeBandit's libraries (Kids Movies, 4K, …) as folders, so adding a title here can put it
 * in the same library it will show up in there. Nothing is saved until Save.
 */
function FromBingeBandit({ extra, onAdd }: { extra: ExtraFolder[]; onAdd: (add: ExtraFolder[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string; missing?: LibraryFolder[] } | null>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const { folders } = await api<{ folders: LibraryFolder[] }>('/api/root-folders/bingebandit');
      const fresh = folders.filter((f) => f.path && !f.existing && !extra.some((e) => e.path === f.path));
      const missing = folders.filter((f) => !f.path);
      onAdd(fresh.map((f) => ({ id: f.id, name: f.name, kind: f.kind, path: f.path!, category: '' })));
      const text = fresh.length ? `Added ${fresh.map((f) => f.name).join(', ')}. Save to keep them.` : 'Every BingeBandit library Cinemask can see is already a folder here.';
      setMsg({ kind: 'success', text, missing });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className="btn-secondary" disabled={busy} onClick={run} title="Adds each BingeBandit movie and show library as a folder here">
        {busy ? 'Asking BingeBandit…' : 'Add BingeBandit libraries'}
      </button>
      {msg && (
        <div className={`basis-full text-sm ${msg.kind === 'error' ? 'text-danger' : 'text-muted'}`}>
          {msg.text}
          {!!msg.missing?.length && (
            <span className="block">
              Not found in this container: {msg.missing.map((f) => `${f.name} (${f.bingePath} in BingeBandit)`).join(', ')}. Map that share into Cinemask, or add the folder by hand.
            </span>
          )}
        </div>
      )}
    </>
  );
}

export function MediaManagementSettings() {
  const m = useSettingsSection('media');
  const n = useSettingsSection('naming');
  const d = useSettingsSection('downloading');
  const x = useSettingsSection('extras');
  const sub = useSettingsSection('subtitles');
  const profiles = useQuery({ queryKey: ['profiles'], queryFn: () => api<{ id: number; name: string }[]>('/api/profiles') });
  if (m.loading || n.loading || d.loading || x.loading || sub.loading) return null;
  const maps = m.values.remotePathMappings as { remote: string; local: string }[];
  const extra = m.values.extraFolders as ExtraFolder[];
  const setExtra = (i: number, patch: Partial<(typeof extra)[number]>) => m.set('extraFolders', extra.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const tiers = d.values.episodeSizeByRuntime as { minutes: number; gb: number }[];
  const setTier = (i: number, patch: Partial<(typeof tiers)[number]>) => d.set('episodeSizeByRuntime', tiers.map((t, j) => (j === i ? { ...t, ...patch } : t)));

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
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Download category for movies" hint="Empty uses each download client's own category.">
            <input className="input" value={m.values.moviesCategory} onChange={(e) => m.set('moviesCategory', e.target.value)} placeholder="cinemask" />
          </Field>
          <Field label="Download category for TV">
            <input className="input" value={m.values.tvCategory} onChange={(e) => m.set('tvCategory', e.target.value)} placeholder="cinemask" />
          </Field>
        </div>
        <div>
          <div className="label">More folders</div>
          <p className="hint mb-2">Extra places for movies or shows, such as Kids Movies, Kids TV or 4K. Each title picks its folder, and downloads for it use the folder's category.</p>
          {extra.map((f, i) => (
            <div key={i} className="mb-3 grid gap-2 rounded border border-border p-2 sm:grid-cols-[1fr_8rem_2fr_1fr_auto]">
              <input
                className="input"
                placeholder="Name"
                aria-label="Folder name"
                value={f.name}
                onChange={(e) => setExtra(i, { name: e.target.value })}
              />
              <select className="input" value={f.kind} onChange={(e) => setExtra(i, { kind: e.target.value as 'movie' | 'show' })} aria-label="Holds">
                <option value="movie">Movies</option>
                <option value="show">TV</option>
              </select>
              <input className="input" placeholder="/media/kids-movies" aria-label="Path" value={f.path} onChange={(e) => setExtra(i, { path: e.target.value })} />
              <input className="input" placeholder="Category" aria-label="Download category" value={f.category} onChange={(e) => setExtra(i, { category: e.target.value })} />
              <button className="btn-secondary" onClick={() => m.set('extraFolders', extra.filter((_, j) => j !== i))} aria-label="Remove folder">
                ✕
              </button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => m.set('extraFolders', [...extra, { id: `folder-${Date.now().toString(36)}`, name: '', kind: 'movie', path: '', category: '' }])}>
              Add folder
            </button>
            <FromBingeBandit extra={extra} onAdd={(add) => m.set('extraFolders', [...extra, ...add])} />
          </div>
        </div>
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
        <Field label="Watch folder" hint="Movies and shows you drop here are matched on TMDB and moved into your Movies or TV folder with the naming format, every few minutes. Name them like “Title (Year)” or “Show S01E02”. Leave empty to turn it off.">
          <input className="input" value={m.values.watchFolder ?? ''} onChange={(e) => m.set('watchFolder', e.target.value)} placeholder="/media/import" />
        </Field>
        <Toggle
          label="Unpack archives"
          hint="When a download arrives as a RAR, 7z or zip with no video beside it, unpack it before importing. The unpacked copy is removed once it's in the library."
          checked={m.values.unpackArchives}
          onChange={(v) => m.set('unpackArchives', v)}
        />
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
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Largest movie to grab (GB)" hint="0 means no limit. Each title can set its own.">
            <input className="input w-28" type="number" min={0} step={0.5} value={d.values.maxMovieSizeGb} onChange={(e) => d.set('maxMovieSizeGb', Number(e.target.value))} />
          </Field>
          <Field label="Largest episode to grab (GB)" hint="Season packs are judged per episode.">
            <input className="input w-28" type="number" min={0} step={0.5} value={d.values.maxEpisodeSizeGb} onChange={(e) => d.set('maxEpisodeSizeGb', Number(e.target.value))} />
          </Field>
        </div>
        <Field label="When only bigger releases are found" hint="Smaller releases are always picked first. This decides what happens when every release is over the limit.">
          <select className="input sm:w-auto" value={d.values.oversize ?? 'warn'} onChange={(e) => d.set('oversize', e.target.value)}>
            <option value="warn">Download it anyway, with a warning</option>
            <option value="ask">Ask me first (it waits on Downloads until you confirm)</option>
            <option value="skip">Don't download it</option>
          </select>
        </Field>
        <div className="space-y-2">
          <span className="label">Episode size by length</span>
          <p className="hint">
            Longer episodes can be bigger. The first row that covers a show's episode length applies, and longer episodes use the last row. Shows with no known length use the episode limit above.
          </p>
          {tiers.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
              Up to
              <input className="input w-20" type="number" min={1} max={600} value={t.minutes} onChange={(e) => setTier(i, { minutes: Number(e.target.value) })} aria-label="Minutes" />
              minutes:
              <input className="input w-24" type="number" min={0.1} step={0.1} value={t.gb} onChange={(e) => setTier(i, { gb: Number(e.target.value) })} aria-label="Largest size in GB" />
              GB
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => d.set('episodeSizeByRuntime', tiers.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {tiers.length < 10 && (
              <button className="btn-secondary" onClick={() => d.set('episodeSizeByRuntime', [...tiers, { minutes: (tiers[tiers.length - 1]?.minutes ?? 0) + 30, gb: (tiers[tiers.length - 1]?.gb ?? 0.5) + 0.5 }])}>
                Add a length
              </button>
            )}
            {!tiers.length && (
              <button
                className="btn-secondary max-w-full whitespace-normal text-left"
                onClick={() =>
                  d.set('episodeSizeByRuntime', [
                    { minutes: 30, gb: 0.8 },
                    { minutes: 60, gb: 1.5 },
                    { minutes: 90, gb: 2 },
                    { minutes: 120, gb: 2.5 },
                  ])
                }
              >
                Start from 30 min 0.8 GB, 1 h 1.5 GB, 1½ h 2 GB, 2 h 2.5 GB
              </button>
            )}
          </div>
        </div>
        <p className="hint">A bigger release is only grabbed when nothing within the limit is found, and the download is marked with a warning.</p>
        <Toggle
          label="Upgrade files automatically"
          checked={d.values.upgrades ?? true}
          onChange={(v) => d.set('upgrades', v)}
          hint="Replace a downloaded movie or episode when a better release turns up, as each quality profile allows. Off: once a title is downloaded it stays as it is."
        />
        <Toggle
          label="Skip CAM and telesync copies"
          checked={d.values.skipCamReleases}
          onChange={(v) => d.set('skipCamReleases', v)}
          hint="Never grab releases filmed in a cinema or leaked early (CAM, TS, TC, screener)."
        />
        <h3 className="pt-2 font-medium">Delay profile</h3>
        <p className="hint">Waiting a little after a release appears gives a better one (a proper, a higher quality, your preferred protocol) time to show up before anything is grabbed. Manual search can still grab straight away.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Prefer">
            <select className="input" value={d.values.preferredProtocol ?? 'any'} onChange={(e) => d.set('preferredProtocol', e.target.value)}>
              <option value="any">Either</option>
              <option value="usenet">Usenet</option>
              <option value="torrent">Torrents</option>
            </select>
          </Field>
          <Field label="Usenet delay (minutes)">
            <input className="input w-28" type="number" min={0} value={d.values.usenetDelayMinutes ?? 0} onChange={(e) => d.set('usenetDelayMinutes', Number(e.target.value))} />
          </Field>
          <Field label="Torrent delay (minutes)">
            <input className="input w-28" type="number" min={0} value={d.values.torrentDelayMinutes ?? 0} onChange={(e) => d.set('torrentDelayMinutes', Number(e.target.value))} />
          </Field>
        </div>
        <Toggle
          label="Don't wait for releases at the cutoff"
          checked={d.values.bypassDelayAtCutoff ?? true}
          onChange={(v) => d.set('bypassDelayAtCutoff', v)}
          hint="A release that already meets the quality profile's cutoff is grabbed at once."
        />
        <h3 className="pt-2 font-medium">Seeding and stalled downloads</h3>
        <p className="hint">With "Remove finished downloads" on (Folders above), torrents stay in the client until they reach the ratio or the time, whichever comes first. 0 turns each one off.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Seed to ratio">
            <input className="input w-28" type="number" min={0} step={0.1} value={d.values.seedRatio ?? 0} onChange={(e) => d.set('seedRatio', Number(e.target.value))} />
          </Field>
          <Field label="Or seed for (minutes)">
            <input className="input w-28" type="number" min={0} value={d.values.seedMinutes ?? 0} onChange={(e) => d.set('seedMinutes', Number(e.target.value))} />
          </Field>
          <Field label="Give up when stalled for (minutes)" hint="No progress for this long: blocklist it and try another release. 0 is off.">
            <input className="input w-28" type="number" min={0} value={d.values.stalledMinutes ?? 0} onChange={(e) => d.set('stalledMinutes', Number(e.target.value))} />
          </Field>
        </div>
        <Toggle
          label="Allow direct downloads from home-network addresses"
          checked={d.values.allowPrivateDirectUrls}
          onChange={(v) => d.set('allowPrivateDirectUrls', v)}
          hint="Off by default so a link can't be used to reach other devices on your network."
        />
        <SaveBar onSave={d.save} saving={d.saving} message={d.message} />
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Subtitles</h2>
        <p className="hint">Subtitles come from OpenSubtitles.com and are saved next to each video (Movie.en.srt), where Plex, Jellyfin and BingeBandit find them. Matching by the file itself first means they're in sync with your copy.</p>
        <Toggle label="Fetch subtitles" checked={sub.values.enabled} onChange={(v) => sub.set('enabled', v)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="API key" hint="opensubtitles.com → your profile → API consumers → New consumer.">
            <SecretInput isSet={sub.secretsSet['apiKey']!} value={sub.secrets['apiKey']} onChange={(v) => sub.setSecret('apiKey', v)} />
          </Field>
          <Field label="Languages" hint="Two-letter codes, comma separated, such as en, es.">
            <input
              className="input"
              defaultValue={(sub.values.languages as string[]).join(', ')}
              onBlur={(e) => sub.set('languages', e.target.value.split(/[ ,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))}
            />
          </Field>
          <Field label="Username (optional)" hint="An account allows more downloads a day.">
            <input className="input" autoComplete="off" value={sub.values.username} onChange={(e) => sub.set('username', e.target.value)} />
          </Field>
          <Field label="Password">
            <SecretInput isSet={sub.secretsSet['password']!} value={sub.secrets['password']} onChange={(v) => sub.setSecret('password', v)} />
          </Field>
          <Field label="Hearing-impaired subtitles">
            <select className="input" value={sub.values.hearingImpaired} onChange={(e) => sub.set('hearingImpaired', e.target.value)}>
              <option value="prefer_not">Only when there's nothing else</option>
              <option value="include">Either kind</option>
              <option value="only">Always (sound descriptions)</option>
            </select>
          </Field>
        </div>
        <Toggle label="Fetch them after each download" checked={sub.values.auto} onChange={(v) => sub.set('auto', v)} hint="Otherwise use Fetch subtitles on a title's page." />
        <SaveBar onSave={sub.save} saving={sub.saving} message={sub.message} />
      </section>

      <section className="card space-y-4">
        <h2 className="font-semibold">Trailers, YouTube and posters</h2>
        <Toggle label="Allow trailer downloads" checked={x.values.trailersEnabled} onChange={(v) => x.set('trailersEnabled', v)} hint="Trailers are saved next to each movie so Plex and Jellyfin play them as extras." />
        <Toggle label="Download trailers automatically" hint="For every movie and show Cinemask manages that has files: after a download, and hourly for any still without one." checked={x.values.autoDownloadTrailers} onChange={(v) => x.set('autoDownloadTrailers', v)} />
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
        <Field label="YouTube folder" hint="Where subscribed YouTube channels are saved, one folder per channel. Add it to Plex or Jellyfin as a TV library.">
          <input className="input" value={x.values.youtubePath} onChange={(e) => x.set('youtubePath', e.target.value)} />
        </Field>
        <Field label="YouTube download folder" hint="Optional. Videos download here first and move into the YouTube folder when they're finished, so Plex and Jellyfin never see half-done files. Leave empty to download straight into the YouTube folder.">
          <input className="input" placeholder="/downloads/youtube" value={x.values.youtubeDownloadPath} onChange={(e) => x.set('youtubeDownloadPath', e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Best YouTube quality">
            <select className="input" value={x.values.youtubeMaxHeight} onChange={(e) => x.set('youtubeMaxHeight', Number(e.target.value))}>
              <option value={720}>720p</option>
              <option value={1080}>1080p</option>
              <option value={2160}>4K</option>
            </select>
          </Field>
          <Field label="Check channels every (hours)">
            <input className="input" type="number" min={1} max={168} value={x.values.youtubeCheckHours} onChange={(e) => x.set('youtubeCheckHours', Number(e.target.value))} />
          </Field>
        </div>
        <Toggle label="Offer posters from ThePosterDB" checked={x.values.thePosterDb} onChange={(v) => x.set('thePosterDb', v)} hint="ThePosterDB has no official API, so this reads its search page and may stop working if the site changes." />
        <SaveBar onSave={x.save} saving={x.saving} message={x.message} />
      </section>
    </div>
  );
}
