import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { MediaGrid } from '../components/media';
import { api } from '../lib/api';
import type { MediaKind } from '../lib/media';

interface LibraryResponse {
  total: number;
  page: number;
  items: { kind: MediaKind; tmdbId: number | null; title: string; year: number | null; posterPath: string | null; resolution: string | null; servers: string[] }[];
}

const PAGE_SIZE = 60;

export function LibraryPage() {
  const [params, setParams] = useSearchParams();
  const kind = params.get('kind') ?? '';
  const sort = params.get('sort') ?? 'added';
  const resolution = params.get('resolution') ?? '';
  const q = params.get('q') ?? '';
  const page = Number(params.get('page') ?? 1);
  const qs = new URLSearchParams({ sort, page: String(page), pageSize: String(PAGE_SIZE), ...(kind && { kind }), ...(resolution && { resolution }), ...(q && { q }) });
  const lib = useQuery({ queryKey: ['library', qs.toString()], queryFn: () => api<LibraryResponse>(`/api/library?${qs}`) });

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next);
  };
  const pages = Math.max(1, Math.ceil((lib.data?.total ?? 0) / PAGE_SIZE));

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
          <select className="input w-auto" value={resolution} onChange={(e) => set('resolution', e.target.value)} aria-label="Quality">
            <option value="">Any quality</option>
            <option value="2160p">4K</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="SD">SD</option>
          </select>
          <select className="input w-auto" value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort">
            <option value="added">Recently added</option>
            <option value="title">Title</option>
            <option value="year">Year</option>
            <option value="release">Release date</option>
            <option value="rating">Rating</option>
          </select>
        </div>
      </div>
      {lib.data && lib.data.total === 0 && (
        <div className="card text-sm text-muted">Nothing here yet. An admin can connect Plex or Jellyfin in Settings → Media servers.</div>
      )}
      <MediaGrid items={lib.data?.items ?? []} />
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
    </div>
  );
}
