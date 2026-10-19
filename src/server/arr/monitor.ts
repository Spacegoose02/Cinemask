import { and, eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { libraryEpisodes, libraryItems, monitored, monitoredEpisodes, type MediaKind } from '../db/schema.js';
import { bestResolution } from '../integrations/http.js';
import { refreshMetadata, tmdbClient } from '../library/service.js';
import type { Target } from './decision.js';
import { belowCutoff, getProfile } from './profiles.js';
import { qualityFor } from './quality.js';

export type MonitoredRow = typeof monitored.$inferSelect;

const today = () => new Date().toISOString().slice(0, 10);

/** Starts watching a title (or updates how it's watched). Shows get their episode list from TMDB. */
export async function monitorTitle(
  ctx: AppContext,
  input: { kind: MediaKind; tmdbId: number; profileId: number; seasons?: number[] | null; addedBy?: number | null },
): Promise<MonitoredRow> {
  const meta = await refreshMetadata(ctx, input.kind, input.tmdbId);
  if (!meta) throw new Error('Could not look up this title. Check the TMDB key in Settings → Metadata.');
  const existing = ctx.db.select().from(monitored).where(and(eq(monitored.kind, input.kind), eq(monitored.tmdbId, input.tmdbId))).get();
  const seasons = input.seasons === undefined ? existing?.seasons ?? null : input.seasons ? JSON.stringify([...new Set(input.seasons)].sort((a, b) => a - b)) : null;
  const row = existing
    ? ctx.db.update(monitored).set({ profileId: input.profileId, monitored: true, seasons }).where(eq(monitored.id, existing.id)).returning().get()
    : ctx.db
        .insert(monitored)
        .values({ kind: input.kind, tmdbId: input.tmdbId, title: meta.title, year: meta.year, profileId: input.profileId, seasons, addedBy: input.addedBy ?? null, addedAt: Date.now() })
        .returning()
        .get();
  if (row.kind === 'show') await refreshEpisodes(ctx, row);
  return row;
}

/** Syncs a monitored show's episode list (titles, air dates) from TMDB. */
export async function refreshEpisodes(ctx: AppContext, row: MonitoredRow) {
  const tmdb = tmdbClient(ctx);
  const show = await tmdb.show(row.tmdbId);
  const wantedSeasons: number[] | null = row.seasons ? (JSON.parse(row.seasons) as number[]) : null;
  for (const s of show.seasons) {
    if (s.season_number === 0) continue; // specials are opt-in by searching manually
    const season = await tmdb.season(row.tmdbId, s.season_number);
    for (const e of season.episodes) {
      const isMonitored = !wantedSeasons || wantedSeasons.includes(s.season_number);
      ctx.db
        .insert(monitoredEpisodes)
        .values({ monitoredId: row.id, season: s.season_number, episode: e.episode_number, title: e.name, airDate: e.air_date, monitored: isMonitored })
        .onConflictDoUpdate({
          target: [monitoredEpisodes.monitoredId, monitoredEpisodes.season, monitoredEpisodes.episode],
          set: { title: e.name, airDate: e.air_date, monitored: isMonitored },
        })
        .run();
    }
  }
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

/** What still needs downloading (missing, or upgradable) for a monitored title. Null when nothing is wanted. */
export function wantedTarget(ctx: AppContext, row: MonitoredRow, filter?: { season?: number; episode?: number }): Target | null {
  const profile = getProfile(ctx, row.profileId);
  if (!profile || !row.monitored) return null;
  if (row.kind === 'movie') {
    const current = row.fileQuality ?? (serverQuality(ctx, 'movie', row.tmdbId) as string | null);
    if (current && !belowCutoff(profile, current)) return null;
    return { kind: 'movie', title: row.title, year: row.year, currentQuality: current };
  }
  const onServer = serverQuality(ctx, 'show', row.tmdbId) as Map<string, string>;
  const eps = ctx.db
    .select()
    .from(monitoredEpisodes)
    .where(eq(monitoredEpisodes.monitoredId, row.id))
    .all()
    .filter((e) => (filter ? true : e.monitored) && e.airDate && e.airDate <= today())
    .filter((e) => filter?.season === undefined || e.season === filter.season)
    .filter((e) => filter?.episode === undefined || e.episode === filter.episode)
    .map((e) => ({ season: e.season, episode: e.episode, currentQuality: e.fileQuality ?? onServer.get(`${e.season}:${e.episode}`) ?? null }))
    .filter((e) => !e.currentQuality || belowCutoff(profile, e.currentQuality));
  return eps.length ? { kind: 'show', title: row.title, year: row.year, episodes: eps } : null;
}

/** Number of items a profile change would make eligible for an upgrade search. */
export function upgradeCandidates(ctx: AppContext, row: MonitoredRow): number {
  const t = wantedTarget(ctx, row);
  if (!t) return 0;
  return t.kind === 'movie' ? (t.currentQuality ? 1 : 0) : (t.episodes ?? []).filter((e) => e.currentQuality).length;
}
