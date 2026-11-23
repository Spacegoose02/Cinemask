import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { MatchPicker } from '../components/MatchPicker';
import { StatusBadge } from '../components/media';
import { LoadError } from '../components/ui';
import { api, formatBytes, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import { t } from '../lib/i18n';
import { mediaPath, poster, serverName, type MediaKind } from '../lib/media';

interface LibraryItemDetail {
  id: number;
  kind: MediaKind;
  tmdbId: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  title: string;
  year: number | null;
  posterPath: string | null;
  resolution: string | null;
  itemIds: number[];
  copies: { id: number; server: string; library: string | null; resolution: string | null; addedAt: number | null; viewCount: number | null; lastViewedAt: number | null; labels: string[] }[];
  episodes: { season: number; episode: number; title: string | null; resolution: string | null; viewCount: number | null }[];
}

interface ServerFile {
  path: string;
  size: number | null;
  container: string | null;
  resolution: string | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  durationMin: number | null;
  bitrateKbps: number | null;
  season?: number | null;
  episode?: number | null;
}

const pad = (n: number | null | undefined) => String(n ?? 0).padStart(2, '0');
const day = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null);
const channels = (n: number | null) => (n === 8 ? '7.1' : n === 6 ? '5.1' : n === 2 ? 'stereo' : n === 1 ? 'mono' : n ? `${n} ch` : '');

function Fact({ label, children }: { label: string; children: ReactNode }) {
  if (!children) return null;
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** What the media servers say is in each file: path, size, picture and sound. */
function ServerFiles({ id }: { id: number }) {
  const q = useQuery({ queryKey: ['library-item-files', id], queryFn: () => api<{ servers: { itemId: number; server: string; files: ServerFile[]; error: string | null }[] }>(`/api/library/items/${id}/files`) });
  return (
    <section className="card space-y-3">
      <h2 className="text-lg font-semibold">{t('Files')}</h2>
      <LoadError queries={[q]} />
      {q.isLoading && <p className="text-sm text-muted">{t('Asking the media server…')}</p>}
      {q.data?.servers.map((s) => (
        <div key={s.itemId} className="space-y-2">
          {q.data.servers.length > 1 && <h3 className="text-sm font-medium">{serverName(s.server)}</h3>}
          {s.error && <p className="text-sm text-warning">{s.error}</p>}
          {!s.error && !s.files.length && <p className="text-sm text-muted">{t('The server lists no files for this title.')}</p>}
          <ul className="space-y-2">
            {s.files.map((f, n) => (
              <li key={`${f.path}-${n}`} className="rounded border border-border p-2 text-sm">
                <div className="break-all font-mono text-xs">
                  {f.season != null && <span className="mr-2 font-sans text-muted">S{pad(f.season)}E{pad(f.episode)}</span>}
                  {f.path}
                </div>
                <div className="mt-1 text-xs text-muted">
                  {[
                    f.resolution && `${f.resolution}${f.width && f.height ? ` (${f.width}×${f.height})` : ''}`,
                    f.videoCodec?.toUpperCase(),
                    f.audioCodec && [f.audioCodec.toUpperCase(), channels(f.audioChannels)].filter(Boolean).join(' '),
                    f.container?.toUpperCase(),
                    f.durationMin && `${f.durationMin} min`,
                    f.bitrateKbps && `${(f.bitrateKbps / 1000).toFixed(1)} Mbps`,
                    f.size && formatBytes(f.size),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/**
 * The page for a library title with no TMDB match. It has no movie or show page until it's matched,
 * so this shows what the servers know, its files for managers, and Fix match.
 */
export function LibraryItemPage() {
  const { id: raw } = useParams();
  const id = Number(raw);
  const { me } = useAuth();
  const isManager = hasRole(me, 'manager');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [fixing, setFixing] = useState(false);
  const q = useQuery({ queryKey: ['library', 'item', id], queryFn: () => api<LibraryItemDetail>(`/api/library/items/${id}`), enabled: Number.isInteger(id) && id > 0 });
  const item = q.data;
  // Matched since (by a sync or Fix match elsewhere): the real page has everything.
  if (item?.tmdbId) return <Navigate to={mediaPath(item.kind, item.tmdbId)} replace />;
  const img = poster(item?.posterPath);
  const seasons = [...new Set(item?.episodes.map((e) => e.season) ?? [])];
  const plays = item ? Math.max(0, ...item.copies.map((c) => c.viewCount ?? 0)) : 0;
  const lastPlayed = item ? Math.max(0, ...item.copies.map((c) => c.lastViewedAt ?? 0)) : 0;
  const added = item ? Math.max(0, ...item.copies.map((c) => c.addedAt ?? 0)) : 0;

  return (
    <div className="space-y-4">
      <Link to="/library" className="text-sm text-muted hover:text-accent">
        ← {t('Library')}
      </Link>
      <LoadError queries={[q]} />
      {item && (
        <>
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="aspect-[2/3] w-40 shrink-0 overflow-hidden rounded-md border border-border bg-surface-2">
              {img ? <img src={img} alt="" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center p-2 text-center text-sm text-muted">{item.title}</div>}
            </div>
            <div className="min-w-0 space-y-3">
              <div>
                <h1 className="text-2xl font-semibold">{item.title}</h1>
                <div className="text-sm text-muted">
                  {[item.year, item.kind === 'movie' ? t('Movie') : t('Series')].filter(Boolean).join(' · ')}
                </div>
              </div>
              <StatusBadge status="on_server" resolution={item.resolution} />
              <p className="text-sm text-muted">
                {t('This title has no TMDB match yet, so there is no poster, overview or request page for it.')}
                {isManager ? ` ${t('Use Fix match to pick the right title.')}` : ` ${t('A manager can fix the match.')}`}
              </p>
              {isManager && (
                <button className="btn-primary" onClick={() => setFixing(true)}>
                  {t('Fix match')}
                </button>
              )}
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Fact label={t('On')}>{item.copies.map((c) => [serverName(c.server), c.library].filter(Boolean).join(' · ')).join(', ')}</Fact>
                <Fact label={t('Added')}>{day(added || null)}</Fact>
                <Fact label={t('Watched')}>{plays ? `${plays === 1 ? t('Once') : `${plays} ${t('times')}`}${lastPlayed ? `, ${day(lastPlayed)}` : ''}` : t('Not yet')}</Fact>
                <Fact label="IMDb">{item.imdbId}</Fact>
                <Fact label="TVDB">{item.tvdbId}</Fact>
                <Fact label={t('Labels')}>{[...new Set(item.copies.flatMap((c) => c.labels))].join(', ')}</Fact>
              </dl>
            </div>
          </div>
          {item.kind === 'show' && seasons.length > 0 && (
            <section className="card space-y-2">
              <h2 className="text-lg font-semibold">{t('Seasons')}</h2>
              {seasons.map((s) => {
                const eps = item.episodes.filter((e) => e.season === s);
                return (
                  <details key={s} className="border-b border-border last:border-0">
                    <summary className="flex cursor-pointer items-center justify-between py-2">
                      <span className="font-medium">{s === 0 ? t('Specials') : `${t('Season')} ${s}`}</span>
                      <span className="text-sm text-muted">
                        {eps.length} {t('on server')}
                      </span>
                    </summary>
                    <ul className="space-y-1 pb-2 text-sm">
                      {eps.map((e) => (
                        <li key={e.episode} className="flex items-center justify-between gap-3 rounded px-2 py-1">
                          <span className="min-w-0 truncate">
                            <span className="text-muted">E{pad(e.episode)}</span> {e.title}
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {e.viewCount ? <span className="text-xs text-success">✓ {t('Watched')}</span> : null}
                            <StatusBadge status="on_server" resolution={e.resolution} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </details>
                );
              })}
            </section>
          )}
          {isManager && <ServerFiles id={item.id} />}
          {fixing && (
            <MatchPicker
              kind={item.kind}
              title={item.title}
              onClose={() => setFixing(false)}
              onPick={async (tmdbId) => {
                await api('/api/library/match', { body: { itemIds: item.itemIds, tmdbId } });
                await qc.invalidateQueries({ queryKey: ['library'] });
                navigate(mediaPath(item.kind, tmdbId));
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
