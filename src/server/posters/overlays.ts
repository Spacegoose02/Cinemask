import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { AppContext } from '../context.js';
import { libraryItems, media, posterOverlays, type ServerType } from '../db/schema.js';
import { bingeBanditClient, jellyfinClient, plexClient } from '../collections/service.js';
import { EmbyClient } from '../integrations/emby.js';
import { TMDB_IMAGE } from '../integrations/tmdb.js';
import { postersDir } from './service.js';

/**
 * Poster overlays: badges (4K, the TMDB score, "New", a show's status, the age rating) drawn on
 * each title's clean poster and uploaded to the media servers, like Kometa does. The clean poster
 * is always the one Cinemask knows (chosen in the app, or TMDB's), never the server's current
 * one, so badges never stack. Each server item remembers a hash of what it got, so only titles
 * whose badges or poster changed are redrawn.
 */

const WIDTH = 1000;
const HEIGHT = 1500;
/** Bump to redraw everything after changing how badges look. */
const STYLE = 1;
const MAX_IMAGE = 15 * 1024 * 1024;
/** Hosts a chosen poster link may be fetched from. Anything else falls back to TMDB's poster. */
const POSTER_HOSTS = new Set(['image.tmdb.org', 'theposterdb.com']);

export interface Badges {
  resolution?: string;
  rating?: string;
  isNew?: string;
  status?: string;
  certification?: string;
}

type Row = { server: ServerType; externalKey: string; kind: 'movie' | 'show'; resolution: string | null; addedAt: number | null; media: typeof media.$inferSelect };

const RESOLUTION_LABEL: Record<string, string> = { '2160p': '4K', '1080p': '1080p', '720p': '720p', SD: 'SD' };
const STATUS_LABEL: Record<string, string> = { 'Returning Series': 'Returning', Ended: 'Ended', Canceled: 'Canceled', 'In Production': 'Coming soon' };

/** The badges a server item gets with the current settings. */
export function badgesFor(ctx: AppContext, row: Pick<Row, 'kind' | 'resolution' | 'addedAt' | 'media'>, now = Date.now()): Badges {
  const s = ctx.settings.get('overlays');
  const b: Badges = {};
  if (s.resolution && row.resolution && RESOLUTION_LABEL[row.resolution]) b.resolution = RESOLUTION_LABEL[row.resolution];
  if (s.rating && row.media.rating) b.rating = row.media.rating.toFixed(1);
  if (s.newDays > 0 && row.addedAt && now - row.addedAt < s.newDays * 86_400_000) b.isNew = row.kind === 'show' ? 'New episodes' : 'New';
  if (s.showStatus && row.kind === 'show' && row.media.tmdbStatus && STATUS_LABEL[row.media.tmdbStatus]) b.status = STATUS_LABEL[row.media.tmdbStatus];
  if (s.certification && row.media.certification) b.certification = row.media.certification;
  return b;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const FONT = `font-family="DejaVu Sans, Inter, Helvetica, Arial, sans-serif" font-weight="bold"`;

/** A rounded label; text width is estimated, which is close enough for short labels. */
function pill(x: number, y: number, text: string, opts: { align?: 'left' | 'right'; fill?: string; size?: number } = {}) {
  const size = opts.size ?? 54;
  const w = Math.round(text.length * size * 0.66 + size * 0.9);
  const h = Math.round(size * 1.5);
  const left = opts.align === 'right' ? x - w : x;
  return `<rect x="${left}" y="${y}" width="${w}" height="${h}" rx="${Math.round(h / 4)}" fill="${opts.fill ?? 'rgba(0,0,0,0.72)'}"/>
<text x="${left + w / 2}" y="${y + h / 2}" dy="0.35em" text-anchor="middle" font-size="${size}" fill="#fff" ${FONT}>${esc(text)}</text>`;
}

export function overlaySvg(b: Badges): string {
  const parts: string[] = [];
  if (b.resolution) parts.push(pill(36, 36, b.resolution, { fill: b.resolution === '4K' ? 'rgba(180,120,0,0.9)' : undefined }));
  if (b.rating) parts.push(pill(WIDTH - 36, 36, `★ ${b.rating}`, { align: 'right' }));
  let bottom = HEIGHT - 36;
  if (b.isNew) {
    parts.push(`<rect x="0" y="${HEIGHT - 130}" width="${WIDTH}" height="130" fill="rgba(200,30,60,0.9)"/>
<text x="${WIDTH / 2}" y="${HEIGHT - 65}" dy="0.35em" text-anchor="middle" font-size="64" fill="#fff" letter-spacing="4" ${FONT}>${esc(b.isNew.toUpperCase())}</text>`);
    bottom = HEIGHT - 130 - 30;
  }
  if (b.status) parts.push(pill(36, bottom - 72, b.status, { size: 46 }));
  if (b.certification) parts.push(pill(WIDTH - 36, bottom - 72, b.certification, { align: 'right', size: 46 }));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${parts.join('\n')}</svg>`;
}

/** Where the clean poster comes from: chosen in the app (uploaded or linked), else TMDB's. Null when there is none. */
export function posterSource(ctx: AppContext, m: typeof media.$inferSelect): string | null {
  const o = m.posterOverride;
  if (o?.startsWith('local:') && fs.existsSync(path.join(postersDir(ctx), path.basename(o.slice(6))))) return o;
  if (o?.startsWith('/')) return `${TMDB_IMAGE}/original${o}`;
  if (o?.startsWith('https://') && URL.canParse(o) && POSTER_HOSTS.has(new URL(o).hostname)) return o;
  if (m.posterPath) return `${TMDB_IMAGE}/w780${m.posterPath}`;
  return null;
}

export async function loadPoster(ctx: AppContext, source: string): Promise<Buffer> {
  if (source.startsWith('local:')) return fs.readFileSync(path.join(postersDir(ctx), path.basename(source.slice(6))));
  const res = await fetch(source, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!res.ok) throw new Error(`Poster download failed (HTTP ${res.status})`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE) throw new Error('Poster is too large');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_IMAGE) throw new Error('Poster is too large');
  return data;
}

/** Draws the badges on a poster, as a JPEG the servers take. With no badges it's just the clean poster, resized. */
export async function render(poster: Buffer, b: Badges): Promise<Buffer> {
  const img = sharp(poster, { limitInputPixels: 50_000_000 }).resize(WIDTH, HEIGHT, { fit: 'cover' });
  const hasBadges = Object.keys(b).length > 0;
  return (hasBadges ? img.composite([{ input: Buffer.from(overlaySvg(b)) }]) : img).jpeg({ quality: 88 }).toBuffer();
}

const hashOf = (source: string, b: Badges) => crypto.createHash('sha256').update(JSON.stringify({ STYLE, source, b })).digest('hex').slice(0, 32);

interface Uploader {
  uploadPoster(id: string, data: Buffer, contentType: string): Promise<void>;
}

function uploaders(ctx: AppContext): Partial<Record<ServerType, Uploader>> {
  const em = ctx.settings.get('emby');
  return {
    plex: plexClient(ctx) ?? undefined,
    jellyfin: jellyfinClient(ctx) ?? undefined,
    emby: em.enabled && em.url && em.apiKey ? new EmbyClient(em.url, em.apiKey) : undefined,
    bingebandit: bingeBanditClient(ctx) ?? undefined,
  };
}

function rows(ctx: AppContext, where?: { kind: 'movie' | 'show'; tmdbId: number }): Row[] {
  return ctx.db
    .select({ server: libraryItems.server, externalKey: libraryItems.externalKey, kind: libraryItems.kind, resolution: libraryItems.resolution, addedAt: libraryItems.addedAt, media })
    .from(libraryItems)
    .innerJoin(media, and(eq(media.kind, libraryItems.kind), eq(media.tmdbId, libraryItems.tmdbId)))
    .where(where ? and(eq(libraryItems.kind, where.kind), eq(libraryItems.tmdbId, where.tmdbId)) : undefined)
    .all();
}

export interface OverlayRun {
  at: number;
  updated: number;
  unchanged: number;
  failed: number;
  errors: string[];
}

const lastRuns = new WeakMap<AppContext, OverlayRun>();
export const lastOverlayRun = (ctx: AppContext) => lastRuns.get(ctx) ?? null;

/** Puts current badges on every title on the servers that needs them. Does nothing while overlays are off. */
export async function applyOverlays(ctx: AppContext, only?: { kind: 'movie' | 'show'; tmdbId: number }): Promise<OverlayRun | null> {
  if (!ctx.settings.get('overlays').enabled) return null;
  return drawAll(ctx, rows(ctx, only), false);
}

/** Puts the clean poster back on every title that has badges, and forgets them. */
export async function removeOverlays(ctx: AppContext): Promise<OverlayRun> {
  const done = ctx.db.select().from(posterOverlays).all();
  const keys = new Set(done.map((r) => `${r.server}:${r.externalKey}`));
  const all = rows(ctx);
  const run = await drawAll(ctx, all.filter((r) => keys.has(`${r.server}:${r.externalKey}`)), true);
  // Items no longer on a server can't be restored; forget them too.
  const present = new Set(all.map((r) => `${r.server}:${r.externalKey}`));
  for (const r of done) {
    if (!present.has(`${r.server}:${r.externalKey}`)) ctx.db.delete(posterOverlays).where(and(eq(posterOverlays.server, r.server), eq(posterOverlays.externalKey, r.externalKey))).run();
  }
  return run;
}

const busy = new WeakSet<AppContext>();
export const overlaysRunning = (ctx: AppContext) => busy.has(ctx);

async function drawAll(ctx: AppContext, items: Row[], clean: boolean): Promise<OverlayRun> {
  if (busy.has(ctx)) throw new Error('Overlays are already being updated');
  busy.add(ctx);
  try {
    return await draw(ctx, items, clean);
  } finally {
    busy.delete(ctx);
  }
}

async function draw(ctx: AppContext, items: Row[], clean: boolean): Promise<OverlayRun> {
  const run: OverlayRun = { at: Date.now(), updated: 0, unchanged: 0, failed: 0, errors: [] };
  const clients = uploaders(ctx);
  const state = new Map(ctx.db.select().from(posterOverlays).all().map((r) => [`${r.server}:${r.externalKey}`, r.hash]));
  const posters = new Map<string, Promise<Buffer>>();
  const images = new Map<string, Promise<Buffer>>();
  for (const r of items) {
    const client = clients[r.server];
    if (!client) continue;
    const key = `${r.server}:${r.externalKey}`;
    try {
      const b = clean ? {} : badgesFor(ctx, r, run.at);
      // Titles that never had badges and still have none are left alone.
      if (!clean && !Object.keys(b).length && !state.has(key)) {
        run.unchanged++;
        continue;
      }
      const source = posterSource(ctx, r.media);
      if (!source) {
        run.unchanged++;
        continue;
      }
      const hash = hashOf(source, b);
      if (!clean && state.get(key) === hash) {
        run.unchanged++;
        continue;
      }
      if (!posters.has(source)) posters.set(source, loadPoster(ctx, source));
      const data = await posters.get(source)!;
      if (!images.has(hash)) images.set(hash, render(data, b));
      await client.uploadPoster(r.externalKey, await images.get(hash)!, 'image/jpeg');
      if (clean || !Object.keys(b).length) {
        ctx.db.delete(posterOverlays).where(and(eq(posterOverlays.server, r.server), eq(posterOverlays.externalKey, r.externalKey))).run();
      } else {
        ctx.db
          .insert(posterOverlays)
          .values({ server: r.server, externalKey: r.externalKey, hash, appliedAt: run.at })
          .onConflictDoUpdate({ target: [posterOverlays.server, posterOverlays.externalKey], set: { hash, appliedAt: run.at } })
          .run();
      }
      run.updated++;
    } catch (err) {
      run.failed++;
      if (run.errors.length < 5) run.errors.push(`${r.media.title} (${r.server}): ${(err as Error).message}`);
    }
  }
  lastRuns.set(ctx, run);
  return run;
}

/** A preview of a title's poster with the current settings, without touching any server. */
export async function previewOverlay(ctx: AppContext, kind: 'movie' | 'show', tmdbId: number): Promise<Buffer | null> {
  const r = rows(ctx, { kind, tmdbId })[0];
  const m = r?.media ?? ctx.db.select().from(media).where(and(eq(media.kind, kind), eq(media.tmdbId, tmdbId))).get();
  if (!m) return null;
  const source = posterSource(ctx, m);
  if (!source) return null;
  return render(await loadPoster(ctx, source), badgesFor(ctx, r ?? { kind, resolution: null, addedAt: null, media: m }));
}

export function overlayCount(ctx: AppContext): number {
  return ctx.db.select({ n: sql<number>`count(*)` }).from(posterOverlays).get()?.n ?? 0;
}

/** A title to preview with: the newest one on a server that has a poster. */
export function overlaySample(ctx: AppContext): { kind: 'movie' | 'show'; tmdbId: number; title: string } | null {
  const r = ctx.db
    .select({ kind: media.kind, tmdbId: media.tmdbId, title: media.title })
    .from(libraryItems)
    .innerJoin(media, and(eq(media.kind, libraryItems.kind), eq(media.tmdbId, libraryItems.tmdbId)))
    .where(isNotNull(media.posterPath))
    .orderBy(desc(libraryItems.addedAt))
    .get();
  return r ?? null;
}
