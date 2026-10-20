import type { AppContext } from '../context.js';
import type { MediaKind } from '../db/schema.js';

/**
 * Root folders: the main Movies and TV folders (id "default") plus any extra ones from
 * Settings → Media management, such as Kids Movies or 4K. Each monitored title picks one.
 */
export interface RootFolder {
  id: string;
  name: string;
  kind: MediaKind;
  path: string;
  /** Download-client category; empty means the client's own. */
  category: string;
}

export function listRoots(ctx: AppContext, kind?: MediaKind): RootFolder[] {
  const m = ctx.settings.get('media');
  const all: RootFolder[] = [
    { id: 'default', name: 'Movies', kind: 'movie', path: m.moviesPath, category: m.moviesCategory },
    { id: 'default', name: 'TV', kind: 'show', path: m.tvPath, category: m.tvCategory },
    ...m.extraFolders,
  ];
  return kind ? all.filter((r) => r.kind === kind) : all;
}

/** The root folder a title uses. A folder removed from settings falls back to the default. */
export function rootOf(ctx: AppContext, row: { kind: MediaKind; rootId?: string | null }): RootFolder {
  const roots = listRoots(ctx, row.kind);
  return roots.find((r) => r.id === (row.rootId ?? 'default')) ?? roots[0]!;
}

/** Throws for an id that isn't a root folder of this kind. */
export function assertRoot(ctx: AppContext, kind: MediaKind, id: string | null | undefined) {
  if (id && id !== 'default' && !listRoots(ctx, kind).some((r) => r.id === id)) throw new Error('Unknown root folder');
}

/**
 * Where a link download can be delivered: the downloads folder (left as is), any root folder,
 * or the audiobooks and books folders. Keys look like "downloads", "movie:kids" or "books".
 */
export function linkDestinations(ctx: AppContext): { key: string; name: string; path: string }[] {
  const m = ctx.settings.get('media');
  return [
    { key: 'downloads', name: 'Downloads folder (leave it there)', path: m.downloadsPath },
    ...listRoots(ctx).map((r) => ({ key: `${r.kind}:${r.id}`, name: r.name, path: r.path })),
    { key: 'audiobooks', name: 'Audiobooks', path: m.audiobooksPath },
    { key: 'books', name: 'Books', path: m.booksPath },
  ];
}
