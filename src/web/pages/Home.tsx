import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MediaRow } from '../components/media';
import { Modal } from '../components/Modal';
import { Alert } from '../components/ui';
import { collectionLibraries, inLibrary } from '../lib/collections';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { mediaPath, poster, type MediaCardData } from '../lib/media';

type HomeRow =
  | { type: 'featured' | 'recent' | 'upcoming' | 'requests' | 'collections' }
  | { type: 'trending'; kind: 'all' | 'movie' | 'tv' }
  | { type: 'popular'; kind: 'movie' | 'tv' }
  | { type: 'list' | 'collection'; id: number };

type Card = MediaCardData & { backdropPath?: string | null; overview?: string };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const KIND_NAME = { all: '', movie: 'movies', tv: 'shows' } as const;

function rowKey(r: HomeRow) {
  return 'id' in r ? `${r.type}:${r.id}` : 'kind' in r ? `${r.type}:${r.kind}` : r.type;
}

function useNames() {
  const lists = useQuery({ queryKey: ['lists'], queryFn: () => api<{ id: number; name: string }[]>('/api/lists') });
  const cols = useQuery({ queryKey: ['collections'], queryFn: () => api<{ id: number; name: string; poster: string | null; previewPosters: (string | null)[]; itemCount: number; library: string | null }[]>('/api/collections') });
  const label = (r: HomeRow): string => {
    switch (r.type) {
      case 'featured':
        return 'Featured';
      case 'recent':
        return 'Recently added';
      case 'upcoming':
        return 'Coming up';
      case 'requests':
        return 'My requests';
      case 'collections':
        return 'Collections';
      case 'trending':
        return `Trending ${KIND_NAME[r.kind]}`.trim();
      case 'popular':
        return `Popular ${KIND_NAME[r.kind]}`;
      case 'list':
        return lists.data?.find((l) => l.id === r.id)?.name ?? 'List';
      case 'collection':
        return cols.data?.find((c) => c.id === r.id)?.name ?? 'Collection';
    }
  };
  return { label, lists: lists.data ?? [], collections: cols.data ?? [] };
}

async function loadRow(r: HomeRow): Promise<Card[]> {
  switch (r.type) {
    case 'recent':
      return (await api<{ items: Card[] }>('/api/library/recent')).items;
    case 'trending':
    case 'featured':
      return (await api<{ results: Card[] }>(`/api/discover/trending?kind=${r.type === 'trending' ? r.kind : 'all'}`)).results;
    case 'popular':
      return (await api<{ results: Card[] }>(`/api/discover/popular?kind=${r.kind}`)).results;
    case 'upcoming': {
      const now = new Date();
      const entries = await api<{ kind: 'movie' | 'show'; tmdbId: number; title: string; year: number | null; posterPath: string | null }[]>(`/api/calendar?start=${iso(now)}&end=${iso(new Date(now.getTime() + 21 * 864e5))}`);
      const seen = new Set<string>();
      return entries.filter((e) => !seen.has(`${e.kind}${e.tmdbId}`) && seen.add(`${e.kind}${e.tmdbId}`)).map((e) => ({ ...e, availability: undefined }));
    }
    case 'requests':
      return (await api<{ kind: 'movie' | 'show'; tmdbId: number; title: string; year: number | null; posterPath: string | null }[]>('/api/requests?mine=true')).slice(0, 20);
    case 'list':
      return (await api<{ items: Card[] }>(`/api/lists/${r.id}/items?limit=30`)).items;
    case 'collection':
      return (await api<{ items: Card[] }>(`/api/collections/${r.id}`)).items;
    case 'collections':
      return [];
  }
}

function Featured() {
  const q = useQuery({ queryKey: ['home-row', 'featured'], queryFn: () => loadRow({ type: 'featured' }) });
  const [i, setI] = useState(0);
  const items = (q.data ?? []).filter((c) => c.backdropPath).slice(0, 6);
  const f = items[i % Math.max(items.length, 1)];
  if (!f) return null;
  return (
    <section className="relative overflow-hidden rounded-xl border border-border">
      <img src={poster(f.backdropPath, 'w780')!} alt="" className="absolute inset-0 h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-r from-bg via-bg/80 to-transparent" />
      <div className="relative max-w-xl space-y-3 p-6 md:p-10">
        <div className="text-xs uppercase tracking-wider text-accent">Trending this week</div>
        <h2 className="text-3xl font-bold">{f.title}</h2>
        {f.overview && <p className="line-clamp-3 text-sm text-text/90">{f.overview}</p>}
        <div className="flex items-center gap-2">
          <Link to={mediaPath(f.kind, f.tmdbId!)} className="btn-primary">
            View details
          </Link>
          {items.length > 1 && (
            <div className="ml-2 flex gap-1.5" role="tablist" aria-label="Featured titles">
              {items.map((x, n) => (
                <button key={x.tmdbId} role="tab" aria-selected={n === i % items.length} aria-label={x.title} onClick={() => setI(n)} className={`h-2 w-2 rounded-full ${n === i % items.length ? 'bg-accent' : 'bg-text/40'}`} />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function CollectionsRow({ items: all }: { items: ReturnType<typeof useNames>['collections'] }) {
  // Only the main library's collections (Movies), so one in Movies and Kids Movies shows once.
  const library = collectionLibraries(all)[0] ?? 'all';
  const items = inLibrary(all, library);
  if (!items.length) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Collections</h2>
        <Link to={library === 'all' ? '/collections' : `/collections?library=${encodeURIComponent(library)}`} className="text-sm text-muted hover:text-accent">
          See all
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {items.map((c) => {
          const img = poster(c.poster) ?? poster(c.previewPosters[0] ?? null);
          return (
            <Link key={c.id} to={`/collections/${c.id}`} className="w-32 shrink-0 sm:w-36">
              <div className="flex aspect-[2/3] items-center justify-center overflow-hidden rounded-md border border-border bg-surface-2 p-2 text-center text-xs text-muted">
                {img ? <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" /> : c.name}
              </div>
              <div className="mt-1.5 truncate text-sm">{c.name}</div>
              <div className="text-xs text-muted">{c.itemCount} titles</div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function Row({ row, label, more }: { row: HomeRow; label: string; more?: string }) {
  const q = useQuery({ queryKey: ['home-row', rowKey(row)], queryFn: () => loadRow(row) });
  return <MediaRow title={label} items={q.data ?? []} more={more} />;
}

function Customize({ rows, onClose }: { rows: HomeRow[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { label, lists, collections } = useNames();
  const [draft, setDraft] = useState<HomeRow[]>(rows);
  const [error, setError] = useState<string | null>(null);
  const builtIn: HomeRow[] = [
    { type: 'featured' },
    { type: 'recent' },
    { type: 'upcoming' },
    { type: 'requests' },
    { type: 'collections' },
    { type: 'trending', kind: 'all' },
    { type: 'trending', kind: 'movie' },
    { type: 'trending', kind: 'tv' },
    { type: 'popular', kind: 'movie' },
    { type: 'popular', kind: 'tv' },
  ];
  const options: HomeRow[] = [...builtIn, ...lists.map((l): HomeRow => ({ type: 'list', id: l.id })), ...collections.map((c): HomeRow => ({ type: 'collection', id: c.id }))].filter(
    (o) => !draft.some((d) => rowKey(d) === rowKey(o)),
  );
  const move = (i: number, dir: -1 | 1) => {
    const next = [...draft];
    [next[i], next[i + dir]] = [next[i + dir]!, next[i]!];
    setDraft(next);
  };
  const save = async (reset = false) => {
    try {
      await api('/api/home/layout', reset ? { method: 'DELETE' } : { method: 'PUT', body: { rows: draft } });
      await qc.invalidateQueries({ queryKey: ['home-layout'] });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title="Customize your homepage" onClose={onClose}>
      <ul className="mb-3 space-y-1">
        {draft.map((r, i) => (
          <li key={rowKey(r)} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5 text-sm">
            <span>{label(r)}</span>
            <span className="flex gap-1">
              <button className="btn-secondary px-2 py-0.5" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${label(r)} up`}>
                ↑
              </button>
              <button className="btn-secondary px-2 py-0.5" disabled={i === draft.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${label(r)} down`}>
                ↓
              </button>
              <button className="btn-secondary px-2 py-0.5" onClick={() => setDraft(draft.filter((_, n) => n !== i))} aria-label={`Remove ${label(r)}`}>
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
      {options.length > 0 && (
        <select className="input mb-4" value="" onChange={(e) => e.target.value && setDraft([...draft, options[Number(e.target.value)]!])} aria-label="Add a row">
          <option value="">Add a row…</option>
          {options.map((o, n) => (
            <option key={rowKey(o)} value={n}>
              {label(o)}
            </option>
          ))}
        </select>
      )}
      {error && <Alert>{error}</Alert>}
      <div className="flex justify-between">
        <button className="btn-primary" onClick={() => save()}>
          Save
        </button>
        <button className="btn-secondary" onClick={() => save(true)}>
          Reset to default
        </button>
      </div>
    </Modal>
  );
}

export function HomePage() {
  const { me } = useAuth();
  const layout = useQuery({ queryKey: ['home-layout'], queryFn: () => api<{ rows: HomeRow[]; custom: boolean }>('/api/home/layout') });
  const { label, collections } = useNames();
  const [customizing, setCustomizing] = useState(false);
  const rows = layout.data?.rows ?? [];
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Hi {me?.displayName || me?.username}</h1>
        <button className="btn-secondary" onClick={() => setCustomizing(true)}>
          Customize
        </button>
      </div>
      {rows.map((r) =>
        r.type === 'featured' ? (
          <Featured key="featured" />
        ) : r.type === 'collections' ? (
          <CollectionsRow key="collections" items={collections} />
        ) : (
          <Row key={rowKey(r)} row={r} label={label(r)} more={r.type === 'recent' ? '/library' : r.type === 'list' ? `/lists/${r.id}` : r.type === 'collection' ? `/collections/${r.id}` : r.type === 'upcoming' ? '/calendar' : r.type === 'requests' ? '/requests' : undefined} />
        ),
      )}
      {layout.data && !rows.length && <div className="card text-sm text-muted">Your homepage is empty. Use Customize to add rows.</div>}
      {customizing && <Customize rows={rows} onClose={() => setCustomizing(false)} />}
    </div>
  );
}
