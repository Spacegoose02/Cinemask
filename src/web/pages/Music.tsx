import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert } from '../components/ui';
import { api, formatDate, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePageState } from '../lib/history';
import { t } from '../lib/i18n';

type AlbumStatus = 'pending' | 'approved' | 'declined' | 'downloading' | 'available' | 'failed';

interface Artist {
  mbid: string;
  name: string;
  disambiguation: string | null;
  country: string | null;
  type: string | null;
  followed?: boolean;
  followId?: number | null;
}

interface Album {
  mbid: string;
  title: string;
  artist: string;
  artistMbid: string | null;
  year: number | null;
  type: string;
  secondary: string[];
  cover: string;
  request: { id: number; status: AlbumStatus } | null;
}

interface AlbumRequest {
  id: number;
  mbid: string;
  title: string;
  artist: string;
  artistMbid: string | null;
  year: number | null;
  type: string | null;
  status: AlbumStatus;
  requestedBy: number | null;
  requestedByName: string | null;
  decidedByName: string | null;
  reason: string | null;
  error: string | null;
  path: string | null;
  createdAt: number;
}

interface Followed {
  id: number;
  mbid: string;
  name: string;
  addedAt: number;
  checkedAt: number | null;
}

const STATUS_LABEL: Record<AlbumStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved',
  declined: 'Declined',
  downloading: 'Downloading',
  available: 'Available',
  failed: 'Failed',
};
const STATUS_STYLE: Record<AlbumStatus, string> = {
  pending: 'text-accent',
  approved: 'text-text',
  declined: 'text-danger',
  downloading: 'text-accent',
  available: 'text-success',
  failed: 'text-danger',
};

const cover = (mbid: string) => `https://coverartarchive.org/release-group/${mbid}/front-250`;

const TABS = [
  { id: 'find', label: 'Find music' },
  { id: 'requests', label: 'Requests' },
  { id: 'artists', label: 'Followed artists' },
] as const;

function Cover({ src, alt }: { src: string; alt: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="aspect-square overflow-hidden rounded border border-border bg-surface-2">
      {!broken ? (
        <img src={src} alt={alt} loading="lazy" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <div className="flex h-full items-center justify-center break-words p-2 text-center text-xs text-muted">{alt}</div>
      )}
    </div>
  );
}

/** Music: find albums on MusicBrainz, request them, and follow artists for their new albums. */
export function MusicPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((x) => x.id === params.get('tab'))?.id ?? 'find';
  const artist = params.get('artist');
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('Music')}</h1>
      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={tab === x.id}
            onClick={() => setParams({ tab: x.id })}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === x.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}`}
          >
            {t(x.label)}
          </button>
        ))}
      </div>
      {tab === 'find' && (artist ? <ArtistView mbid={artist} onBack={() => setParams({ tab: 'find' })} /> : <FindMusic onArtist={(mbid) => setParams({ tab: 'find', artist: mbid })} />)}
      {tab === 'requests' && <AlbumRequests />}
      {tab === 'artists' && <FollowedArtists onArtist={(mbid) => setParams({ tab: 'find', artist: mbid })} />}
    </div>
  );
}

function useRequest() {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const request = async (a: Album) => {
    setError('');
    try {
      await api('/api/music', { body: { mbid: a.mbid } });
      await Promise.all(['music-search', 'music-artist', 'music-requests'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { request, error };
}

function AlbumGrid({ albums, onRequest }: { albums: Album[]; onRequest: (a: Album) => void }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
      {albums.map((a) => (
        <div key={a.mbid} className="space-y-1">
          <Cover src={a.cover} alt={a.title} />
          <div className="line-clamp-2 text-sm font-medium" title={a.title}>
            {a.title}
          </div>
          <div className="truncate text-xs text-muted">
            {a.artist}
            {a.year ? ` · ${a.year}` : ''}
          </div>
          <div className="text-xs text-muted">{[a.type, ...a.secondary].join(' · ')}</div>
          <div className="pt-1">
            {a.request && a.request.status !== 'declined' && a.request.status !== 'failed' ? (
              <span className={`text-xs ${STATUS_STYLE[a.request.status]}`}>{t(STATUS_LABEL[a.request.status])}</span>
            ) : (
              <button className="btn-secondary px-2 py-1 text-xs" onClick={() => onRequest(a)}>
                {t('Request')}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function FindMusic({ onArtist }: { onArtist: (mbid: string) => void }) {
  const [input, setInput] = useState('');
  const [term, setTerm] = usePageState('q', '');
  const [type, setType] = usePageState('type', 'artist');
  const { request, error } = useRequest();
  const search = useQuery({
    queryKey: ['music-search', type, term],
    queryFn: () => api<{ artists?: Artist[]; albums?: Album[] }>(`/api/music/search?type=${type}&q=${encodeURIComponent(term)}`),
    enabled: Boolean(term),
  });
  return (
    <div className="space-y-4">
      <form
        className="flex max-w-xl flex-wrap gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setTerm(input.trim());
        }}
      >
        <select className="input w-auto" value={type} onChange={(e) => setType(e.target.value)} aria-label={t('Search for')}>
          <option value="artist">{t('Artists')}</option>
          <option value="album">{t('Albums')}</option>
        </select>
        <input className="input min-w-0 flex-1" placeholder={t(type === 'artist' ? 'Artist name' : 'Album title, or artist and album')} value={input} onChange={(e) => setInput(e.target.value)} aria-label={t('Search music')} />
        <button className="btn-primary">{t('Search')}</button>
      </form>
      {error && <Alert>{error}</Alert>}
      {search.error && <Alert>{(search.error as Error).message}</Alert>}
      {search.isLoading && term && <div className="text-sm text-muted">{t('Searching MusicBrainz…')}</div>}
      {!term && <div className="card text-sm text-muted">{t('Search for an artist to see their albums, or for an album to request it straight away.')}</div>}
      {search.data?.artists && (
        <ul className="divide-y divide-border rounded-md border border-border">
          {search.data.artists.length === 0 && <li className="p-3 text-sm text-muted">{t('No artists found.')}</li>}
          {search.data.artists.map((a) => (
            <li key={a.mbid}>
              <button className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-surface-2" onClick={() => onArtist(a.mbid)}>
                <span>
                  <span className="font-medium">{a.name}</span>
                  {a.disambiguation && <span className="text-muted"> ({a.disambiguation})</span>}
                  <span className="block text-xs text-muted">{[a.type, a.country].filter(Boolean).join(' · ')}</span>
                </span>
                {a.followed && <span className="text-xs text-success">{t('Following')}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {search.data?.albums && (search.data.albums.length ? <AlbumGrid albums={search.data.albums} onRequest={request} /> : <div className="card text-sm text-muted">{t('No albums found.')}</div>)}
      <p className="text-xs text-muted">{t('Music details come from MusicBrainz, covers from the Cover Art Archive.')}</p>
    </div>
  );
}

function ArtistView({ mbid, onBack }: { mbid: string; onBack: () => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const { request, error } = useRequest();
  const [msg, setMsg] = useState('');
  const [showAll, setShowAll] = useState(false);
  const q = useQuery({ queryKey: ['music-artist', mbid], queryFn: () => api<{ artist: Artist; albums: Album[] }>(`/api/music/artist/${mbid}`) });
  const follow = async () => {
    setMsg('');
    try {
      if (q.data?.artist.followed) await api(`/api/music/artists/${q.data.artist.followId}`, { method: 'DELETE' });
      else await api('/api/music/artists', { body: { mbid } });
      await Promise.all(['music-artist', 'music-artists'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  if (q.error) return <Alert>{(q.error as Error).message}</Alert>;
  if (!q.data) return <div className="text-sm text-muted">{t('Loading…')}</div>;
  const { artist } = q.data;
  const studio = q.data.albums.filter((a) => !a.secondary.length);
  const shown = showAll ? q.data.albums : studio;
  return (
    <div className="space-y-4">
      <button className="text-sm text-accent" onClick={onBack}>
        ← Back to search
      </button>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">
          {artist.name}
          {artist.disambiguation && <span className="text-base font-normal text-muted"> ({artist.disambiguation})</span>}
        </h2>
        {hasRole(me, 'manager') && (
          <button className="btn-secondary" onClick={follow} title={t('Request and download their new albums as they come out')}>
            {t(artist.followed ? 'Unfollow' : 'Follow new releases')}
          </button>
        )}
      </div>
      {(error || msg) && <Alert>{error || msg}</Alert>}
      {studio.length !== q.data.albums.length && (
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Include live albums, compilations and remixes
        </label>
      )}
      {shown.length ? <AlbumGrid albums={shown} onRequest={request} /> : <div className="card text-sm text-muted">{t('No albums listed for this artist.')}</div>}
    </div>
  );
}

function AlbumRequests() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const [status, setStatus] = usePageState('status', isManager ? 'pending' : 'all');
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['music-requests', status], queryFn: () => api<AlbumRequest[]>(`/api/music?status=${status}`) });
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['music-requests'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('Status')}>
        <option value="all">{t('All')}</option>
        {Object.entries(STATUS_LABEL).map(([k, v]) => (
          <option key={k} value={k}>
            {t(v)}
          </option>
        ))}
      </select>
      {error && <Alert>{error}</Alert>}
      {list.data?.length === 0 && <div className="card text-sm text-muted">{t('No album requests here.')}</div>}
      <ul className="space-y-3">
        {list.data?.map((r) => (
          <li key={r.id} className="card flex flex-wrap items-center gap-4 p-3">
            <div className="w-14 shrink-0">
              <Cover src={cover(r.mbid)} alt={r.title} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {r.artist} – {r.title} {r.year && <span className="text-muted">({r.year})</span>}
              </div>
              <div className="text-xs text-muted">
                {r.type ?? 'Album'} · requested by {r.requestedByName} · {formatDate(r.createdAt)}
              </div>
              <div className={`text-sm ${STATUS_STYLE[r.status]}`}>
                {t(STATUS_LABEL[r.status])}
                {r.decidedByName && ['approved', 'declined'].includes(r.status) && <span className="text-muted"> by {r.decidedByName}</span>}
                {r.reason && <span className="text-muted">: {r.reason}</span>}
              </div>
              {r.error && r.status === 'failed' && <div className="text-xs text-danger">{r.error}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              {isManager && r.status === 'pending' && (
                <>
                  <button className="btn-primary" onClick={() => act(() => api(`/api/music/${r.id}/approve`, { method: 'POST' }))}>
                    {t('Approve')}
                  </button>
                  <button
                    className="btn-danger"
                    onClick={() => {
                      const reason = prompt('Reason (optional):');
                      if (reason === null) return;
                      void act(() => api(`/api/music/${r.id}/decline`, { body: { reason: reason.trim() || undefined } }));
                    }}
                  >
                    {t('Decline')}
                  </button>
                </>
              )}
              {isManager && ['failed', 'approved', 'downloading'].includes(r.status) && (
                <button className="btn-secondary" onClick={() => act(() => api(`/api/music/${r.id}/retry`, { method: 'POST' }))}>
                  {t(r.status === 'downloading' ? 'Search again' : 'Retry')}
                </button>
              )}
              {(isManager || (r.requestedBy === me?.id && r.status === 'pending')) && (
                <button className="btn-secondary" onClick={() => confirm('Remove this request?') && act(() => api(`/api/music/${r.id}`, { method: 'DELETE' }))}>
                  {t(r.status === 'pending' && !isManager ? 'Cancel' : 'Remove')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FollowedArtists({ onArtist }: { onArtist: (mbid: string) => void }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const list = useQuery({ queryKey: ['music-artists'], queryFn: () => api<Followed[]>('/api/music/artists') });
  const unfollow = async (a: Followed) => {
    if (!confirm(`Stop following ${a.name}? Albums already requested stay.`)) return;
    setError('');
    try {
      await api(`/api/music/artists/${a.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['music-artists'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t('New albums and EPs by these artists are requested and downloaded by themselves, checked every morning.')}</p>
      {error && <Alert>{error}</Alert>}
      {list.data?.length === 0 && <div className="card text-sm text-muted">{t('No followed artists yet. Open an artist from Find music to follow them.')}</div>}
      <ul className="divide-y divide-border rounded-md border border-border">
        {list.data?.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 p-3">
            <button className="text-left font-medium hover:text-accent" onClick={() => onArtist(a.mbid)}>
              {a.name}
              <span className="block text-xs font-normal text-muted">Following since {formatDate(a.addedAt)}{a.checkedAt ? ` · checked ${formatDate(a.checkedAt)}` : ''}</span>
            </button>
            {hasRole(me, 'manager') && (
              <button className="btn-secondary" onClick={() => unfollow(a)}>
                {t('Unfollow')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
