import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { MediaGrid } from '../components/media';
import { Modal } from '../components/Modal';
import { Alert, Field, Toggle } from '../components/ui';
import { api, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { MediaCardData } from '../lib/media';

interface Options {
  genres: { id: number; name: string }[];
  providers: { id: number; name: string; logoPath: string }[];
  networks: { id: number; name: string }[];
  originals: number[];
  sorts: string[];
  region: string;
}

interface Filter {
  kind: 'movie' | 'tv';
  genres: number[];
  networks: number[];
  providers: number[];
  originals?: boolean;
  yearFrom?: number;
  yearTo?: number;
  ratingMin?: number;
  language?: string;
  sort: string;
}

const LANGUAGES = [
  ['', 'Any language'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
  ['hi', 'Hindi'],
  ['pt', 'Portuguese'],
  ['sv', 'Swedish'],
  ['da', 'Danish'],
  ['no', 'Norwegian'],
] as const;
const SORT_LABEL: Record<string, string> = { popular: 'Most popular', rating: 'Highest rated', newest: 'Newest', oldest: 'Oldest', title: 'Title' };
const EMPTY: Filter = { kind: 'movie', genres: [], networks: [], providers: [], sort: 'popular' };

function toQuery(f: Filter) {
  const q = new URLSearchParams({ kind: f.kind, sort: f.sort });
  if (f.genres.length) q.set('genres', f.genres.join(','));
  if (f.networks.length) q.set('networks', f.networks.join(','));
  if (f.providers.length) q.set('providers', f.providers.join(','));
  if (f.originals && f.providers.length) q.set('originals', 'true');
  if (f.yearFrom) q.set('yearFrom', String(f.yearFrom));
  if (f.yearTo) q.set('yearTo', String(f.yearTo));
  if (f.ratingMin) q.set('ratingMin', String(f.ratingMin));
  if (f.language) q.set('language', f.language);
  return q;
}

function Chips({ label, items, value, onChange }: { label: string; items: { id: number; name: string }[]; value: number[]; onChange: (v: number[]) => void }) {
  const [all, setAll] = useState(false);
  const [find, setFind] = useState('');
  if (!items.length) return null;
  const matching = find ? items.filter((i) => i.name.toLowerCase().includes(find.toLowerCase())) : items;
  // Picked chips stay visible when the list is folded.
  const shown = all || find ? matching : [...items.slice(0, 14), ...items.slice(14).filter((i) => value.includes(i.id))];
  return (
    <div>
      <div className="flex items-center gap-2">
        <div className="label">{label}</div>
        {items.length > 14 && <input className="input mb-1 h-7 w-40 py-0 text-xs" placeholder="Find…" value={find} onChange={(e) => setFind(e.target.value)} aria-label={`Find in ${label}`} />}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((i) => {
          const on = value.includes(i.id);
          return (
            <button
              key={i.id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(on ? value.filter((x) => x !== i.id) : [...value, i.id])}
              className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface-2 text-muted hover:text-text'}`}
            >
              {i.name}
            </button>
          );
        })}
        {items.length > 14 && !find && (
          <button type="button" className="px-2 text-xs text-accent" onClick={() => setAll(!all)}>
            {all ? 'Fewer' : `+${items.length - 14} more`}
          </button>
        )}
      </div>
    </div>
  );
}

function SaveAsList({ filter, onClose }: { filter: Filter; onClose: () => void }) {
  const [name, setName] = useState('');
  const [autoAdd, setAutoAdd] = useState(false);
  const [pages, setPages] = useState(1);
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const save = async () => {
    try {
      const { kind, genres, networks, providers, originals, yearFrom, yearTo, ratingMin, language, sort } = filter;
      await api('/api/lists', {
        body: { name, autoAdd, discover: { pages, filter: { kind, genres, networks, providers, originals: Boolean(originals && providers.length), yearFrom, yearTo, ratingMin, language, sort } } },
      });
      setMsg({ kind: 'success', text: 'Saved. It shows up under Lists and can be added to anyone’s homepage.' });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };
  return (
    <Modal title="Save as a list" onClose={onClose}>
      <div className="space-y-3">
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Animated family films" />
        </Field>
        <Field label="How many results" hint="20 titles per page">
          <select className="input" value={pages} onChange={(e) => setPages(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n * 20}
              </option>
            ))}
          </select>
        </Field>
        <Toggle label="Download new titles automatically" checked={autoAdd} onChange={setAutoAdd} hint="Anything in the list that isn't on the server gets monitored and searched for." />
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <button className="btn-primary" disabled={!name.trim()} onClick={save}>
          Save list
        </button>
      </div>
    </Modal>
  );
}

export function DiscoverPage() {
  const { me } = useAuth();
  const [f, setF] = useState<Filter>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [showFilters, setShowFilters] = useState(true);
  const set = <K extends keyof Filter>(k: K, v: Filter[K]) => setF({ ...f, [k]: v });
  const opts = useQuery({ queryKey: ['discover-options', f.kind], queryFn: () => api<Options>(`/api/discover/options?kind=${f.kind}`) });
  const qs = toQuery(f).toString();
  const res = useInfiniteQuery({
    queryKey: ['discover', qs],
    queryFn: ({ pageParam }) => api<{ results: MediaCardData[]; totalPages: number; totalResults: number }>(`/api/discover?${qs}&page=${pageParam}`),
    initialPageParam: 1,
    getNextPageParam: (last, all) => (all.length < last.totalPages ? all.length + 1 : undefined),
  });
  const items = res.data?.pages.flatMap((p) => p.results) ?? [];
  const thisYear = new Date().getFullYear();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Discover</h1>
        <div className="flex flex-wrap gap-2">
          <div className="flex overflow-hidden rounded-md border border-border">
            {(['movie', 'tv'] as const).map((k) => (
              <button key={k} onClick={() => setF({ ...EMPTY, kind: k, sort: f.sort })} className={`px-3 py-1.5 text-sm ${f.kind === k ? 'bg-accent text-accent-fg' : 'bg-surface-2 text-muted'}`}>
                {k === 'movie' ? 'Movies' : 'TV shows'}
              </button>
            ))}
          </div>
          <button className="btn-secondary" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
            Filters
          </button>
          {hasRole(me, 'manager') && (
            <button className="btn-secondary" onClick={() => setSaving(true)}>
              Save as list
            </button>
          )}
        </div>
      </div>

      {showFilters && (
        <div className="card space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label="Sort by">
              <select className="input" value={f.sort} onChange={(e) => set('sort', e.target.value)}>
                {(opts.data?.sorts ?? ['popular']).map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABEL[s] ?? s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="From year">
              <input className="input" type="number" min={1900} max={thisYear + 5} value={f.yearFrom ?? ''} onChange={(e) => set('yearFrom', e.target.value ? Number(e.target.value) : undefined)} />
            </Field>
            <Field label="To year">
              <input className="input" type="number" min={1900} max={thisYear + 5} value={f.yearTo ?? ''} onChange={(e) => set('yearTo', e.target.value ? Number(e.target.value) : undefined)} />
            </Field>
            <Field label="Minimum rating">
              <select className="input" value={f.ratingMin ?? ''} onChange={(e) => set('ratingMin', e.target.value ? Number(e.target.value) : undefined)}>
                <option value="">Any</option>
                {[5, 6, 7, 8, 9].map((n) => (
                  <option key={n} value={n}>
                    {n}+
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Original language">
              <select className="input" value={f.language ?? ''} onChange={(e) => set('language', e.target.value || undefined)}>
                {LANGUAGES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Chips label="Genres" items={opts.data?.genres ?? []} value={f.genres} onChange={(v) => set('genres', v)} />
          <Chips
            label={f.kind === 'tv' ? 'Channels and networks' : 'Made by a channel or service'}
            items={opts.data?.networks ?? []}
            value={f.networks}
            onChange={(v) => set('networks', v)}
          />
          <Chips label={`Streaming on${opts.data ? ` (${opts.data.region})` : ''}`} items={opts.data?.providers ?? []} value={f.providers} onChange={(v) => set('providers', v)} />
          {f.providers.some((p) => opts.data?.originals.includes(p)) && (
            <Toggle
              label="Originals only"
              checked={Boolean(f.originals)}
              onChange={(v) => set('originals', v)}
              hint={`Only ${f.kind === 'tv' ? 'shows' : 'movies'} the picked services made themselves, such as Netflix or Tubi originals.`}
            />
          )}
          <button className="text-sm text-muted hover:text-accent" onClick={() => setF({ ...EMPTY, kind: f.kind })}>
            Clear filters
          </button>
        </div>
      )}

      {res.error && <Alert>{(res.error as Error).message}</Alert>}
      {res.data && <p className="text-sm text-muted">{res.data.pages[0]?.totalResults.toLocaleString()} titles</p>}
      {opts.data && !opts.data.genres.length && <Alert kind="info">Discover needs a TMDB key. An admin can add one in Settings → Metadata.</Alert>}
      <MediaGrid items={items} />
      {res.hasNextPage && (
        <div className="flex justify-center">
          <button className="btn-secondary" disabled={res.isFetchingNextPage} onClick={() => res.fetchNextPage()}>
            {res.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
      {saving && <SaveAsList filter={f} onClose={() => setSaving(false)} />}
    </div>
  );
}
