import { and, eq, isNull } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { libraryEpisodes, libraryItems, media, monitored, monitoredEpisodes, monitorExclusions, type MediaKind } from '../db/schema.js';
import { bestResolution } from '../integrations/http.js';
import { refreshMetadata, tmdbClient } from '../library/service.js';
import type { Target } from './decision.js';
import { belowCutoff, defaultProfileId, searchProfile } from './profiles.js';
import { qualityFor } from './quality.js';
import { assertRoot } from './roots.js';
import { localDay } from '../lib/dates.js';

export type MonitoredRow = typeof monitored.$inferSelect;

/** Narrows a search to a season or an episode, or to what has no file at all (no upgrades). */
export interface SearchFilter {
  season?: number;
  episode?: number;
  missingOnly?: boolean;
  /** Look for a different copy of what's there, as if it had no file (fixing a problem report). */
  replace?: boolean;
}

const today = () => localDay();

/** Starts watching a title (or updates how it's watched). Shows get their episode list from TMDB. */
export async function monitorTitle(
  ctx: AppContext,
  input: { kind: MediaKind; tmdbId: number; profileId: number; seasons?: number[] | null; addedBy?: number | null; rootId?: string | null; maxSizeMb?: number | null },
): Promise<MonitoredRow> {
  const meta = await refreshMetadata(ctx, input.kind, input.tmdbId);
  if (!meta) throw new Error('Could not look up this title. Check the TMDB key in Settings → Metadata.');
  const existing = ctx.db.select().from(monitored).where(and(eq(monitored.kind, input.kind), eq(monitored.tmdbId, input.tmdbId))).get();
  const seasons = input.seasons === undefined ? existing?.seasons ?? null : input.seasons ? JSON.stringify([...new Set(input.seasons)].sort((a, b) => a - b)) : null;
  assertRoot(ctx, input.kind, input.rootId);
  const rootId = input.rootId && input.rootId !== 'default' ? input.rootId : null;
  // A title already on disk keeps its folder; moving it is a separate step (files/service moveToRoot).
  const extra = {
    ...(input.rootId !== undefined && !existing?.path ? { rootId } : {}),
    ...(input.maxSizeMb !== undefined ? { maxSizeMb: input.maxSizeMb } : {}),
  };
  // Monitoring something by hand again undoes an earlier removal.
  ctx.db.delete(monitorExclusions).where(and(eq(monitorExclusions.kind, input.kind), eq(monitorExclusions.tmdbId, input.tmdbId))).run();
  const row = existing
    ? ctx.db.update(monitored).set({ profileId: input.profileId, monitored: true, seasons, ...extra }).where(eq(monitored.id, existing.id)).returning().get()
    : ctx.db
        .insert(monitored)
        .values({ kind: input.kind, tmdbId: input.tmdbId, title: meta.title, year: meta.year, profileId: input.profileId, seasons, addedBy: input.addedBy ?? null, addedAt: Date.now(), ...extra })
        .returning()
        .get();
  if (row.kind === 'show') {
    const show = await refreshEpisodes(ctx, row, true);
    // Japanese animation is usually released with absolute numbers.
    if (!existing && show && looksLikeAnime(show)) {
      ctx.db.update(monitored).set({ seriesType: 'anime' }).where(eq(monitored.id, row.id)).run();
      return { ...row, seriesType: 'anime' };
    }
  }
  return row;
}

/**
 * Syncs a monitored show's episode list (titles, air dates) from TMDB. New episodes follow the
 * season choice; existing ones keep their own monitored flag unless resetMonitored is set.
 */
export async function refreshEpisodes(ctx: AppContext, row: MonitoredRow, resetMonitored = false) {
  const tmdb = tmdbClient(ctx);
  const show = await tmdb.show(row.tmdbId);
  const wantedSeasons: number[] | null = row.seasons ? (JSON.parse(row.seasons) as number[]) : null;
  const runtimes: number[] = [];
  // Anime is numbered from the first episode of the show; count it in season order.
  let absolute = 0;
  for (const s of [...show.seasons].sort((a, b) => a.season_number - b.season_number)) {
    if (s.season_number === 0) continue; // specials are opt-in by searching manually
    const season = await tmdb.season(row.tmdbId, s.season_number);
    for (const e of [...season.episodes].sort((a, b) => a.episode_number - b.episode_number)) {
      absolute++;
      if (e.runtime) runtimes.push(e.runtime);
      const isMonitored = !wantedSeasons || wantedSeasons.includes(s.season_number);
      ctx.db
        .insert(monitoredEpisodes)
        .values({ monitoredId: row.id, season: s.season_number, episode: e.episode_number, title: e.name, airDate: e.air_date, episodeType: e.episode_type ?? null, monitored: isMonitored, absoluteNumber: absolute })
        .onConflictDoUpdate({
          target: [monitoredEpisodes.monitoredId, monitoredEpisodes.season, monitoredEpisodes.episode],
          set: { title: e.name, airDate: e.air_date, episodeType: e.episode_type ?? null, absoluteNumber: absolute, ...(resetMonitored ? { monitored: isMonitored } : {}) },
        })
        .run();
    }
  }
  // TMDB often leaves a show's own episode length empty; the episodes' typical length stands in,
  // so size limits by runtime can apply.
  if (runtimes.length) {
    const typical = runtimes.sort((a, b) => a - b)[Math.floor(runtimes.length / 2)]!;
    ctx.db.update(media).set({ runtime: typical }).where(and(eq(media.kind, 'show'), eq(media.tmdbId, row.tmdbId), isNull(media.runtime))).run();
  }
  return show;
}

/** Quality of what's already on a media server, used when the app didn't import the file itself. */
function serverQuality(ctx: AppContext, kind: MediaKind, tmdbId: number): Map<string, string> | string | null {
  const items = ctx.db.select().from(libraryItems).where(and(eq(libraryItems.kind, kind), eq(libraryItems.tmdbId, tmdbId))).all();
  if (kind === 'movie') {
    const res = bestResolution(items.map((i) => i.resolution));
    return res ? qualityFor(res, 'webdl') : null;
  }
  const map = new Map<string, string>();
  for (const item of items) {
    for (const e of ctx.db.select().from(libraryEpisodes).where(eq(libraryEpisodes.libraryItemId, item.id)).all()) {
      const q = e.resolution ? qualityFor(e.resolution, 'webdl') : 'Unknown';
      map.set(`${e.season}:${e.episode}`, q);
    }
  }
  return map;
}

/** Animation made in Japanese: released by fansub and anime groups with absolute numbers. */
export const looksLikeAnime = (show: { original_language?: string; genres: { id: number; name: string }[] }) => show.original_language === 'ja' && show.genres.some((g) => g.id === 16);

/** What still needs downloading (missing, or upgradable) for a monitored title. Null when nothing is wanted. */
export function wantedTarget(ctx: AppContext, row: MonitoredRow, filter?: SearchFilter): Target | null {
  const profile = searchProfile(ctx, row.profileId);
  if (!profile || (!row.monitored && !filter?.replace)) return null;
  if (filter?.replace) {
    // Everything in scope counts as missing, so even a file at the cutoff gets a new copy.
    if (row.kind === 'movie') return { kind: 'movie', title: row.title, year: row.year, currentQuality: null };
    const eps = ctx.db
      .select()
      .from(monitoredEpisodes)
      .where(eq(monitoredEpisodes.monitoredId, row.id))
      .all()
      .filter((e) => (filter.season === undefined || e.season === filter.season) && (filter.episode === undefined || e.episode === filter.episode) && (e.filePath || (e.airDate && e.airDate <= today())))
      .map((e) => ({ season: e.season, episode: e.episode, airDate: e.airDate, absolute: e.absoluteNumber, currentQuality: null, currentFormatScore: null }));
    return eps.length ? { kind: 'show', title: row.title, year: row.year, episodes: eps } : null;
  }
  if (row.kind === 'movie') {
    const current = row.fileQuality ?? (serverQuality(ctx, 'movie', row.tmdbId) as string | null);
    const score = row.fileQuality ? row.fileFormatScore : null;
    if (current && (filter?.missingOnly || !belowCutoff(profile, current, score))) return null;
    return { kind: 'movie', title: row.title, year: row.year, currentQuality: current, currentFormatScore: score };
  }
  const onServer = serverQuality(ctx, 'show', row.tmdbId) as Map<string, string>;
  const eps = ctx.db
    .select()
    .from(monitoredEpisodes)
    .where(eq(monitoredEpisodes.monitoredId, row.id))
    .all()
    // Searched by season or episode, unmonitored episodes count too; a single episode is looked for even
    // when TMDB has no air date or a later one. "Missing only" leaves out upgrades of files already there.
    .filter((e) => (filter?.season !== undefined || e.monitored) && (filter?.episode !== undefined || (e.airDate && e.airDate <= today())))
    .filter((e) => filter?.season === undefined || e.season === filter.season)
    .filter((e) => filter?.episode === undefined || e.episode === filter.episode)
    .map((e) => ({
      season: e.season,
      episode: e.episode,
      airDate: e.airDate,
      absolute: e.absoluteNumber,
      currentQuality: e.fileQuality ?? onServer.get(`${e.season}:${e.episode}`) ?? null,
      currentFormatScore: e.fileQuality ? e.fileFormatScore : null,
    }))
    .filter((e) => !e.currentQuality || (!filter?.missingOnly && belowCutoff(profile, e.currentQuality, e.currentFormatScore)));
  return eps.length ? { kind: 'show', title: row.title, year: row.year, episodes: eps } : null;
}

/** Number of items a profile change would make eligible for an upgrade search. */
export function upgradeCandidates(ctx: AppContext, row: MonitoredRow): number {
  const t = wantedTarget(ctx, row);
  if (!t) return 0;
  return t.kind === 'movie' ? (t.currentQuality ? 1 : 0) : (t.episodes ?? []).filter((e) => e.currentQuality).length;
}

/** At most this many titles are added per run, so a huge first sync doesn't flood TMDB. The hourly run carries on. */
const AUTO_MONITOR_BATCH = 1000;

/**
 * Monitors titles the library sync found on Plex or Jellyfin (Settings → Media servers). Titles
 * someone removed from monitoring by hand are left alone. Returns how many were added.
 */
export async function monitorLibrary(ctx: AppContext): Promise<number> {
  const mode = ctx.settings.get('library').autoMonitor;
  if (mode === 'off' || !tmdbClient(ctx).configured) return 0;
  const seen = new Set<string>();
  for (const r of ctx.db.select({ kind: monitored.kind, tmdbId: monitored.tmdbId }).from(monitored).all()) seen.add(`${r.kind}:${r.tmdbId}`);
  for (const r of ctx.db.select().from(monitorExclusions).all()) seen.add(`${r.kind}:${r.tmdbId}`);
  const todo = new Map<string, { kind: MediaKind; tmdbId: number }>();
  for (const i of ctx.db.select({ kind: libraryItems.kind, tmdbId: libraryItems.tmdbId }).from(libraryItems).all()) {
    if (i.tmdbId && !seen.has(`${i.kind}:${i.tmdbId}`)) todo.set(`${i.kind}:${i.tmdbId}`, { kind: i.kind, tmdbId: i.tmdbId });
  }
  let added = 0;
  for (const t of [...todo.values()].slice(0, AUTO_MONITOR_BATCH)) {
    try {
      const row = await monitorTitle(ctx, { kind: t.kind, tmdbId: t.tmdbId, profileId: defaultProfileId(ctx, t.kind), seasons: null, addedBy: null });
      if (mode === 'new') {
        // Already out: leave it as it is on the server. Only what airs from now on is fetched.
        if (row.kind === 'movie') ctx.db.update(monitored).set({ monitored: false }).where(eq(monitored.id, row.id)).run();
        else {
          for (const e of ctx.db.select().from(monitoredEpisodes).where(eq(monitoredEpisodes.monitoredId, row.id)).all()) {
            if (!e.airDate || e.airDate <= today()) ctx.db.update(monitoredEpisodes).set({ monitored: false }).where(eq(monitoredEpisodes.id, e.id)).run();
          }
        }
      }
      added++;
    } catch {
      // TMDB hiccup: tried again on the next sync
    }
  }
  return added;
}

/** Remembers that a title was removed from monitoring by hand, so library sync doesn't add it back. */
export function excludeFromAutoMonitor(ctx: AppContext, kind: MediaKind, tmdbId: number) {
  ctx.db.insert(monitorExclusions).values({ kind, tmdbId, createdAt: Date.now() }).onConflictDoNothing().run();
}
