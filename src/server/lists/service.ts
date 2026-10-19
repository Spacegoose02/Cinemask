import { and, asc, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { listItems, lists, monitored, type ListSource, type MediaKind } from '../db/schema.js';
import { discoverFilter, discoverParams } from '../discover/service.js';
import { mdblistClient, availabilityFor, tmdbClient } from '../library/service.js';
import type { MdblistItem } from '../integrations/mdblist.js';
import type { TmdbSearchResult } from '../integrations/tmdb.js';
import { monitorTitle } from '../arr/monitor.js';
import { defaultProfileId, getProfile } from '../arr/profiles.js';
import { autoSearch } from '../arr/search.js';

export interface ListItem {
  kind: MediaKind;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

export type ListRow = typeof lists.$inferSelect;

const MAX_ITEMS = 1000;
/** New titles a single sync may start downloading, so a huge list can't flood the download client. */
const MAX_AUTO_ADD = 25;

/** Works out the source and settings from a pasted list URL. */
export function parseListUrl(url: string): { source: ListSource; config: Record<string, unknown> } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (/(^|\.)mdblist\.com$/.test(u.hostname) && parts[0] === 'lists' && parts.length >= 3) return { source: 'mdblist', config: { user: parts[1], slug: parts[2] } };
  if (/(^|\.)themoviedb\.org$/.test(u.hostname) && parts[0] === 'list' && parts[1]) {
    const id = Number.parseInt(parts[1], 10);
    if (id > 0) return { source: 'tmdb_list', config: { id } };
  }
  return null;
}

const fromTmdb = (r: TmdbSearchResult, kind?: MediaKind): ListItem | null => {
  const k = kind ?? (r.media_type === 'movie' ? 'movie' : r.media_type === 'tv' ? 'show' : null);
  if (!k) return null;
  const date = r.release_date ?? r.first_air_date ?? '';
  return { kind: k, tmdbId: r.id, title: r.title ?? r.name ?? '', year: date ? Number(date.slice(0, 4)) : null, posterPath: r.poster_path ?? null };
};

/** Fetches a list's current items from its source. */
export async function fetchItems(ctx: AppContext, list: Pick<ListRow, 'source' | 'config' | 'kind'>): Promise<ListItem[]> {
  const cfg = JSON.parse(list.config) as Record<string, unknown>;
  const tmdb = tmdbClient(ctx);
  let items: ListItem[] = [];
  switch (list.source) {
    case 'mdblist': {
      const md = mdblistClient(ctx);
      if (!md.configured) throw new Error('Add an mdblist API key in Settings → Metadata');
      const r = await md.listItems(String(cfg.user), String(cfg.slug));
      const all: MdblistItem[] = Array.isArray(r) ? r : [...(r.movies ?? []), ...(r.shows ?? [])];
      items = all
        .map((i): ListItem | null => {
          const tmdbId = i.ids?.tmdb ?? (i as unknown as { tmdb_id?: number }).tmdb_id;
          return tmdbId ? { kind: i.mediatype === 'movie' ? ('movie' as const) : ('show' as const), tmdbId, title: i.title, year: i.release_year ?? null, posterPath: null } : null;
        })
        .filter((i) => i !== null);
      break;
    }
    case 'tmdb_list': {
      const first = await tmdb.list(Number(cfg.id));
      const pages = Math.min(first.total_pages ?? 1, 10);
      const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => tmdb.list(Number(cfg.id), i + 2)));
      items = [first, ...rest].flatMap((p) => p.items.map((r) => fromTmdb(r)).filter((i): i is ListItem => i !== null));
      break;
    }
    case 'tmdb_discover': {
      const f = discoverFilter.parse(cfg.filter ?? {});
      const pages = Math.min(Math.max(Number(cfg.pages) || 1, 1), 5);
      const kind = f.kind === 'movie' ? 'movie' : 'show';
      const results = await Promise.all(Array.from({ length: pages }, (_, i) => tmdb.discover(f.kind, { ...discoverParams(ctx, f), page: i + 1 })));
      items = results.flatMap((r) => r.results.map((x) => fromTmdb(x, kind)).filter((i): i is ListItem => i !== null));
      break;
    }
    case 'csv':
      throw new Error('CSV lists are imported from a file and have nothing to fetch');
  }
  const seen = new Set<string>();
  return items
    .filter((i) => (!list.kind || i.kind === list.kind) && !seen.has(`${i.kind}:${i.tmdbId}`) && seen.add(`${i.kind}:${i.tmdbId}`))
    .slice(0, MAX_ITEMS);
}

export function replaceItems(ctx: AppContext, listId: number, items: ListItem[]) {
  ctx.db.transaction((tx) => {
    tx.delete(listItems).where(eq(listItems.listId, listId)).run();
    items.forEach((i, position) => tx.insert(listItems).values({ listId, ...i, position }).onConflictDoNothing().run());
    tx.update(lists).set({ itemCount: items.length }).where(eq(lists.id, listId)).run();
  });
}

/**
 * Refreshes a list from its source. Lists with auto-add on start monitoring (and optionally
 * searching for) items that aren't on the server or already monitored.
 */
export async function syncList(ctx: AppContext, listId: number): Promise<{ items: number; added: number }> {
  const list = ctx.db.select().from(lists).where(eq(lists.id, listId)).get();
  if (!list) throw new Error('List not found');
  try {
    // CSV lists were imported from a file; their items only change on re-import.
    const items = list.source === 'csv' ? ctx.db.select().from(listItems).where(eq(listItems.listId, listId)).orderBy(asc(listItems.position)).all() : await fetchItems(ctx, list);
    if (list.source !== 'csv') replaceItems(ctx, listId, items);
    let added = 0;
    if (list.autoAdd) {
      for (const kind of ['movie', 'show'] as const) {
        const ofKind = items.filter((i) => i.kind === kind);
        const avail = availabilityFor(ctx, kind, ofKind);
        for (const i of ofKind) {
          if (added >= MAX_AUTO_ADD) break;
          if (avail.get(i.tmdbId)?.status === 'on_server') continue;
          if (ctx.db.select({ id: monitored.id }).from(monitored).where(and(eq(monitored.kind, kind), eq(monitored.tmdbId, i.tmdbId))).get()) continue;
          const profileId = list.profileId && getProfile(ctx, list.profileId) ? list.profileId : defaultProfileId(ctx, kind);
          const row = await monitorTitle(ctx, { kind, tmdbId: i.tmdbId, profileId, seasons: null, addedBy: list.createdBy });
          added++;
          if (list.searchOnAdd) void autoSearch(ctx, row).catch(() => 0);
        }
      }
    }
    ctx.db.update(lists).set({ lastSyncAt: Date.now(), lastError: null }).where(eq(lists.id, listId)).run();
    return { items: items.length, added };
  } catch (err) {
    ctx.db.update(lists).set({ lastSyncAt: Date.now(), lastError: (err as Error).message }).where(eq(lists.id, listId)).run();
    throw err;
  }
}

/** Syncs every list whose interval has passed. Run hourly. */
export async function syncDueLists(ctx: AppContext): Promise<void> {
  for (const l of ctx.db.select().from(lists).all()) {
    if (l.source === 'csv' && !l.autoAdd) continue;
    if (l.lastSyncAt && Date.now() - l.lastSyncAt < l.syncHours * 60 * 60 * 1000) continue;
    await syncList(ctx, l.id).catch(() => undefined);
  }
}

// ---------------- CSV import (Yamtrack, IMDb, Letterboxd, or any sheet with TMDB ids) ----------------

/** Minimal RFC 4180 CSV parser: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const kindFrom = (v: string | undefined): MediaKind | null => {
  const t = (v ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (['movie', 'film', 'tvmovie', 'video'].includes(t)) return 'movie';
  if (['tv', 'show', 'series', 'tvseries', 'tvminiseries', 'season', 'episode', 'anime'].includes(t)) return 'show';
  return null;
};

/**
 * Turns an exported CSV into list items. Understands Yamtrack exports (media_id + source + media_type),
 * IMDb list exports (Const + Title Type), Letterboxd exports (Name + Year) and plain tmdb_id columns.
 * Rows without a TMDB id are looked up by IMDb id, then by title and year.
 */
export async function itemsFromCsv(ctx: AppContext, text: string, fallbackKind: MediaKind | null): Promise<{ items: ListItem[]; skipped: number }> {
  const rows = parseCsv(text.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw new Error('The file has no rows');
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const cTmdb = col('tmdb_id', 'tmdb', 'tmdbid');
  const cMediaId = col('media_id');
  const cSource = col('source');
  const cImdb = col('imdb_id', 'imdb', 'const', 'imdbid');
  const cType = col('media_type', 'type', 'kind', 'title type', 'mediatype');
  const cTitle = col('title', 'name');
  const cYear = col('year', 'release_year');
  if (cTmdb < 0 && cMediaId < 0 && cImdb < 0 && cTitle < 0) throw new Error('Could not find a TMDB id, IMDb id or title column');
  const tmdb = tmdbClient(ctx);
  const out: ListItem[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const r of rows.slice(1, MAX_ITEMS + 1)) {
    const cell = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    let kind = kindFrom(cell(cType)) ?? fallbackKind;
    const title = cell(cTitle);
    const year = Number.parseInt(cell(cYear), 10) || null;
    let tmdbId = Number.parseInt(cell(cTmdb), 10) || null;
    if (!tmdbId && cMediaId >= 0 && (cSource < 0 || cell(cSource).toLowerCase() === 'tmdb')) tmdbId = Number.parseInt(cell(cMediaId), 10) || null;
    let posterPath: string | null = null;
    try {
      if (!tmdbId && /^tt\d+$/.test(cell(cImdb)) && tmdb.configured) {
        const f = await tmdb.findByExternal(cell(cImdb), 'imdb_id');
        const hit = f.movie_results[0] ?? f.tv_results[0];
        if (hit) {
          tmdbId = hit.id;
          kind = f.movie_results[0] ? 'movie' : 'show';
          posterPath = hit.poster_path ?? null;
        }
      }
      if (!tmdbId && title && tmdb.configured) {
        const k = kind ?? 'movie';
        const hit = (await tmdb.searchKind(k === 'movie' ? 'movie' : 'tv', title, year)).results[0];
        if (hit) {
          tmdbId = hit.id;
          kind = k;
          posterPath = hit.poster_path ?? null;
        }
      }
    } catch {
      // lookup failed: counted as skipped below
    }
    if (!tmdbId || !kind || seen.has(`${kind}:${tmdbId}`)) {
      if (!tmdbId || !kind) skipped++;
      continue;
    }
    seen.add(`${kind}:${tmdbId}`);
    out.push({ kind, tmdbId, title: title || `TMDB ${tmdbId}`, year, posterPath });
  }
  return { items: out, skipped };
}
