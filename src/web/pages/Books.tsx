import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { Alert } from '../components/ui';
import { api, formatDate, hasRole } from '../lib/api';
import { useAuth } from '../lib/auth';
import { poster } from '../lib/media';

type Format = 'audiobook' | 'ebook';
type BookStatus = 'pending' | 'approved' | 'declined' | 'downloading' | 'available' | 'failed';

interface BookResult {
  workKey: string;
  title: string;
  author: string | null;
  year: number | null;
  coverId: number | null;
  inAudiobookshelf: boolean;
  requests: Partial<Record<Format, { id: number; status: BookStatus }>>;
}

interface BookRequest {
  id: number;
  workKey: string;
  format: Format;
  title: string;
  author: string | null;
  year: number | null;
  coverId: number | null;
  status: BookStatus;
  requestedBy: number | null;
  requestedByName: string | null;
  decidedByName: string | null;
  reason: string | null;
  error: string | null;
  createdAt: number;
}

interface AbsItem {
  absId: string;
  title: string;
  author: string | null;
  cover: string;
}

interface Podcast {
  itunesId: number;
  title: string;
  author: string | null;
  artwork: string | null;
  genre: string | null;
  episodes: number | null;
  subscribed: boolean;
}

const cover = (id: number | null) => (id ? `https://covers.openlibrary.org/b/id/${id}-M.jpg` : null);

const STATUS_LABEL: Record<BookStatus, string> = {
  pending: 'Waiting for approval',
  approved: 'Approved',
  declined: 'Declined',
  downloading: 'Downloading',
  available: 'Available',
  failed: 'Failed',
};
const STATUS_STYLE: Record<BookStatus, string> = {
  pending: 'text-accent',
  approved: 'text-text',
  declined: 'text-danger',
  downloading: 'text-accent',
  available: 'text-success',
  failed: 'text-danger',
};

const TABS = [
  { id: 'library', label: 'Audiobooks' },
  { id: 'find', label: 'Find books' },
  { id: 'requests', label: 'Requests' },
  { id: 'podcasts', label: 'Podcasts' },
] as const;

function Cover({ src, alt }: { src: string | null; alt: string }) {
  // Falls back to the title when there's no cover or it fails to load.
  const [broken, setBroken] = useState(false);
  return (
    <div className="aspect-[2/3] overflow-hidden rounded border border-border bg-surface-2">
      {src && !broken ? (
        <img src={src} alt={alt} loading="lazy" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <div className="flex h-full items-center justify-center break-words p-2 text-center text-xs text-muted">{alt}</div>
      )}
    </div>
  );
}

export function BooksPage() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'library';
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Books</h1>
      <div className="flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setParams({ tab: t.id })}
            className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t.id ? 'border-accent text-accent' : 'border-transparent text-muted hover:text-text'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'library' && <AbsLibrary type="book" />}
      {tab === 'find' && <FindBooks />}
      {tab === 'requests' && <BookRequests />}
      {tab === 'podcasts' && <Podcasts />}
    </div>
  );
}

function AbsLibrary({ type }: { type: 'book' | 'podcast' }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const q = useQuery({ queryKey: ['abs-library', type], queryFn: () => api<{ connected: boolean; items: AbsItem[] }>(`/api/books/library?type=${type}`) });
  const sync = async () => {
    setMsg(null);
    try {
      const r = await api<{ books: number; podcasts: number }>('/api/books/library/sync', { method: 'POST' });
      setMsg({ kind: 'success', text: `Synced ${r.books} audiobooks and ${r.podcasts} podcasts` });
      await qc.invalidateQueries({ queryKey: ['abs-library'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };
  if (!q.data) return null;
  if (!q.data.connected && !q.data.items.length) {
    return (
      <div className="card text-sm text-muted">
        Audiobookshelf isn't connected yet.{' '}
        {hasRole(me, 'admin') ? (
          <Link to="/settings/books" className="text-accent">
            Connect it in Settings → Books.
          </Link>
        ) : (
          'Ask an admin to connect it.'
        )}
      </div>
    );
  }
  const f = filter.trim().toLowerCase();
  const items = q.data.items.filter((i) => !f || i.title.toLowerCase().includes(f) || i.author?.toLowerCase().includes(f));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input className="input max-w-xs" placeholder={`Filter ${q.data.items.length} ${type === 'book' ? 'audiobooks' : 'podcasts'}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {hasRole(me, 'manager') && (
          <button className="btn-secondary" onClick={sync}>
            Sync with Audiobookshelf
          </button>
        )}
      </div>
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {!items.length && <div className="card text-sm text-muted">Nothing here yet.</div>}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-5 lg:grid-cols-7">
        {items.map((i) => (
          <div key={i.absId} className="space-y-1">
            <Cover src={poster(i.cover)} alt={i.title} />
            <div className="truncate text-sm font-medium" title={i.title}>
              {i.title}
            </div>
            {i.author && <div className="truncate text-xs text-muted">{i.author}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function FindBooks() {
  const qc = useQueryClient();
  const [input, setInput] = useState('');
  const [term, setTerm] = useState('');
  const [error, setError] = useState('');
  const trending = useQuery({ queryKey: ['books-trending'], queryFn: () => api<BookResult[]>('/api/books/trending'), enabled: !term });
  const search = useQuery({ queryKey: ['books-search', term], queryFn: () => api<{ total: number; results: BookResult[] }>(`/api/books/search?q=${encodeURIComponent(term)}`), enabled: Boolean(term) });
  const results = term ? search.data?.results : trending.data;
  const loading = term ? search.isLoading : trending.isLoading;
  const failed = (term ? search.error : trending.error) as Error | null;

  const request = async (b: BookResult, format: Format) => {
    setError('');
    try {
      await api('/api/books', { body: { workKey: b.workKey, format } });
      await qc.invalidateQueries({ queryKey: ['books-search'] });
      await qc.invalidateQueries({ queryKey: ['books-trending'] });
      await qc.invalidateQueries({ queryKey: ['book-requests'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const button = (b: BookResult, format: Format) => {
    const r = b.requests[format];
    const label = format === 'audiobook' ? 'Audiobook' : 'Ebook';
    if (format === 'audiobook' && b.inAudiobookshelf) return <span className="text-xs text-success">Audiobook in library</span>;
    if (r && r.status !== 'declined' && r.status !== 'failed') return <span className={`text-xs ${STATUS_STYLE[r.status]}`}>{`${label}: ${STATUS_LABEL[r.status].toLowerCase()}`}</span>;
    return (
      <button className="btn-secondary px-2 py-1 text-xs" onClick={() => request(b, format)}>
        Request {label.toLowerCase()}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <form
        className="flex max-w-xl gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setTerm(input.trim());
        }}
      >
        <input className="input" placeholder="Title, author or ISBN" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search books" />
        <button className="btn-primary">Search</button>
      </form>
      <h2 className="font-semibold">{term ? `Results for “${term}”` : 'Trending this week'}</h2>
      {error && <Alert>{error}</Alert>}
      {failed && <Alert>{failed.message}</Alert>}
      {loading && <div className="text-sm text-muted">Loading…</div>}
      {results?.length === 0 && <div className="card text-sm text-muted">No books found.</div>}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
        {results?.map((b) => (
          <div key={b.workKey} className="space-y-1">
            <Cover src={cover(b.coverId)} alt={b.title} />
            <div className="line-clamp-2 text-sm font-medium" title={b.title}>
              {b.title}
            </div>
            <div className="truncate text-xs text-muted">
              {b.author ?? 'Unknown author'}
              {b.year ? ` · ${b.year}` : ''}
            </div>
            <div className="flex flex-col items-start gap-1 pt-1">
              {button(b, 'audiobook')}
              {button(b, 'ebook')}
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">Book details and covers come from Open Library.</p>
    </div>
  );
}

function BookRequests() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const isManager = hasRole(me, 'manager');
  const [status, setStatus] = useState(isManager ? 'pending' : 'all');
  const [error, setError] = useState('');
  const [matching, setMatching] = useState<BookRequest | null>(null);
  const list = useQuery({ queryKey: ['book-requests', status], queryFn: () => api<BookRequest[]>(`/api/books?status=${status}`) });
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['book-requests'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-4">
      <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
        <option value="all">All</option>
        {Object.entries(STATUS_LABEL).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      {error && <Alert>{error}</Alert>}
      {list.data?.length === 0 && <div className="card text-sm text-muted">No book requests here.</div>}
      <ul className="space-y-3">
        {list.data?.map((r) => (
          <li key={r.id} className="card flex flex-wrap items-center gap-4 p-3">
            <div className="w-14 shrink-0">
              <Cover src={cover(r.coverId)} alt={r.title} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {r.title} {r.year && <span className="text-muted">({r.year})</span>}
              </div>
              <div className="text-xs text-muted">
                {r.format === 'audiobook' ? 'Audiobook' : 'Ebook'}
                {r.author ? ` · ${r.author}` : ''} · requested by {r.requestedByName} · {formatDate(r.createdAt)}
              </div>
              <div className={`text-sm ${STATUS_STYLE[r.status]}`}>
                {STATUS_LABEL[r.status]}
                {r.decidedByName && ['approved', 'declined'].includes(r.status) && <span className="text-muted"> by {r.decidedByName}</span>}
                {r.reason && <span className="text-muted">: {r.reason}</span>}
              </div>
              {r.error && r.status === 'failed' && <div className="text-xs text-danger">{r.error}</div>}
            </div>
            <div className="flex flex-wrap gap-2">
              {isManager && r.status === 'pending' && (
                <>
                  <button className="btn-primary" onClick={() => act(() => api(`/api/books/${r.id}/approve`, { method: 'POST' }))}>
                    Approve
                  </button>
                  <button
                    className="btn-danger"
                    onClick={() => {
                      const reason = prompt('Reason (optional):');
                      // Cancel means don't decline; OK with nothing typed declines without a reason.
                      if (reason === null) return;
                      void act(() => api(`/api/books/${r.id}/decline`, { body: { reason: reason.trim() || undefined } }));
                    }}
                  >
                    Decline
                  </button>
                </>
              )}
              {isManager && ['failed', 'approved', 'downloading'].includes(r.status) && (
                <button className="btn-secondary" onClick={() => act(() => api(`/api/books/${r.id}/retry`, { method: 'POST' }))}>
                  {r.status === 'downloading' ? 'Search again' : 'Retry'}
                </button>
              )}
              {isManager && r.status !== 'available' && (
                <button className="btn-secondary" onClick={() => setMatching(r)} title="Point this request at a different book">
                  Fix match
                </button>
              )}
              {(isManager || (r.requestedBy === me?.id && r.status === 'pending')) && (
                <button className="btn-secondary" onClick={() => confirm('Remove this request?') && act(() => api(`/api/books/${r.id}`, { method: 'DELETE' }))}>
                  {r.status === 'pending' && !isManager ? 'Cancel' : 'Remove'}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {matching && <BookMatch request={matching} onClose={() => setMatching(null)} onDone={() => qc.invalidateQueries({ queryKey: ['book-requests'] })} />}
    </div>
  );
}

function BookMatch({ request, onClose, onDone }: { request: BookRequest; onClose: () => void; onDone: () => unknown }) {
  const [q, setQ] = useState(`${request.title} ${request.author ?? ''}`.trim());
  const [term, setTerm] = useState(q);
  const [error, setError] = useState('');
  const search = useQuery({ queryKey: ['books-search', term], queryFn: () => api<{ results: BookResult[] }>(`/api/books/search?q=${encodeURIComponent(term)}`), enabled: Boolean(term) });
  const pick = async (workKey: string) => {
    setError('');
    try {
      await api(`/api/books/${request.id}/match`, { body: { workKey } });
      await onDone();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal title={`Fix the match for ${request.title}`} onClose={onClose}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(q);
        }}
      >
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Title or author" />
        <button className="btn-primary">Search</button>
      </form>
      {error && <Alert>{error}</Alert>}
      <ul className="mt-3 max-h-96 space-y-1 overflow-y-auto">
        {search.data?.results
          .filter((b) => b.workKey !== request.workKey)
          .map((b) => (
            <li key={b.workKey}>
              <button className="flex w-full items-center gap-3 rounded p-1.5 text-left hover:bg-surface-2" onClick={() => void pick(b.workKey)}>
                <div className="w-10 shrink-0">
                  <Cover src={cover(b.coverId)} alt="" />
                </div>
                <span className="text-sm">
                  {b.title} {b.year && <span className="text-muted">({b.year})</span>}
                  {b.author && <span className="block text-xs text-muted">{b.author}</span>}
                </span>
              </button>
            </li>
          ))}
        {search.data && !search.data.results.length && <li className="text-sm text-muted">No books found.</li>}
      </ul>
    </Modal>
  );
}

function Podcasts() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const canAdd = hasRole(me, 'manager');
  const [input, setInput] = useState('');
  const [term, setTerm] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const top = useQuery({ queryKey: ['podcasts-top'], queryFn: () => api<Podcast[]>('/api/podcasts/top'), enabled: !term });
  const search = useQuery({ queryKey: ['podcasts-search', term], queryFn: () => api<Podcast[]>(`/api/podcasts/search?q=${encodeURIComponent(term)}`), enabled: Boolean(term) });
  const results = term ? search.data : top.data;
  const failed = (term ? search.error : top.error) as Error | null;
  const add = async (p: Podcast) => {
    setMsg(null);
    try {
      await api('/api/podcasts', { body: { itunesId: p.itunesId } });
      setMsg({ kind: 'success', text: `Subscribed to ${p.title}. Audiobookshelf will download new episodes.` });
      await qc.invalidateQueries({ queryKey: ['podcasts-top'] });
      await qc.invalidateQueries({ queryKey: ['podcasts-search'] });
      await qc.invalidateQueries({ queryKey: ['abs-library'] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="font-semibold">Your podcasts</h2>
        <AbsLibrary type="podcast" />
      </section>
      <section className="space-y-3">
        <form
          className="flex max-w-xl gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setTerm(input.trim());
          }}
        >
          <input className="input" placeholder="Find a podcast" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Search podcasts" />
          <button className="btn-primary">Search</button>
        </form>
        <h2 className="font-semibold">{term ? `Results for “${term}”` : 'Top podcasts'}</h2>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        {failed && <Alert>{failed.message}</Alert>}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-6">
          {results?.map((p) => (
            <div key={p.itunesId} className="space-y-1">
              <div className="aspect-square overflow-hidden rounded border border-border bg-surface-2">{p.artwork && <img src={p.artwork} alt="" loading="lazy" className="h-full w-full object-cover" />}</div>
              <div className="line-clamp-2 text-sm font-medium" title={p.title}>
                {p.title}
              </div>
              <div className="truncate text-xs text-muted">{[p.author, p.genre].filter(Boolean).join(' · ')}</div>
              {p.subscribed ? (
                <span className="text-xs text-success">Subscribed</span>
              ) : (
                canAdd && (
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => add(p)}>
                    Subscribe
                  </button>
                )
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
