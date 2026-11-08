import { desc, eq, inArray } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { albums, downloads, musicArtists } from '../db/schema.js';
import { placeFile } from '../arr/importer.js';
import { CATEGORIES, type Release } from '../arr/indexers.js';
import { grab, searchAll } from '../arr/search.js';
import { refreshMediaServers } from '../arr/tracker.js';
import { MusicBrainzClient, type AlbumCard } from '../integrations/musicbrainz.js';
import { insideRoot } from '../lib/paths.js';
import { notify } from '../notify/service.js';

/**
 * Music, Lidarr-style: albums are found on MusicBrainz, requested like books, downloaded from the
 * indexers' audio categories and imported as Artist/Album (Year)/ into the music folder, where
 * Plex, Jellyfin and Emby pick them up. Followed artists get their new albums by themselves.
 */

export type AlbumRow = typeof albums.$inferSelect;

export const MUSIC_EXT = ['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.alac', '.ape', '.wv'];
/** Kept beside the tracks: covers, cue sheets and logs. */
const EXTRA_EXT = ['.jpg', '.jpeg', '.png', '.cue', '.log'];
/** An album is somewhere between a single short EP in MP3 and a long box set in hi-res FLAC. */
const SIZE = { min: 15 * 1024 * 1024, max: 6 * 1024 * 1024 * 1024 };

export const musicBrainz = (ctx: AppContext) => new MusicBrainzClient(() => ctx.db, `Cinemask/${ctx.config.version} (self-hosted media manager)`);

/** Lowercase words without punctuation or a leading article, for matching names across sources. */
export function norm(t: string): string {
  return t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}

const words = (t: string) => norm(t.replace(/[([].*$/, '')).split(' ').filter((w) => w.length > 1 || /\d/.test(w));

/** A release name names this album: every word of the artist and of the title is in it. */
export function namesAlbum(name: string, album: Pick<AlbumRow, 'title' | 'artist'>): boolean {
  const hay = ` ${norm(name)} `;
  const need = [...words(album.artist), ...words(album.title)];
  return need.length > 0 && need.every((w) => hay.includes(` ${w} `));
}

const LOSSLESS = /\b(flac|alac|lossless|24 ?bit|16 ?bit|hi ?res|ape|wv)\b/i;
const LOSSY = /\b(mp3|320|v0|v2|aac|m4a|ogg|opus|192|256)\b/i;

/** Ranks indexer releases for an album: the right one, sensible size, the preferred format; best first. */
export function rankAlbumReleases(releases: Release[], album: AlbumRow, format: 'any' | 'lossless' | 'lossy'): Release[] {
  return releases
    .filter((r) => namesAlbum(r.title, album) && r.size >= SIZE.min && r.size <= SIZE.max)
    // A discography or a box of several albums isn't the one asked for.
    .filter((r) => !/\b(discography|discografia|anthology|collection|box ?set|complete works)\b/i.test(r.title) || /\b(collection|anthology|box ?set)\b/i.test(album.title))
    .filter((r) => (format === 'lossless' ? !LOSSY.test(r.title) || LOSSLESS.test(r.title) : format === 'lossy' ? !LOSSLESS.test(r.title) || LOSSY.test(r.title) : true))
    .map((r) => {
      let score = 0;
      if (format === 'lossless' && LOSSLESS.test(r.title)) score += 30;
      if (format === 'lossy' && /\b(320|v0)\b/i.test(r.title)) score += 30;
      if (format === 'any' && /\bflac\b/i.test(r.title)) score += 10;
      if (/\bweb\b/i.test(r.title)) score += 5;
      if (/\b(bootleg|live at|karaoke|tribute|cover versions?)\b/i.test(r.title) && !/\blive\b/i.test(album.title)) score -= 40;
      if (r.protocol === 'torrent') score += Math.min(20, r.seeders ?? 0);
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
}

export function getAlbum(ctx: AppContext, id: number): AlbumRow | undefined {
  return ctx.db.select().from(albums).where(eq(albums.id, id)).get();
}

function setAlbum(ctx: AppContext, id: number, values: Partial<AlbumRow>) {
  const before = values.status === 'available' ? getAlbum(ctx, id) : null;
  ctx.db.update(albums).set(values).where(eq(albums.id, id)).run();
  if (before && before.status !== 'available') {
    notify(ctx, { event: 'request.available', title: 'Album ready', message: `${before.artist} – ${before.title} is ready`, data: { kind: 'album', mbid: before.mbid, albumId: id, requestedBy: before.requestedByName }, ...(before.requestedBy ? { to: [before.requestedBy] } : {}) });
  }
}

/** Searches the indexers for an approved album and sends the best release to a download client. */
export async function startAlbumDownload(ctx: AppContext, id: number, userId: number | null = null): Promise<AlbumRow> {
  const album = getAlbum(ctx, id);
  if (!album) throw new Error('Album not found');
  const errors: string[] = [];
  try {
    const q = `${norm(album.artist)} ${norm(album.title.replace(/[([].*$/, ''))}`.trim();
    const { releases, errors: idxErrors } = await searchAll(ctx, { type: 'search', q, categories: CATEGORIES.music });
    errors.push(...idxErrors);
    const best = rankAlbumReleases(releases, album, ctx.settings.get('music').format)[0];
    if (best) {
      const dlId = await grab(ctx, best, null, { userId, quality: LOSSLESS.test(best.title) ? 'lossless' : 'music' });
      ctx.db.update(downloads).set({ albumId: id }).where(eq(downloads.id, dlId)).run();
      setAlbum(ctx, id, { status: 'downloading', error: null });
      return getAlbum(ctx, id)!;
    }
    errors.push('No matching release on your indexers');
  } catch (err) {
    errors.push((err as Error).message);
  }
  setAlbum(ctx, id, { status: 'failed', error: [...new Set(errors)].join('; ').slice(0, 500) });
  return getAlbum(ctx, id)!;
}

/** Audio files (and their covers and cue sheets) under a path, never following links. */
export function findMusicFiles(p: string): { tracks: string[]; extras: string[] } {
  const out = { tracks: [] as string[], extras: [] as string[] };
  if (!fs.existsSync(p)) return out;
  const st = fs.lstatSync(p);
  if (st.isSymbolicLink()) return out;
  const add = (f: string) => {
    const ext = path.extname(f).toLowerCase();
    if (MUSIC_EXT.includes(ext)) out.tracks.push(f);
    else if (EXTRA_EXT.includes(ext)) out.extras.push(f);
  };
  if (st.isFile()) {
    add(p);
    return out;
  }
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else add(full);
    }
  };
  walk(p, 0);
  out.tracks.sort();
  out.extras.sort();
  return out;
}

const clean = (s: string) =>
  s
    .split('')
    .filter((ch) => ch.charCodeAt(0) >= 32 && !'<>:"/\\|?*'.includes(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150);

/** Plex's and Jellyfin's preferred layout: Artist/Album (Year)/tracks. */
export function albumFolder(ctx: AppContext, album: AlbumRow): { root: string; dir: string } {
  const root = ctx.settings.get('media').musicPath;
  const title = clean(`${album.title}${album.year ? ` (${album.year})` : ''}`) || 'Untitled';
  return { root, dir: path.join(root, clean(album.artist) || 'Unknown Artist', title) };
}

/**
 * Puts a finished album into the music folder, keeping its file names and disc folders (track
 * order), with covers and cue sheets. Every destination is checked against the music root.
 */
export function importAlbum(ctx: AppContext, id: number, sourcePath: string): string[] {
  const album = getAlbum(ctx, id);
  if (!album) throw new Error('Album not found');
  const { tracks, extras } = findMusicFiles(sourcePath);
  if (!tracks.length) throw new Error('No audio files in the download');
  const { root, dir } = albumFolder(ctx, album);
  if (!root) throw new Error('Set a music folder in Settings → Media management first');
  const base = fs.statSync(sourcePath).isDirectory() ? sourcePath : path.dirname(sourcePath);
  const mode = ctx.settings.get('media').importMode;
  const placed: string[] = [];
  for (const f of [...tracks, ...extras]) {
    const rel = path.relative(base, f).split(path.sep).map(clean).filter(Boolean).join(path.sep);
    const dest = path.join(dir, rel);
    if (!insideRoot(root, dest)) throw new Error('Refusing to write outside the music folder');
    placeFile(f, dest, mode);
    placed.push(dest);
  }
  setAlbum(ctx, id, { status: 'available', path: dir, error: null });
  void refreshMediaServers(ctx).catch(() => undefined);
  return placed;
}

/** Marks an album download failed (called by the tracker). */
export function failAlbum(ctx: AppContext, id: number, reason: string) {
  setAlbum(ctx, id, { status: 'failed', error: reason.slice(0, 500) });
}

/** Adds an approved album request from MusicBrainz and starts its download. Used for followed artists. */
function requestFromCard(ctx: AppContext, card: AlbumCard, by: string): AlbumRow | null {
  const existing = ctx.db.select().from(albums).where(eq(albums.mbid, card.mbid)).get();
  if (existing) return null;
  return ctx.db
    .insert(albums)
    .values({ mbid: card.mbid, title: card.title.slice(0, 500), artist: card.artist.slice(0, 300), artistMbid: card.artistMbid, year: card.year, type: card.type, status: 'approved', requestedByName: by, decidedByName: by, decidedAt: Date.now(), createdAt: Date.now() })
    .returning()
    .get();
}

/**
 * Looks for new albums by followed artists: studio albums and EPs first released after the
 * artist was followed. Each becomes an approved request and is downloaded. Runs daily.
 */
export async function checkFollowedArtists(ctx: AppContext): Promise<number> {
  if (!ctx.settings.get('music').followNewReleases) return 0;
  const mb = musicBrainz(ctx);
  let added = 0;
  for (const a of ctx.db.select().from(musicArtists).all()) {
    try {
      const since = new Date(a.addedAt).getUTCFullYear();
      const list = await mb.albumsBy({ mbid: a.mbid, name: a.name, disambiguation: null, country: null, type: null }, true);
      for (const card of list) {
        // Only new studio releases: no live albums or compilations, nothing from before following.
        if (card.secondary.length || !card.year || card.year < since) continue;
        const row = requestFromCard(ctx, card, 'Followed artist');
        if (!row) continue;
        added++;
        notify(ctx, { event: 'request.created', title: 'New album', message: `${card.artist} released ${card.title}`, data: { kind: 'album', mbid: card.mbid, albumId: row.id } });
        await startAlbumDownload(ctx, row.id).catch(() => undefined);
      }
      ctx.db.update(musicArtists).set({ checkedAt: Date.now() }).where(eq(musicArtists.id, a.id)).run();
    } catch {
      // MusicBrainz busy or down: try this artist again tomorrow.
    }
  }
  return added;
}

/** MusicBrainz cards with their request state, for search results and artist pages. */
export function annotateAlbums(ctx: AppContext, cards: AlbumCard[]) {
  const ids = cards.map((c) => c.mbid);
  const rows = ids.length ? ctx.db.select().from(albums).where(inArray(albums.mbid, ids)).orderBy(desc(albums.createdAt)).all() : [];
  return cards.map((c) => {
    const r = rows.find((x) => x.mbid === c.mbid);
    return { ...c, request: r ? { id: r.id, status: r.status } : null };
  });
}
