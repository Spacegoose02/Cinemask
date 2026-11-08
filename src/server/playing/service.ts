import { and, eq, gte, inArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { libraryItems, plays, type ServerType } from '../db/schema.js';
import type { LiveSession } from '../integrations/mediaserver.js';
import { mediaServers } from '../library/service.js';

/**
 * Now playing and watch stats, as Tautulli does for Plex: every minute the media servers' session
 * lists are read, each play is kept in `plays`, and a play that drops off the list is finished.
 * Time watched only counts while something is playing (not paused), and at most a little over
 * the check interval at a time, so a missed check doesn't add hours.
 */
const MAX_STEP_MS = 2 * 60 * 1000;
/** A play shorter than this (a trailer, a misclick) isn't counted in the stats. */
export const MIN_PLAY_MS = 60 * 1000;

export async function trackPlays(ctx: AppContext, now = Date.now()): Promise<number> {
  let seen = 0;
  for (const { server, client } of mediaServers(ctx)) {
    if (!client.sessions) continue;
    let live: LiveSession[];
    try {
      live = await client.sessions();
    } catch {
      // Server unreachable: leave its plays as they are until it answers again.
      continue;
    }
    seen += live.length;
    recordSessions(ctx, server, live, now);
  }
  return seen;
}

export function recordSessions(ctx: AppContext, server: ServerType, live: LiveSession[], now = Date.now()) {
  const keys = [...new Set(live.map((s) => s.itemKey).filter((k): k is string => !!k))];
  const tmdb = new Map(keys.length ? ctx.db.select({ key: libraryItems.externalKey, tmdbId: libraryItems.tmdbId }).from(libraryItems).where(and(eq(libraryItems.server, server), inArray(libraryItems.externalKey, keys))).all().map((r) => [r.key, r.tmdbId]) : []);
  const ids = new Set<string>();
  for (const s of live) {
    ids.add(s.id);
    const values = {
      state: s.state,
      positionMs: s.positionMs,
      durationMs: s.durationMs,
      player: s.player,
      platform: s.platform,
      decision: s.decision,
      quality: s.quality,
      bandwidthKbps: s.bandwidthKbps,
      local: s.local,
      controlId: s.controlId,
      updatedAt: now,
      active: true,
      stoppedAt: null,
    };
    const row = ctx.db.select().from(plays).where(and(eq(plays.server, server), eq(plays.sessionId, s.id))).get();
    if (!row) {
      ctx.db
        .insert(plays)
        .values({ server, sessionId: s.id, user: s.user, kind: s.kind, title: s.title, show: s.show, season: s.season, episode: s.episode, year: s.year, tmdbId: s.itemKey ? (tmdb.get(s.itemKey) ?? null) : null, startedAt: now, watchedMs: 0, ...values })
        .run();
      continue;
    }
    const step = row.state === 'playing' && s.state === 'playing' ? Math.min(now - row.updatedAt, MAX_STEP_MS) : 0;
    ctx.db
      .update(plays)
      .set({ ...values, watchedMs: row.watchedMs + Math.max(0, step) })
      .where(eq(plays.id, row.id))
      .run();
  }
  // Gone from the list: finished.
  for (const r of ctx.db.select().from(plays).where(and(eq(plays.server, server), eq(plays.active, true))).all()) {
    if (ids.has(r.sessionId)) continue;
    ctx.db.update(plays).set({ active: false, stoppedAt: r.updatedAt, state: 'stopped' }).where(eq(plays.id, r.id)).run();
  }
}

export function nowPlaying(ctx: AppContext) {
  return ctx.db
    .select()
    .from(plays)
    .where(eq(plays.active, true))
    .all()
    .map((p) => ({ ...p, progress: p.durationMs ? Math.min(1, p.positionMs / p.durationMs) : null }));
}

export interface WatchStats {
  days: number;
  plays: number;
  hours: number;
  users: { user: string; plays: number; hours: number; lastAt: number }[];
  titles: { title: string; kind: 'movie' | 'show' | 'other'; tmdbId: number | null; plays: number; people: number }[];
  daily: { date: string; plays: number; hours: number }[];
  players: { player: string; plays: number }[];
  decisions: { direct: number; copy: number; transcode: number };
  history: (typeof plays.$inferSelect)[];
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

/** Who watched what over the last `days` days, by person, title, day and player. */
export function watchStats(ctx: AppContext, days: number, now = Date.now()): WatchStats {
  const since = now - days * 24 * 60 * 60 * 1000;
  const rows = ctx.db.select().from(plays).where(gte(plays.startedAt, since)).all();
  const counted = rows.filter((r) => r.watchedMs >= MIN_PLAY_MS);
  const users = new Map<string, { plays: number; ms: number; lastAt: number }>();
  const titles = new Map<string, { title: string; kind: 'movie' | 'show' | 'other'; tmdbId: number | null; plays: number; people: Set<string> }>();
  const daily = new Map<string, { plays: number; ms: number }>();
  const players = new Map<string, number>();
  const decisions = { direct: 0, copy: 0, transcode: 0 };
  for (const r of counted) {
    const u = users.get(r.user) ?? { plays: 0, ms: 0, lastAt: 0 };
    u.plays++;
    u.ms += r.watchedMs;
    u.lastAt = Math.max(u.lastAt, r.updatedAt);
    users.set(r.user, u);
    const name = r.kind === 'episode' ? (r.show ?? r.title) : r.title;
    const kind = r.kind === 'episode' ? 'show' : r.kind;
    const tkey = `${kind}:${r.tmdbId ?? name}`;
    const t = titles.get(tkey) ?? { title: name, kind, tmdbId: r.tmdbId, plays: 0, people: new Set<string>() };
    t.plays++;
    t.people.add(r.user);
    titles.set(tkey, t);
    const d = daily.get(day(r.startedAt)) ?? { plays: 0, ms: 0 };
    d.plays++;
    d.ms += r.watchedMs;
    daily.set(day(r.startedAt), d);
    const p = r.player ?? r.platform ?? 'Unknown';
    players.set(p, (players.get(p) ?? 0) + 1);
    if (r.decision === 'direct' || r.decision === 'copy' || r.decision === 'transcode') decisions[r.decision]++;
  }
  const allDays = Array.from({ length: days }, (_, i) => day(now - (days - 1 - i) * 24 * 60 * 60 * 1000));
  return {
    days,
    plays: counted.length,
    hours: hours(counted.reduce((n, r) => n + r.watchedMs, 0)),
    users: [...users].map(([user, u]) => ({ user, plays: u.plays, hours: hours(u.ms), lastAt: u.lastAt })).sort((a, b) => b.hours - a.hours),
    titles: [...titles.values()].map((t) => ({ title: t.title, kind: t.kind, tmdbId: t.tmdbId, plays: t.plays, people: t.people.size })).sort((a, b) => b.plays - a.plays).slice(0, 15),
    daily: allDays.map((date) => ({ date, plays: daily.get(date)?.plays ?? 0, hours: hours(daily.get(date)?.ms ?? 0) })),
    players: [...players].map(([player, n]) => ({ player, plays: n })).sort((a, b) => b.plays - a.plays).slice(0, 10),
    decisions,
    history: rows.filter((r) => !r.active).sort((a, b) => b.startedAt - a.startedAt).slice(0, 100),
  };
}
