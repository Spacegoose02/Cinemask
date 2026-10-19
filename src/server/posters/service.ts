import { and, eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { libraryItems, media, type MediaKind } from '../db/schema.js';
import { jellyfinClient, plexClient, pushablePosterUrl } from '../collections/service.js';
import { TMDB_IMAGE } from '../integrations/tmdb.js';
import { tmdbClient } from '../library/service.js';
import { randomToken } from '../security/crypto.js';

export interface PosterOption {
  source: 'tmdb' | 'theposterdb';
  /** What gets saved: a TMDB path or an https URL. */
  value: string;
  preview: string;
  width?: number;
  height?: number;
  language?: string | null;
  votes?: number;
}

const IMAGE_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

/** Works out an uploaded image's type from its bytes, never from what the browser claims. */
export function sniffImage(data: Buffer): string | null {
  return Object.entries(IMAGE_TYPES).find(([, t]) => t.magic(data))?.[0] ?? null;
}

export const postersDir = (ctx: AppContext) => path.join(ctx.config.configDir, 'posters');

/**
 * Best-effort ThePosterDB search. It has no public API, so this reads the search page and
 * collects poster asset links; if the site changes, it returns nothing rather than failing.
 */
export async function searchThePosterDb(title: string, year: number | null, kind: MediaKind): Promise<PosterOption[]> {
  const term = encodeURIComponent(year ? `${title} ${year}` : title);
  try {
    const res = await fetch(`https://theposterdb.com/search?term=${term}&section=${kind === 'movie' ? 'movies' : 'shows'}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (cinemask)', Accept: 'text/html' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const ids = [...new Set([...html.matchAll(/https:\/\/theposterdb\.com\/api\/assets\/(\d+)/g)].map((m) => m[1]!))].slice(0, 30);
    return ids.map((id) => ({ source: 'theposterdb', value: `https://theposterdb.com/api/assets/${id}`, preview: `https://theposterdb.com/api/assets/${id}` }));
  } catch {
    return [];
  }
}

export async function posterOptions(ctx: AppContext, kind: MediaKind, tmdbId: number): Promise<PosterOption[]> {
  const tmdb = tmdbClient(ctx);
  const out: PosterOption[] = [];
  if (tmdb.configured) {
    const imgs = await tmdb.images(kind === 'movie' ? 'movie' : 'tv', tmdbId);
    out.push(
      ...imgs.posters
        .sort((a, b) => b.vote_average * Math.log1p(b.vote_count) - a.vote_average * Math.log1p(a.vote_count))
        .slice(0, 40)
        .map((p) => ({ source: 'tmdb' as const, value: p.file_path, preview: `${TMDB_IMAGE}/w342${p.file_path}`, width: p.width, height: p.height, language: p.iso_639_1, votes: p.vote_count })),
    );
  }
  if (ctx.settings.get('extras').thePosterDb) {
    const m = ctx.db.select().from(media).where(and(eq(media.kind, kind), eq(media.tmdbId, tmdbId))).get();
    if (m) out.push(...(await searchThePosterDb(m.title, m.year, kind)));
  }
  return out;
}

export interface ApplyResult {
  servers: { server: string; ok: boolean; error?: string }[];
}

/**
 * Sets a title's poster in the app and on every connected server that has it. The value is a
 * TMDB path or https URL; an upload is saved under /config/posters and pushed as bytes.
 */
export async function applyPoster(ctx: AppContext, kind: MediaKind, tmdbId: number, input: { value: string } | { data: Buffer }): Promise<ApplyResult> {
  const rows = ctx.db.select().from(libraryItems).where(and(eq(libraryItems.kind, kind), eq(libraryItems.tmdbId, tmdbId))).all();
  let override: string;
  let upload: { data: Buffer; type: string } | null = null;
  if ('data' in input) {
    const type = sniffImage(input.data);
    if (!type) throw new Error('Upload a JPEG, PNG or WebP image');
    const dir = postersDir(ctx);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${kind}-${tmdbId}-${randomToken(6)}.${IMAGE_TYPES[type]!.ext}`;
    fs.writeFileSync(path.join(dir, name), input.data);
    override = `local:${name}`;
    upload = { data: input.data, type };
  } else {
    override = input.value;
  }
  const url = upload ? null : pushablePosterUrl(override);
  const result: ApplyResult = { servers: [] };
  const plex = plexClient(ctx);
  const jf = jellyfinClient(ctx);
  for (const r of rows) {
    try {
      if (r.server === 'plex' && plex) {
        if (upload) await plex.uploadPoster(r.externalKey, upload.data, upload.type);
        else if (url) await plex.setPosterUrl(r.externalKey, url);
      } else if (r.server === 'jellyfin' && jf) {
        if (upload) await jf.uploadPoster(r.externalKey, upload.data, upload.type);
        else if (url) await jf.setPosterUrl(r.externalKey, url);
      } else continue;
      result.servers.push({ server: r.server, ok: true });
    } catch (err) {
      result.servers.push({ server: r.server, ok: false, error: (err as Error).message });
    }
  }
  const existing = ctx.db.select().from(media).where(and(eq(media.kind, kind), eq(media.tmdbId, tmdbId))).get();
  if (existing) {
    removeLocal(ctx, existing.posterOverride);
    ctx.db.update(media).set({ posterOverride: override }).where(eq(media.id, existing.id)).run();
  }
  return result;
}

function removeLocal(ctx: AppContext, override: string | null) {
  if (!override?.startsWith('local:')) return;
  const file = path.join(postersDir(ctx), path.basename(override.slice(6)));
  fs.rmSync(file, { force: true });
}

/** Goes back to TMDB's default poster in the app. Servers keep whatever poster they have. */
export function resetPoster(ctx: AppContext, kind: MediaKind, tmdbId: number) {
  const existing = ctx.db.select().from(media).where(and(eq(media.kind, kind), eq(media.tmdbId, tmdbId))).get();
  if (!existing) return;
  removeLocal(ctx, existing.posterOverride);
  ctx.db.update(media).set({ posterOverride: null }).where(eq(media.id, existing.id)).run();
}
