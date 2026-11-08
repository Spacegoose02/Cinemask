import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, LoadError } from '../components/ui';
import { api, formatDate, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';

interface Play {
  id: number;
  server: string;
  user: string;
  kind: 'movie' | 'episode' | 'other';
  title: string;
  show: string | null;
  season: number | null;
  episode: number | null;
  tmdbId: number | null;
  state: string;
  positionMs: number;
  durationMs: number;
  watchedMs: number;
  progress: number | null;
  player: string | null;
  platform: string | null;
  decision: 'direct' | 'copy' | 'transcode';
  quality: string | null;
  bandwidthKbps: number | null;
  local: boolean | null;
  startedAt: number;
}

interface Stats {
  days: number;
  plays: number;
  hours: number;
  users: { user: string; plays: number; hours: number; lastAt: number }[];
  titles: { title: string; kind: 'movie' | 'show' | 'other'; tmdbId: number | null; plays: number; people: number }[];
  daily: { date: string; plays: number; hours: number }[];
  players: { player: string; plays: number }[];
  decisions: { direct: number; copy: number; transcode: number };
  history: Play[];
}

const DECISION = { direct: 'Direct play', copy: 'Direct stream', transcode: 'Transcoding' };
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
};
const name = (p: Play) => (p.kind === 'episode' ? `${p.show ?? ''} · S${p.season ?? '?'}E${p.episode ?? '?'} ${p.title}` : p.title);
const href = (p: { kind: string; tmdbId: number | null }) => (p.tmdbId ? `/${p.kind === 'movie' ? 'movie' : 'tv'}/${p.tmdbId}` : null);

/** Now playing: who's watching what on Plex and Jellyfin right now, and who watched what lately. */
export function NowPlayingPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');
  const live = useQuery({ queryKey: ['now-playing'], queryFn: () => api<{ sessions: Play[]; servers: string[] }>('/api/playing?fresh=1'), refetchInterval: 30_000 });
  const stats = useQuery({ queryKey: ['watch-stats', days], queryFn: () => api<Stats>(`/api/playing/stats?days=${days}`) });

  const stop = async (p: Play) => {
    const reason = prompt(`Stop ${p.user}'s stream of ${p.title}? A message for them:`, 'Stopped by the server admin.');
    if (reason === null) return;
    setError('');
    try {
      await api(`/api/playing/${p.id}/stop`, { body: { reason } });
      await qc.invalidateQueries({ queryKey: ['now-playing'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (live.error) return <LoadError queries={[live]} />;
  const s = stats.data;
  const maxDay = Math.max(1, ...(s?.daily.map((d) => d.plays) ?? [1]));
  const totalDecisions = s ? s.decisions.direct + s.decisions.copy + s.decisions.transcode : 0;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Now playing</h1>
      {error && <Alert>{error}</Alert>}
      {live.data && !live.data.servers.length && <div className="card text-sm text-muted">Connect Plex or Jellyfin in Settings → Media servers to see what's playing.</div>}
      {live.data?.servers.length ? (
        live.data.sessions.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {live.data.sessions.map((p) => {
              const link = href({ kind: p.kind === 'episode' ? 'show' : p.kind, tmdbId: p.tmdbId });
              return (
                <div key={p.id} className="card space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{link ? <Link to={link} className="hover:underline">{name(p)}</Link> : name(p)}</div>
                      <div className="text-xs text-muted">
                        {p.user} · {p.player ?? p.platform ?? 'a device'} · {p.server}
                        {p.local === false ? ' · away from home' : ''}
                      </div>
                    </div>
                    <span className={`shrink-0 rounded px-2 py-0.5 text-xs ${p.decision === 'transcode' ? 'bg-warning/20' : 'bg-surface-2'}`}>{DECISION[p.decision]}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded bg-surface-2">
                    <div className="h-full bg-accent" style={{ width: `${Math.round((p.progress ?? 0) * 100)}%` }} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                    <span>
                      {p.state === 'paused' ? 'Paused · ' : ''}
                      {clock(p.positionMs)} / {clock(p.durationMs)}
                      {p.quality ? ` · ${p.quality}` : ''}
                      {p.bandwidthKbps ? ` · ${(p.bandwidthKbps / 1000).toFixed(1)} Mbps` : ''}
                    </span>
                    {hasRole(me, 'admin') && (
                      <button className="btn-secondary px-2 py-0.5 text-xs" onClick={() => stop(p)}>
                        Stop
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="card text-sm text-muted">Nothing is playing right now.</div>
        )
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Watch stats</h2>
        <select className="input w-auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last year</option>
        </select>
      </div>
      {s && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="card">
              <div className="text-2xl font-semibold">{s.plays}</div>
              <div className="text-xs text-muted">plays</div>
            </div>
            <div className="card">
              <div className="text-2xl font-semibold">{s.hours}</div>
              <div className="text-xs text-muted">hours watched</div>
            </div>
            <div className="card">
              <div className="text-2xl font-semibold">{totalDecisions ? Math.round((s.decisions.transcode / totalDecisions) * 100) : 0}%</div>
              <div className="text-xs text-muted">transcoded</div>
            </div>
          </div>
          <section className="card space-y-2">
            <h3 className="font-semibold">Plays per day</h3>
            <div className="flex h-24 items-end gap-px" role="img" aria-label="Plays per day">
              {s.daily.map((d) => (
                <div key={d.date} className="flex-1 rounded-t bg-accent" style={{ height: `${(d.plays / maxDay) * 100}%`, minHeight: d.plays ? 2 : 0 }} title={`${d.date}: ${d.plays} plays, ${d.hours} h`} />
              ))}
            </div>
          </section>
          <div className="grid gap-3 md:grid-cols-2">
            <section className="card space-y-2">
              <h3 className="font-semibold">People</h3>
              {s.users.length ? (
                <table className="w-full text-sm">
                  <tbody>
                    {s.users.map((u) => (
                      <tr key={u.user} className="border-b border-border last:border-0">
                        <td className="py-1">{u.user}</td>
                        <td className="py-1 text-right text-muted">{u.plays} plays</td>
                        <td className="py-1 text-right text-muted">{u.hours} h</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-sm text-muted">Nothing watched yet.</p>
              )}
            </section>
            <section className="card space-y-2">
              <h3 className="font-semibold">Most watched</h3>
              <ol className="space-y-1 text-sm">
                {s.titles.map((x) => {
                  const link = href(x);
                  return (
                    <li key={`${x.kind}:${x.tmdbId ?? x.title}`} className="flex justify-between gap-2">
                      <span className="truncate">{link ? <Link to={link} className="hover:underline">{x.title}</Link> : x.title}</span>
                      <span className="shrink-0 text-muted">
                        {x.plays} plays · {x.people} {x.people === 1 ? 'person' : 'people'}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
            <section className="card space-y-2">
              <h3 className="font-semibold">Players</h3>
              <ul className="space-y-1 text-sm">
                {s.players.map((p) => (
                  <li key={p.player} className="flex justify-between">
                    <span>{p.player}</span>
                    <span className="text-muted">{p.plays}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section className="card space-y-2">
              <h3 className="font-semibold">How it was sent</h3>
              <ul className="space-y-1 text-sm">
                {(['direct', 'copy', 'transcode'] as const).map((k) => (
                  <li key={k} className="flex justify-between">
                    <span>{DECISION[k]}</span>
                    <span className="text-muted">{s.decisions[k]}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <section className="card overflow-x-auto p-0">
            <h3 className="px-4 pt-3 font-semibold">History</h3>
            <table className="w-full text-sm">
              <tbody>
                {s.history.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap p-2 pl-4 text-xs text-muted">{formatDate(p.startedAt)}</td>
                    <td className="p-2">{p.user}</td>
                    <td className="p-2">{name(p)}</td>
                    <td className="p-2 text-xs text-muted">{p.player ?? p.platform}</td>
                    <td className="p-2 pr-4 text-right text-xs text-muted">{clock(p.watchedMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
