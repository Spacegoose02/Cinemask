import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AiringRow, useAiring } from '../components/Airing';
import { DuplicatesDialog } from '../components/Duplicates';
import { MatchPicker } from '../components/MatchPicker';
import { MediaGrid } from '../components/media';
import { api, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MediaKind } from '../lib/media';

interface LibraryResponse {
  total: number;
  page: number;
  items: LibraryItem[];
}
interface LibraryItem {
  kind: MediaKind;
  tmdbId: number | null;
  title: string;
  year: number | null;
  posterPath: string | null;
  resolution: string | null;
  servers: string[];
  viewCount: number | null;
  lastViewedAt: number | null;
  itemIds: number[];
}

const PAGE_SIZE = 60;

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') ?? '';
  const sort = params.get('sort') ?? 'added';
  const resolution = params.get('resolution') ?? '';
  const q = params.get('q') ?? '';
  const watched = params.get('watched') ?? '';
  const library = params.get('library') ?? '';
  const { me } = useAuth();
  const isManager = hasRole(me, 'manager');
  const qc = useQueryClient();
  const [fixing, setFixing] = useState<LibraryItem | null>(null);
  const [dupes, setDupes] = useState(false);
  const page = Number(params.get('page') ?? 1);
  const qs = new URLSearchParams({ sort, page: String(page), pageSize: String(PAGE_SIZE), ...(kind && { kind }), ...(resolution && { resolution }), ...(library && { library }), ...(q && { q }), ...(watched === 'unmatched' ? { unmatched: 'true' } : watched && { watched }) });
  const lib = useQuery({ queryKey: ['library', qs.toString()], queryFn: () => api<LibraryResponse>(`/api/library?${qs}`) });
  const sections = useQuery({ queryKey: ['library-sections'], queryFn: () => api<{ libraries: { name: string; kind: MediaKind; count: number }[] }>('/api/library/sections') });
  // One entry per Plex library, narrowed to the chosen type.
  const libraries = [...new Set((sections.data?.libraries ?? []).filter((l) => !kind || l.kind === kind).map((l) => l.name))];

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next);
  };
  const pages = Math.max(1, Math.ceil((lib.data?.total ?? 0) / PAGE_SIZE));
  // Shows airing this week sit above the library, until it's filtered or paged.
  const showAiring = page === 1 && kind !== 'movie' && !q && !resolution && !watched && !library;
  const airing = useAiring();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">Library</h1>
        <div className="flex flex-wrap gap-2">
          <input className="input w-44" placeholder="Filter by title" defaultValue={q} onChange={(e) => set('q', e.target.value)} aria-label="Filter by title" />
          <select className="input w-auto" value={kind} onChange={(e) => set('kind', e.target.value)} aria-label="Type">
            <option value="">Movies and shows</option>
            <option value="movie">Movies</option>
            <option value="show">Shows</option>
          </select>
          {(libraries.length > 1 || library) && (
            <select className="input w-auto" value={library} onChange={(e) => set('library', e.target.value)} aria-label="Library">
              <option value="">All libraries</option>
              {libraries.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
              {library && !libraries.includes(library) && <option value={library}>{library}</option>}
            </select>
          )}
          <select className="input w-auto" value={resolution} onChange={(e) => set('resolution', e.target.value)} aria-label="Quality">
            <option value="">Any quality</option>
            <option value="2160p">4K</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="SD">SD</option>
          </select>
          <select className="input w-auto" value={watched} onChange={(e) => set('watched', e.target.value)} aria-label="Watched">
            <option value="">Watched or not</option>
            <option value="watched">Watched</option>
            <option value="unwatched">Not watched</option>
            {isManager && <option value="unmatched">No TMDB match</option>}
          </select>
          <select className="input w-auto" value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort">
            <option value="added">Recently added</option>
            <option value="title">Title</option>
            <option value="year">Year</option>
            <option value="release">Release date</option>
            <option value="rating">Rating</option>
          </select>
          {isManager && (
            <button className="btn-secondary" onClick={() => setDupes(true)}>
              Find duplicates
            </button>
          )}
        </div>
      </div>
      {showAiring && (
        <>
          <AiringRow title="Airing next" items={airing.data?.next ?? []} more="/calendar" />
          <AiringRow title="Recently aired" items={airing.data?.recent ?? []} more="/calendar" />
        </>
      )}
      {lib.data && lib.data.total === 0 && (
        <div className="card text-sm text-muted">Nothing here yet. An admin can connect BingeBandit, Plex or Jellyfin in Settings → Media servers.</div>
      )}
      <MediaGrid
        items={lib.data?.items ?? []}
        extra={
          isManager
            ? (i) => (
                <button className="mt-0.5 text-xs text-muted hover:text-text" onClick={() => setFixing(i)}>
                  Fix match
                </button>
              )
            : undefined
        }
      />
      {fixing && (
        <MatchPicker
          kind={fixing.kind}
          title={fixing.title}
          onClose={() => setFixing(null)}
          onPick={async (tmdbId) => {
            await api('/api/library/match', { body: { itemIds: fixing.itemIds, tmdbId } });
            await qc.invalidateQueries({ queryKey: ['library'] });
          }}
        />
      )}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button className="btn-secondary" disabled={page <= 1} onClick={() => set('page', String(page - 1))}>
            Previous
          </button>
          <span className="text-muted">
            Page {page} of {pages}
          </span>
          <button className="btn-secondary" disabled={page >= pages} onClick={() => set('page', String(page + 1))}>
            Next
          </button>
        </div>
      )}
      {dupes && <DuplicatesDialog onClose={() => setDupes(false)} />}
    </div>
  );
}
