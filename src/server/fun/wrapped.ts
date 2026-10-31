import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { gameRounds, libraryEpisodes, libraryItems, media, movieNightRsvps, movieNights, ratings, requests, type MediaKind } from '../db/schema.js';
import { parse } from '../lib/validate.js';
import { streaks } from './games.js';

interface TitleRef {
  kind: MediaKind;
  tmdbId: number | null;
  title: string;
  year: number | null;
  posterPath: string | null;
}

/** A raccoon for every taste, picked by the genre someone watches, requests and rates most. */
const PERSONAS: [RegExp, string, string][] = [
  [/horror/i, 'The Midnight Bandit', 'Lights off, volume up, and never scared of what is under the bin lid.'],
  [/comedy/i, 'The Giggling Trash Panda', 'Here for the laughs, and usually the loudest one on the couch.'],
  [/animation|family|kids/i, 'The Cozy Cub', 'Blankets, snacks and stories the whole den can enjoy.'],
  [/action|adventure|war|western/i, 'The Daring Masked Raider', 'Explosions, heists and chases. The bigger the better.'],
  [/science fiction|sci-fi/i, 'The Starry-Eyed Scavenger', 'Always looking up, hunting for the next world to explore.'],
  [/fantasy/i, 'The Dreamy Den-Dweller', 'Dragons, wizards and quests, best watched from a cozy den.'],
  [/crime|thriller|mystery/i, 'The Masked Detective', 'Clues, twists and whodunits. Nothing gets past this raccoon.'],
  [/documentary|history/i, 'The Curious Forager', 'Digs up facts the way other raccoons dig up snacks.'],
  [/romance/i, 'The Hopeless Romantic', 'Here for the meet-cutes and the happy endings.'],
  [/drama/i, 'The Soulful Night Owl', 'Big feelings, great acting, and the tissues kept close.'],
  [/music/i, 'The Rocking Raccoon', 'Lives for a great soundtrack and a sing-along.'],
];
const DEFAULT_PERSONA = { name: 'The All-Night Snacker', blurb: 'A bit of everything, as long as there is popcorn.' };

export function personaFor(genre: string | null) {
  const hit = genre ? PERSONAS.find(([re]) => re.test(genre)) : undefined;
  return hit ? { name: hit[1], blurb: hit[2], genre } : { ...DEFAULT_PERSONA, genre };
}

const genresOf = (raw: string | null | undefined): string[] => (raw ? (JSON.parse(raw) as string[]) : []);

function topCounts(values: string[], n: number) {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** What the servers played in the period. Plex and Jellyfin only report each title's latest play, so these are lower bounds. */
function household(ctx: AppContext, start: number, end: number) {
  const inRange = (col: typeof libraryItems.lastViewedAt | typeof libraryEpisodes.lastViewedAt) => and(isNotNull(col), gte(col, start), lt(col, end));
  const movies = ctx.db
    .select({ tmdbId: libraryItems.tmdbId, title: libraryItems.title, year: libraryItems.year, at: libraryItems.lastViewedAt, runtime: media.runtime, genres: media.genres, posterPath: media.posterPath })
    .from(libraryItems)
    .leftJoin(media, and(eq(media.kind, 'movie'), eq(media.tmdbId, libraryItems.tmdbId)))
    .where(and(eq(libraryItems.kind, 'movie'), inRange(libraryItems.lastViewedAt)))
    .all();
  const episodes = ctx.db
    .select({ tmdbId: libraryItems.tmdbId, title: libraryItems.title, year: libraryItems.year, season: libraryEpisodes.season, episode: libraryEpisodes.episode, at: libraryEpisodes.lastViewedAt, runtime: media.runtime, genres: media.genres, posterPath: media.posterPath })
    .from(libraryEpisodes)
    .innerJoin(libraryItems, eq(libraryItems.id, libraryEpisodes.libraryItemId))
    .leftJoin(media, and(eq(media.kind, 'show'), eq(media.tmdbId, libraryItems.tmdbId)))
    .where(inRange(libraryEpisodes.lastViewedAt))
    .all();

  // The same title on two servers counts once.
  const uniqueMovies = [...new Map(movies.map((m) => [m.tmdbId ?? `${m.title}:${m.year}`, m])).values()];
  const uniqueEpisodes = [...new Map(episodes.map((e) => [`${e.tmdbId ?? e.title}:${e.season}:${e.episode}`, e])).values()];
  const minutes = uniqueMovies.reduce((n, m) => n + (m.runtime ?? 100), 0) + uniqueEpisodes.reduce((n, e) => n + (e.runtime ?? 40), 0);

  const perShow = new Map<string, TitleRef & { tmdbId: number | null; genres: string[]; episodes: number }>();
  for (const e of uniqueEpisodes) {
    const key = String(e.tmdbId ?? e.title);
    const cur = perShow.get(key) ?? { kind: 'show', tmdbId: e.tmdbId, title: e.title, year: e.year, posterPath: e.posterPath, genres: genresOf(e.genres), episodes: 0 };
    cur.episodes++;
    perShow.set(key, cur);
  }
  const shows = [...perShow.values()];
  const topShow = [...shows].sort((a, b) => b.episodes - a.episodes)[0] ?? null;
  const months = topCounts(
    [...uniqueMovies, ...uniqueEpisodes].map((x) => MONTHS[new Date(x.at!).getMonth()]!),
    1,
  )[0];
  return {
    movies: uniqueMovies.length,
    shows: shows.length,
    episodes: uniqueEpisodes.length,
    hours: Math.round(minutes / 60),
    // Each movie and each show counts once towards a genre.
    topGenres: topCounts([...uniqueMovies.flatMap((m) => genresOf(m.genres)), ...shows.flatMap((x) => x.genres)], 5).map(([genre, count]) => ({ genre, count })),
    topShow: topShow ? { kind: topShow.kind, tmdbId: topShow.tmdbId, title: topShow.title, year: topShow.year, posterPath: topShow.posterPath, episodes: topShow.episodes } : null,
    busiestMonth: months ? months[0] : null,
  };
}

/** A person's own year: requests, ratings, movie nights and games. */
function personal(ctx: AppContext, userId: number, start: number, end: number) {
  const reqs = ctx.db
    .select({ status: requests.status, genres: media.genres })
    .from(requests)
    .leftJoin(media, and(eq(media.kind, requests.kind), eq(media.tmdbId, requests.tmdbId)))
    .where(and(eq(requests.requestedBy, userId), gte(requests.createdAt, start), lt(requests.createdAt, end)))
    .all();
  const rated = ctx.db
    .select({ kind: ratings.kind, tmdbId: ratings.tmdbId, stars: ratings.stars, review: ratings.review, updatedAt: ratings.updatedAt, title: media.title, year: media.year, posterPath: media.posterPath, genres: media.genres })
    .from(ratings)
    .innerJoin(media, and(eq(media.kind, ratings.kind), eq(media.tmdbId, ratings.tmdbId)))
    .where(and(eq(ratings.userId, userId), gte(ratings.updatedAt, start), lt(ratings.updatedAt, end)))
    .all();
  const favorite = [...rated].sort((a, b) => b.stars - a.stars || b.updatedAt - a.updatedAt)[0];
  const nightsHosted = ctx.db.select({ n: sql<number>`count(*)` }).from(movieNights).where(and(eq(movieNights.hostId, userId), gte(movieNights.startsAt, start), lt(movieNights.startsAt, Math.min(end, Date.now())))).get()!.n;
  const nightsAttended = ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(movieNightRsvps)
    .innerJoin(movieNights, eq(movieNights.id, movieNightRsvps.nightId))
    .where(and(eq(movieNightRsvps.userId, userId), eq(movieNightRsvps.answer, 'yes'), gte(movieNights.startsAt, start), lt(movieNights.startsAt, Math.min(end, Date.now()))))
    .get()!.n;
  const games = ctx.db
    .select({ rounds: sql<number>`count(*)`, correct: sql<number>`coalesce(sum(${gameRounds.score}), 0)`, perfect: sql<number>`coalesce(sum(CASE WHEN ${gameRounds.score} = ${gameRounds.total} THEN 1 ELSE 0 END), 0)` })
    .from(gameRounds)
    .where(and(eq(gameRounds.userId, userId), isNotNull(gameRounds.finishedAt), gte(gameRounds.finishedAt, start), lt(gameRounds.finishedAt, end)))
    .get()!;
  const tastes = [...reqs.flatMap((r) => genresOf(r.genres)), ...rated.filter((r) => r.stars >= 4).flatMap((r) => genresOf(r.genres))];
  return {
    requests: reqs.length,
    requestsReady: reqs.filter((r) => r.status === 'available').length,
    ratings: rated.length,
    reviews: rated.filter((r) => r.review).length,
    averageStars: rated.length ? Math.round((rated.reduce((n, r) => n + r.stars, 0) / rated.length) * 10) / 10 : null,
    favorite: favorite ? { kind: favorite.kind, tmdbId: favorite.tmdbId, title: favorite.title, year: favorite.year, posterPath: favorite.posterPath, stars: favorite.stars } : null,
    nightsHosted,
    nightsAttended,
    rounds: games.rounds,
    correct: games.correct,
    perfectRounds: games.perfect,
    topGenre: topCounts(tastes, 1)[0]?.[0] ?? null,
  };
}

export interface Badge {
  id: string;
  name: string;
  emoji: string;
  description: string;
  progress: number;
  target: number;
  earned: boolean;
}

/** Badges are worked out from what someone has done, so they're never out of step and need no table. */
export function badges(ctx: AppContext, userId: number): Badge[] {
  const count = (q: { n: number } | undefined) => q?.n ?? 0;
  const n = sql<number>`count(*)`;
  const reqs = count(ctx.db.select({ n }).from(requests).where(eq(requests.requestedBy, userId)).get());
  const ready = count(ctx.db.select({ n }).from(requests).where(and(eq(requests.requestedBy, userId), eq(requests.status, 'available'))).get());
  const rated = count(ctx.db.select({ n }).from(ratings).where(eq(ratings.userId, userId)).get());
  const reviews = count(ctx.db.select({ n }).from(ratings).where(and(eq(ratings.userId, userId), isNotNull(ratings.review))).get());
  const hosted = count(ctx.db.select({ n }).from(movieNights).where(and(eq(movieNights.hostId, userId), lt(movieNights.startsAt, Date.now()))).get());
  const attended = count(
    ctx.db
      .select({ n })
      .from(movieNightRsvps)
      .innerJoin(movieNights, eq(movieNights.id, movieNightRsvps.nightId))
      .where(and(eq(movieNightRsvps.userId, userId), eq(movieNightRsvps.answer, 'yes'), lt(movieNights.startsAt, Date.now())))
      .get(),
  );
  const finished = and(eq(gameRounds.userId, userId), isNotNull(gameRounds.finishedAt));
  const rounds = count(ctx.db.select({ n }).from(gameRounds).where(finished).get());
  const perfect = (game: string) => count(ctx.db.select({ n }).from(gameRounds).where(and(finished, eq(gameRounds.game, game as 'trivia'), sql`${gameRounds.score} = ${gameRounds.total}`)).get());
  const { best } = streaks(ctx, userId);

  const defs: Omit<Badge, 'earned'>[] = [
    { id: 'first-request', name: 'Wishful Thinker', emoji: '🌠', description: 'Make your first request', progress: reqs, target: 1 },
    { id: 'requests-10', name: 'Wish Collector', emoji: '🧺', description: 'Make 10 requests', progress: reqs, target: 10 },
    { id: 'request-ready', name: 'Dream Come True', emoji: '🎁', description: 'Have a request land on the server', progress: ready, target: 1 },
    { id: 'first-rating', name: 'Critic in Training', emoji: '⭐', description: 'Rate a title', progress: rated, target: 1 },
    { id: 'ratings-25', name: 'Top Critic', emoji: '🏆', description: 'Rate 25 titles', progress: rated, target: 25 },
    { id: 'reviews-5', name: 'Wordsmith', emoji: '✍️', description: 'Write 5 reviews', progress: reviews, target: 5 },
    { id: 'host', name: 'Host with the Most', emoji: '🍿', description: 'Host a movie night', progress: hosted, target: 1 },
    { id: 'guest-3', name: 'Popcorn Regular', emoji: '🛋️', description: 'Go to 3 movie nights', progress: attended, target: 3 },
    { id: 'trivia-perfect', name: 'Know-It-All', emoji: '🧠', description: 'Get every trivia question right in a round', progress: perfect('trivia'), target: 1 },
    { id: 'scene-perfect', name: 'Eagle Eye', emoji: '🦅', description: 'Name every scene in a round', progress: perfect('scene'), target: 1 },
    { id: 'rounds-25', name: 'Game Night Raccoon', emoji: '🎲', description: 'Finish 25 game rounds', progress: rounds, target: 25 },
    { id: 'streak-3', name: 'On a Roll', emoji: '🔥', description: 'Play a game 3 days in a row', progress: best, target: 3 },
    { id: 'streak-7', name: 'Unstoppable', emoji: '☄️', description: 'Play a game 7 days in a row', progress: best, target: 7 },
  ];
  return defs.map((b) => ({ ...b, progress: Math.min(b.progress, b.target), earned: b.progress >= b.target }));
}

export async function wrappedRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  /** A recap of a year (or one month of it) for the caller and the household. */
  app.get('/api/wrapped', { config: { access: 'user' } }, async (req) => {
    const now = new Date();
    const q = parse(z.object({ year: z.coerce.number().int().min(2000).max(now.getFullYear()).default(now.getFullYear()), month: z.coerce.number().int().min(1).max(12).optional() }), req.query);
    const start = new Date(q.year, q.month ? q.month - 1 : 0, 1).getTime();
    const end = q.month ? new Date(q.year, q.month, 1).getTime() : new Date(q.year + 1, 0, 1).getTime();
    const home = household(ctx, start, end);
    const you = personal(ctx, req.user!.id, start, end);
    const earned = badges(ctx, req.user!.id).filter((b) => b.earned);
    return {
      year: q.year,
      month: q.month ?? null,
      you: { ...you, persona: personaFor(you.topGenre ?? home.topGenres[0]?.genre ?? null), badges: earned, streak: streaks(ctx, req.user!.id) },
      household: home,
    };
  });

  app.get('/api/badges', { config: { access: 'user' } }, async (req) => ({ badges: badges(ctx, req.user!.id), streak: streaks(ctx, req.user!.id) }));
}
