import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Alert } from '../components/ui';

interface Candidate {
  folder: string;
  name: string;
  rootId: string;
  rootName: string;
  suggestion: {
    id: number;
    title: string;
    year: number | null;
    score: number;
  } | null;
}
interface ImportList {
  folders: Candidate[];
  titles: { id: number; title: string; year: number | null }[];
}
interface ImportResult {
  mapped: number;
  files: number;
  results: {
    monitoredId: number;
    folder: string;
    found: number;
    error?: string;
  }[];
}

const label = (t: { title: string; year: number | null }) => (t.year ? `${t.title} (${t.year})` : t.title);

/**
 * Library Import: folders in the media folders that no monitored title uses yet, each with the
 * title it most likely holds. Ticking rows and importing points those titles at the folders and
 * links the files already in them.
 */
export function LibraryImportPage() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'show' | 'movie'>('show');
  const list = useQuery({
    queryKey: ['library-import', kind],
    queryFn: () => api<ImportList>(`/api/files/library-import?kind=${kind}`),
  });
  // What was changed by hand, over the suggestions: folder → title id ('' for none), and ticks.
  const [choiceEdits, setChoiceEdits] = useState<Record<string, string>>({});
  const [tickEdits, setTickEdits] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('');
  const [onlySuggested, setOnlySuggested] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choice = useMemo(() => {
    const c: Record<string, string> = {};
    for (const f of list.data?.folders ?? []) c[f.folder] = choiceEdits[f.folder] ?? (f.suggestion ? String(f.suggestion.id) : '');
    return c;
  }, [list.data, choiceEdits]);
  // Confident matches start ticked.
  const picked = useMemo(() => new Set((list.data?.folders ?? []).filter((f) => choice[f.folder] && (tickEdits[f.folder] ?? Boolean(f.suggestion && f.suggestion.score >= 0.9))).map((f) => f.folder)), [list.data, choice, tickEdits]);

  const rows = useMemo(() => (list.data?.folders ?? []).filter((f) => (!onlySuggested || f.suggestion || choice[f.folder]) && (!filter || f.name.toLowerCase().includes(filter.toLowerCase()))), [list.data, onlySuggested, filter, choice]);
  // A title chosen for two folders is flagged, since only one can win.
  const chosenTwice = useMemo(() => {
    const seen = new Map<string, number>();
    for (const f of picked) if (choice[f]) seen.set(choice[f]!, (seen.get(choice[f]!) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([id]) => id));
  }, [picked, choice]);
  const ready = [...picked].filter((f) => choice[f]);

  const toggle = (folder: string, on: boolean) => setTickEdits((t) => ({ ...t, [folder]: on }));

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api<ImportResult>('/api/files/library-import', {
        body: {
          items: ready.map((folder) => ({
            folder,
            monitoredId: Number(choice[folder]),
          })),
        },
      });
      setResult(r);
      await qc.invalidateQueries({ queryKey: ['library-import'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const titles = list.data?.titles ?? [];
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Library import</h1>
        <p className="text-sm text-muted">
          Folders in your media folders that no monitored {kind === 'show' ? 'show' : 'movie'} uses yet. Pick the title each one holds and import: Cinemask links the files already there. Nothing is moved, renamed or downloaded. To add a title that
          isn't monitored yet, monitor it first, then come back.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as 'show' | 'movie');
            setChoiceEdits({});
            setTickEdits({});
            setResult(null);
          }}
          aria-label="Type"
        >
          <option value="show">TV shows</option>
          <option value="movie">Movies</option>
        </select>
        <input className="input w-56" placeholder="Filter folders" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter folders" />
        <label className="flex items-center gap-1 text-sm text-muted">
          <input type="checkbox" checked={onlySuggested} onChange={(e) => setOnlySuggested(e.target.checked)} />
          Only folders with a match
        </label>
        <button className="btn-primary" disabled={busy || !ready.length} onClick={() => void run()}>
          {busy ? 'Importing…' : `Import ${ready.length} folder${ready.length === 1 ? '' : 's'}`}
        </button>
        <Link className="btn-secondary" to="/monitored">
          Back to Monitored
        </Link>
      </div>
      {error && <Alert>{error}</Alert>}
      {result && (
        <Alert kind={result.results.some((r) => r.error) ? 'error' : 'success'}>
          Mapped {result.mapped} folder{result.mapped === 1 ? '' : 's'} and linked {result.files} file{result.files === 1 ? '' : 's'}.
          {result.results
            .filter((r) => r.error)
            .map((r) => (
              <div key={r.folder} className="text-xs">
                {r.folder}: {r.error}
              </div>
            ))}
        </Alert>
      )}
      {list.isLoading && <p className="text-sm text-muted">Looking through the media folders…</p>}
      {list.isError && <Alert>{(list.error as Error).message}</Alert>}
      {list.data && !list.data.folders.length && <Alert kind="info">Every folder in the media folders already belongs to a title.</Alert>}
      {list.data && list.data.folders.length > 0 && !rows.length && <Alert kind="info">No folders match. Untick "Only folders with a match" to see them all.</Alert>}
      {rows.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr className="border-b border-border">
                <th className="p-2">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={rows.every((r) => picked.has(r.folder))}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setTickEdits((t) => ({ ...t, ...Object.fromEntries(rows.map((r) => [r.folder, on])) }));
                    }}
                  />
                </th>
                <th className="p-2">Folder</th>
                <th className="p-2">Title</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => {
                const id = choice[f.folder] ?? '';
                return (
                  <tr key={f.folder} className="border-b border-border last:border-0">
                    <td className="p-2 align-top">
                      <input type="checkbox" aria-label={`Import ${f.name}`} disabled={!id} checked={picked.has(f.folder)} onChange={(e) => toggle(f.folder, e.target.checked)} />
                    </td>
                    <td className="p-2 align-top">
                      <div className="break-all">{f.name}</div>
                      <div className="text-xs text-muted">{f.rootName}</div>
                    </td>
                    <td className="p-2 align-top">
                      <select
                        className="input w-full min-w-48"
                        value={id}
                        aria-label={`Title for ${f.name}`}
                        onChange={(e) => {
                          setChoiceEdits((c) => ({
                            ...c,
                            [f.folder]: e.target.value,
                          }));
                          toggle(f.folder, Boolean(e.target.value));
                        }}
                      >
                        <option value="">Not a monitored title</option>
                        {f.suggestion && !titles.some((t) => t.id === f.suggestion!.id) && <option value={f.suggestion.id}>{label(f.suggestion)}</option>}
                        {titles.map((t) => (
                          <option key={t.id} value={t.id}>
                            {label(t)}
                          </option>
                        ))}
                      </select>
                      {f.suggestion && String(f.suggestion.id) === id && (
                        <div className="mt-0.5 text-xs text-muted">
                          Suggested
                          {f.suggestion.score < 0.9 ? ', check it' : ''}
                        </div>
                      )}
                      {id && picked.has(f.folder) && chosenTwice.has(id) && <div className="mt-0.5 text-xs text-warning">Also picked for another folder</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
