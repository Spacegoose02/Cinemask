import { randomInt } from 'node:crypto';
import { and, desc, eq, gte, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { GAMES, gameRounds, libraryItems, media, users, type Game, type MediaKind } from '../db/schema.js';
import { randomToken } from '../security/crypto.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { nameOf } from './ratings.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const ROUND_SIZE = 5;

export interface GameQuestion {
  prompt: string;
  /** A plot to read (trivia) or nothing. */
  detail: string | null;
  /** A TMDB backdrop path (scene game). */
  image: string | null;
  choices: string[];
  answer: number;
  /** The title the question is about, so the results can link to it. */
  kind: MediaKind;
  tmdbId: number;
  title: string;
}

type Title = Pick<typeof media.$inferSelect, 'kind' | 'tmdbId' | 'title' | 'year' | 'overview' | 'backdropPath' | 'rating' | 'runtime' | 'genres'>;

const pick = <T>(xs: T[]): T => xs[randomInt(xs.length)]!;
function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
const sample = <T>(xs: T[], n: number) => shuffle(xs).slice(0, n);
const label = (t: Title) => (t.year ? `${t.title} (${t.year})` : t.title);
const genresOf = (t: Title): string[] => (t.genres ? (JSON.parse(t.genres) as string[]) : []);

/** Titles on the household's servers, with enough metadata to ask about. */
function pool(ctx: AppContext): Title[] {
  return ctx.db
    .select({ kind: media.kind, tmdbId: media.tmdbId, title: media.title, year: media.year, overview: media.overview, backdropPath: media.backdropPath, rating: media.rating, runtime: media.runtime, genres: media.genres })
    .from(media)
    .where(sql`EXISTS (SELECT 1 FROM ${libraryItems} WHERE ${libraryItems.kind} = ${media.kind} AND ${libraryItems.tmdbId} = ${media.tmdbId})`)
    .all();
}

/** Puts the right answer among the others in a random spot. */
function ask(about: Title, prompt: string, right: string, wrong: string[], extra: { detail?: string | null; image?: string | null } = {}): GameQuestion {
  const choices = shuffle([right, ...wrong]);
  return { prompt, detail: extra.detail ?? null, image: extra.image ?? null, choices, answer: choices.indexOf(right), kind: about.kind, tmdbId: about.tmdbId, title: about.title };
}

/** Other titles to offer as wrong answers, with labels that differ from the right one. */
function others(titles: Title[], not: Title, n: number, kind?: MediaKind): Title[] {
  const same = titles.filter((t) => t !== not && label(t) !== label(not) && (!kind || t.kind === kind));
  const seen = new Set<string>();
  return shuffle(same.length >= n ? same : titles.filter((t) => t !== not && label(t) !== label(not))).filter((t) => !seen.has(label(t)) && seen.add(label(t))).slice(0, n);
}

const TRIVIA: ((titles: Title[]) => GameQuestion | null)[] = [
  // What year did it come out?
  (titles) => {
    const t = pick(titles.filter((x) => x.year));
    if (!t?.year) return null;
    const years = new Set<number>([t.year]);
    for (let tries = 0; years.size < 4 && tries < 50; tries++) {
      const y = t.year + (randomInt(2) ? 1 : -1) * (1 + randomInt(8));
      if (y <= new Date().getFullYear() + 1 && y >= 1900) years.add(y);
    }
    if (years.size < 4) return null;
    return ask(t, `What year did ${t.title} come out?`, String(t.year), [...years].slice(1).map(String));
  },
  // Which title is this plot from? The title's own name is blanked out of the plot.
  (titles) => {
    const t = pick(titles.filter((x) => (x.overview?.length ?? 0) > 60));
    if (!t) return null;
    const wrong = others(titles, t, 3, t.kind);
    if (wrong.length < 3) return null;
    const escaped = t.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const plot = t.overview!.replace(new RegExp(escaped, 'gi'), '▇▇▇');
    return ask(t, `Which ${t.kind === 'movie' ? 'movie' : 'show'} is this?`, label(t), wrong.map(label), { detail: plot });
  },
  // Which is rated highest?
  (titles) => {
    const rated = titles.filter((x) => x.rating);
    const four = sample(rated, 4);
    if (four.length < 4 || new Set(four.map((x) => x.rating!.toFixed(1))).size < 4) return null;
    const best = four.reduce((a, b) => (b.rating! > a.rating! ? b : a));
    return ask(best, 'Which of these has the highest rating on TMDB?', label(best), four.filter((x) => x !== best).map(label));
  },
  // Which one is a comedy?
  (titles) => {
    const t = pick(titles.filter((x) => genresOf(x).length));
    if (!t) return null;
    const genre = pick(genresOf(t));
    const wrong = sample(
      titles.filter((x) => genresOf(x).length && !genresOf(x).includes(genre)),
      3,
    );
    if (wrong.length < 3) return null;
    return ask(t, `Which of these is ${/^[aeiou]/i.test(genre) ? 'an' : 'a'} ${genre} title?`, label(t), wrong.map(label));
  },
  // Which movie is longest?
  (titles) => {
    const four = sample(titles.filter((x) => x.kind === 'movie' && x.runtime), 4);
    if (four.length < 4 || new Set(four.map((x) => x.runtime)).size < 4) return null;
    const longest = four.reduce((a, b) => (b.runtime! > a.runtime! ? b : a));
    return ask(longest, 'Which of these movies is the longest?', label(longest), four.filter((x) => x !== longest).map(label));
  },
];

/** Five questions made from what's on the household's servers. Null when there isn't enough to ask about. */
export function buildQuestions(game: Game, titles: Title[]): GameQuestion[] | null {
  if (game === 'scene') {
    const withScenes = titles.filter((t) => t.backdropPath);
    if (withScenes.length < 4) return null;
    return sample(withScenes, ROUND_SIZE).map((t) => ask(t, 'Which title is this scene from?', label(t), others(titles, t, 3, t.kind).map(label), { image: t.backdropPath }));
  }
  if (titles.length < 4) return null;
  const out: GameQuestion[] = [];
  // Each kind of question takes a turn, in a random order, so a round isn't five of the same.
  const order = shuffle(TRIVIA);
  for (let tries = 0; out.length < ROUND_SIZE && tries < 60; tries++) {
    const q = order[tries % order.length]!(titles);
    if (q && q.choices.length === 4 && !out.some((o) => o.prompt === q.prompt && o.tmdbId === q.tmdbId)) out.push(q);
  }
  return out.length ? out : null;
}

const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** Days in a row with a finished round: the current run (ending today or yesterday) and the longest ever. */
export function streaks(ctx: AppContext, userId: number, now = Date.now()): { current: number; best: number } {
  const days = new Set(
    ctx.db
      .select({ at: gameRounds.finishedAt })
      .from(gameRounds)
      .where(and(eq(gameRounds.userId, userId), isNotNull(gameRounds.finishedAt)))
      .all()
      .map((r) => dayKey(r.at!)),
  );
  // Walking back a day at a time from noon avoids being thrown by daylight saving changes.
  const noon = new Date(now);
  noon.setHours(12, 0, 0, 0);
  const runFrom = (start: number) => {
    let n = 0;
    while (days.has(dayKey(start - n * DAY))) n++;
    return n;
  };
  const current = runFrom(noon.getTime()) || runFrom(noon.getTime() - DAY);
  let best = 0;
  for (const key of days) {
    const [y, m, d] = key.split('-').map(Number);
    const at = new Date(y!, m! - 1, d!, 12).getTime();
    // Only count from the first day of each run.
    if (!days.has(dayKey(at - DAY))) best = Math.max(best, runFrom(at));
  }
  return { current, best };
}

export async function gameRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  app.post('/api/games/:game/rounds', { config: { access: 'user' } }, async (req) => {
    const { game } = parse(z.object({ game: z.enum(GAMES) }), req.params);
    // Rounds nobody finished are only kept for a day.
    ctx.db.delete(gameRounds).where(and(isNull(gameRounds.finishedAt), lt(gameRounds.createdAt, Date.now() - DAY))).run();
    const questions = buildQuestions(game, pool(ctx));
    if (!questions) throw conflict('There are not enough titles on your servers to play yet. Sync the library and try again.');
    const id = randomToken(18);
    ctx.db.insert(gameRounds).values({ id, userId: req.user!.id, game, questions: JSON.stringify(questions), total: questions.length, createdAt: Date.now() }).run();
    return { id, game, questions: questions.map(({ prompt, detail, image, choices }) => ({ prompt, detail, image, choices })) };
  });

  app.post('/api/games/rounds/:id/answers', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    const { answers } = parse(z.object({ answers: z.array(z.number().int().min(0).max(3).nullable()).max(ROUND_SIZE) }), req.body);
    const round = ctx.db.select().from(gameRounds).where(and(eq(gameRounds.id, id), eq(gameRounds.userId, req.user!.id))).get();
    if (!round) throw notFound('No such round');
    if (round.finishedAt) throw conflict('This round is already scored');
    if (Date.now() - round.createdAt > HOUR) throw new HttpError(410, 'This round expired. Start a new one.', 'expired');
    const questions = JSON.parse(round.questions) as GameQuestion[];
    const results = questions.map((q, i) => ({ correct: answers[i] === q.answer, answer: q.answer, chosen: answers[i] ?? null, kind: q.kind, tmdbId: q.tmdbId, title: q.title }));
    const score = results.filter((r) => r.correct).length;
    // Scored once: the update only matches while the round is unfinished, so two submissions can't both count.
    const done = ctx.db
      .update(gameRounds)
      .set({ score, finishedAt: Date.now() })
      .where(and(eq(gameRounds.id, id), isNull(gameRounds.finishedAt)))
      .returning()
      .get();
    if (!done) throw conflict('This round is already scored');
    return { score, total: round.total, results, streak: streaks(ctx, req.user!.id) };
  });

  /** This week's scores for everyone, and the caller's streak. */
  app.get('/api/games/leaderboard', { config: { access: 'user' } }, async (req) => {
    const rows = ctx.db
      .select({
        userId: gameRounds.userId,
        username: users.username,
        displayName: users.displayName,
        rounds: sql<number>`count(*)`,
        correct: sql<number>`sum(${gameRounds.score})`,
        best: sql<number>`max(${gameRounds.score})`,
        perfect: sql<number>`sum(CASE WHEN ${gameRounds.score} = ${gameRounds.total} THEN 1 ELSE 0 END)`,
      })
      .from(gameRounds)
      .innerJoin(users, eq(users.id, gameRounds.userId))
      .where(and(isNotNull(gameRounds.finishedAt), gte(gameRounds.finishedAt, Date.now() - 7 * DAY)))
      .groupBy(gameRounds.userId)
      .orderBy(desc(sql`sum(${gameRounds.score})`), desc(sql`max(${gameRounds.score})`))
      .limit(20)
      .all();
    return {
      week: rows.map((r) => ({ userId: r.userId, name: nameOf(r), rounds: r.rounds, correct: r.correct, best: r.best, perfect: r.perfect })),
      streak: streaks(ctx, req.user!.id),
    };
  });
}
