import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { remindMovieNights } from '../src/server/fun/nights.js';
import { buildQuestions, type GameQuestion } from '../src/server/fun/games.js';
import { personaFor } from '../src/server/fun/wrapped.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
let kid: Client;
let kidId: number;
let manager: Client;
let other: Client;

const HOUR = 60 * 60 * 1000;

const MOVIES = [
  { id: 1, title: 'Paddington', year: 2014, genres: ['Family', 'Comedy'], rating: 7.2, runtime: 95 },
  { id: 2, title: 'Alien', year: 1979, genres: ['Horror', 'Science Fiction'], rating: 8.1, runtime: 117 },
  { id: 3, title: 'Heat', year: 1995, genres: ['Crime', 'Thriller'], rating: 7.9, runtime: 170 },
  { id: 4, title: 'Up', year: 2009, genres: ['Animation', 'Family'], rating: 7.6, runtime: 96 },
  { id: 5, title: 'Arrival', year: 2016, genres: ['Science Fiction', 'Drama'], rating: 7.5, runtime: 116 },
  { id: 6, title: 'Amelie', year: 2001, genres: ['Comedy', 'Romance'], rating: 7.8, runtime: 122 },
];

function seedLibrary() {
  const db = t.app.ctx.dbHandle.sqlite;
  const addMedia = db.prepare('INSERT INTO media (kind, tmdb_id, title, year, overview, backdrop_path, genres, rating, runtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const addItem = db.prepare("INSERT INTO library_items (server, external_key, kind, title, year, tmdb_id) VALUES ('plex', ?, ?, ?, ?, ?)");
  for (const m of MOVIES) {
    addMedia.run('movie', m.id, m.title, m.year, `${m.title} is a film about many things that happen to the people in ${m.title}, told over two hours.`, `/scene-${m.id}.jpg`, JSON.stringify(m.genres), m.rating, m.runtime);
    addItem.run(String(m.id), 'movie', m.title, m.year, m.id);
  }
  addMedia.run('show', 82728, 'Bluey', 2018, 'A blue heeler puppy and her family turn everyday life into games.', '/bluey.jpg', JSON.stringify(['Animation', 'Kids']), 8.9, 7);
  const show = addItem.run('20', 'show', 'Bluey', 2018, 82728).lastInsertRowid;
  const ep = db.prepare('INSERT INTO library_episodes (library_item_id, season, episode, title, last_viewed_at) VALUES (?, 1, ?, ?, ?)');
  for (let e = 1; e <= 4; e++) ep.run(show, e, `Episode ${e}`, Date.now() - e * HOUR);
  db.prepare('UPDATE library_items SET view_count = 1, last_viewed_at = ? WHERE kind = ? AND tmdb_id IN (2, 3)').run(Date.now() - HOUR, 'movie');
}

beforeAll(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  const k = await createUser(owner, 'kid', 'user');
  kidId = k.id;
  kid = new Client(t.app);
  await kid.login('kid', k.password);
  const o = await createUser(owner, 'sibling', 'user');
  other = new Client(t.app);
  await other.login('sibling', o.password);
  const m = await createUser(owner, 'parent', 'manager');
  manager = new Client(t.app);
  await manager.login('parent', m.password);
});
afterAll(async () => t.close());

describe('games', () => {
  it('needs titles on the servers before anyone can play', async () => {
    const res = await kid.req('POST', '/api/games/trivia/rounds');
    expect(res.statusCode).toBe(409);
    seedLibrary();
  });

  it('never sends the answers, scores a round once, and only for its player', async () => {
    const res = await kid.req('POST', '/api/games/trivia/rounds');
    expect(res.statusCode).toBe(200);
    const round = res.json() as { id: string; questions: { prompt: string; choices: string[] }[] };
    expect(round.questions).toHaveLength(5);
    expect(JSON.stringify(round)).not.toContain('"answer"');
    for (const q of round.questions) expect(q.choices).toHaveLength(4);

    const stored = t.app.ctx.dbHandle.sqlite.prepare('SELECT questions FROM game_rounds WHERE id = ?').get(round.id) as { questions: string };
    const answers = (JSON.parse(stored.questions) as GameQuestion[]).map((q) => q.answer);

    expect((await other.req('POST', `/api/games/rounds/${round.id}/answers`, { answers })).statusCode).toBe(404);
    expect((await kid.req('POST', `/api/games/rounds/${round.id}/answers`, { answers: [7] })).statusCode).toBe(400);
    const scored = await kid.req('POST', `/api/games/rounds/${round.id}/answers`, { answers });
    expect(scored.json()).toMatchObject({ score: 5, total: 5, streak: { current: 1, best: 1 } });
    expect((await kid.req('POST', `/api/games/rounds/${round.id}/answers`, { answers })).statusCode).toBe(409);
  });

  it('shows scenes for the scene game and expires old rounds', async () => {
    const round = (await kid.req('POST', '/api/games/scene/rounds')).json() as { id: string; questions: { image: string; choices: string[] }[] };
    expect(round.questions.every((q) => q.image.startsWith('/') && q.choices.length === 4)).toBe(true);
    t.app.ctx.dbHandle.sqlite.prepare('UPDATE game_rounds SET created_at = ? WHERE id = ?').run(Date.now() - 2 * HOUR, round.id);
    expect((await kid.req('POST', `/api/games/rounds/${round.id}/answers`, { answers: [0, 0, 0, 0, 0] })).statusCode).toBe(410);
    expect((await kid.req('POST', '/api/games/nope/rounds')).statusCode).toBe(400);
  });

  it('puts the right answer among the choices', () => {
    const titles = MOVIES.map((m) => ({ kind: 'movie' as const, tmdbId: m.id, title: m.title, year: m.year, overview: `${m.title} is about ${m.title} and lots more besides, as you would expect.`, backdropPath: `/x${m.id}.jpg`, rating: m.rating, runtime: m.runtime, genres: JSON.stringify(m.genres) }));
    for (let i = 0; i < 20; i++) {
      for (const q of buildQuestions('trivia', titles)!) {
        expect(new Set(q.choices).size).toBe(4);
        expect(q.choices[q.answer]).toBeDefined();
        // The plot question never gives the title away.
        if (q.detail) expect(q.detail).not.toContain(q.title);
      }
    }
    expect(buildQuestions('trivia', titles.slice(0, 3))).toBeNull();
  });

  it('ranks the week on the leaderboard', async () => {
    const board = (await other.req('GET', '/api/games/leaderboard')).json();
    expect(board.week).toEqual([{ userId: kidId, name: 'kid', rounds: 1, correct: 5, best: 5, perfect: 1 }]);
    expect(board.streak).toEqual({ current: 0, best: 0 });
  });
});

describe('ratings', () => {
  it('lets everyone rate and review, and shows the family score', async () => {
    expect((await kid.req('PUT', '/api/ratings/movie/1', { stars: 5, review: 'Marmalade!' })).json().family).toEqual({ average: 5, count: 1 });
    expect((await other.req('PUT', '/api/ratings/movie/1', { stars: 4 })).json().family).toEqual({ average: 4.5, count: 2 });
    await kid.req('PUT', '/api/ratings/movie/2', { stars: 2 });
    const res = (await other.req('GET', '/api/ratings/movie/1')).json();
    expect(res.family).toEqual({ average: 4.5, count: 2 });
    expect(res.mine).toEqual({ stars: 4, review: null });
    expect(res.ratings.map((r: { name: string }) => r.name).sort()).toEqual(['kid', 'sibling']);
  });

  it('checks the stars and the title', async () => {
    expect((await kid.req('PUT', '/api/ratings/movie/1', { stars: 6 })).statusCode).toBe(400);
    expect((await kid.req('PUT', '/api/ratings/movie/1', { stars: 3, review: 'x'.repeat(2001) })).statusCode).toBe(400);
    expect((await kid.req('PUT', '/api/ratings/movie/999999', { stars: 3 })).statusCode).toBe(404);
  });

  it('lists family favorites, and nothing to recommend without TMDB', async () => {
    const fav = (await kid.req('GET', '/api/ratings/favorites')).json().items;
    // Two people rate, so a title needs two ratings: Alien only has one.
    expect(fav.map((f: { title: string; average: number }) => [f.title, f.average])).toEqual([['Paddington', 4.5]]);
    expect(fav[0].availability.status).toBe('on_server');
    expect((await kid.req('GET', '/api/ratings/because')).json()).toEqual({ basedOn: null, results: [] });
  });

  it("only lets a manager remove someone else's review, and audits it", async () => {
    expect((await other.req('DELETE', `/api/ratings/movie/1/users/${kidId}`)).statusCode).toBe(403);
    expect((await manager.req('DELETE', `/api/ratings/movie/1/users/${kidId}`)).statusCode).toBe(200);
    expect((await manager.req('DELETE', `/api/ratings/movie/1/users/${kidId}`)).statusCode).toBe(404);
    const audit = (await owner.req('GET', '/api/audit')).json() as { action: string; target: string }[];
    expect(audit.find((a) => a.action === 'rating.removed')).toMatchObject({ target: 'movie:1' });
    await kid.req('PUT', '/api/ratings/movie/1', { stars: 5, review: 'Still great' });
    // People can take back their own.
    await other.req('DELETE', '/api/ratings/movie/1');
    expect((await kid.req('GET', '/api/ratings/movie/1')).json().family).toEqual({ average: 5, count: 1 });
  });
});

describe('movie nights', () => {
  let nightId: number;

  it('lets anyone plan one, and the host is coming', async () => {
    expect((await kid.req('POST', '/api/movie-nights', { kind: 'movie', tmdbId: 4, startsAt: Date.now() - 5 * HOUR })).statusCode).toBe(400);
    expect((await kid.req('POST', '/api/movie-nights', { kind: 'movie', tmdbId: 999999, startsAt: Date.now() + HOUR })).statusCode).toBe(404);
    const res = await kid.req('POST', '/api/movie-nights', { kind: 'movie', tmdbId: 4, startsAt: Date.now() + 3 * HOUR, note: 'Bring snacks' });
    expect(res.statusCode).toBe(200);
    const night = res.json();
    nightId = night.id;
    expect(night).toMatchObject({ title: 'Up', hostName: 'kid', note: 'Bring snacks', mine: true, myAnswer: 'yes' });
  });

  it('takes RSVPs from everyone', async () => {
    const res = await other.req('PUT', `/api/movie-nights/${nightId}/rsvp`, { answer: 'maybe' });
    expect(res.json()).toMatchObject({ mine: false, myAnswer: 'maybe' });
    expect((await other.req('PUT', `/api/movie-nights/${nightId}/rsvp`, { answer: 'never' })).statusCode).toBe(400);
    const list = (await owner.req('GET', '/api/movie-nights')).json();
    expect(list[0].rsvps.map((r: { name: string; answer: string }) => `${r.name}:${r.answer}`).sort()).toEqual(['kid:yes', 'sibling:maybe']);
  });

  it('only lets the host or a manager change or cancel it', async () => {
    expect((await other.req('PATCH', `/api/movie-nights/${nightId}`, { note: 'hijacked' })).statusCode).toBe(403);
    expect((await other.req('DELETE', `/api/movie-nights/${nightId}`)).statusCode).toBe(403);
    expect((await kid.req('PATCH', `/api/movie-nights/${nightId}`, { note: 'Pizza instead' })).json().note).toBe('Pizza instead');
    expect((await manager.req('PATCH', `/api/movie-nights/${nightId}`, { startsAt: Date.now() + 30 * 60 * 1000 })).statusCode).toBe(200);
  });

  it('reminds people once, within the hour before', async () => {
    expect(remindMovieNights(t.app.ctx)).toBe(1);
    expect(remindMovieNights(t.app.ctx)).toBe(0);
  });

  it('counts towards badges once it has happened', async () => {
    t.app.ctx.dbHandle.sqlite.prepare('UPDATE movie_nights SET starts_at = ? WHERE id = ?').run(Date.now() - HOUR, nightId);
    const { badges } = (await kid.req('GET', '/api/badges')).json() as { badges: { id: string; earned: boolean }[] };
    const earned = badges.filter((b) => b.earned).map((b) => b.id);
    expect(earned).toEqual(expect.arrayContaining(['first-rating', 'host', 'trivia-perfect']));
    expect(earned).not.toContain('scene-perfect');
    expect(earned).not.toContain('first-request');
  });

  it('can be cancelled by its host', async () => {
    const n = (await other.req('POST', '/api/movie-nights', { kind: 'show', tmdbId: 82728, startsAt: Date.now() + 48 * HOUR })).json();
    expect((await kid.req('DELETE', `/api/movie-nights/${n.id}`)).statusCode).toBe(403);
    expect((await other.req('DELETE', `/api/movie-nights/${n.id}`)).statusCode).toBe(200);
  });
});

describe('Wrapped', () => {
  it("sums up the household's year and the caller's own", async () => {
    const res = await kid.req('GET', '/api/wrapped');
    expect(res.statusCode).toBe(200);
    const w = res.json();
    expect(w.household).toMatchObject({ movies: 2, shows: 1, episodes: 4, topShow: { title: 'Bluey', episodes: 4 } });
    expect(w.household.hours).toBe(Math.round((117 + 170 + 4 * 7) / 60));
    expect(w.you).toMatchObject({ ratings: 2, reviews: 1, averageStars: 3.5, favorite: { title: 'Paddington', stars: 5 }, nightsHosted: 1, nightsAttended: 1, rounds: 1, correct: 5, perfectRounds: 1 });
    expect(w.you.persona.name).toBeTruthy();
    expect(w.you.badges.length).toBeGreaterThan(0);
    expect((await kid.req('GET', '/api/wrapped?year=2005')).json().household.movies).toBe(0);
    expect((await kid.req('GET', '/api/wrapped?year=3000')).statusCode).toBe(400);
    expect((await kid.req('GET', '/api/wrapped?month=13')).statusCode).toBe(400);
  });

  it('picks a raccoon persona from the favourite genre', () => {
    expect(personaFor('Horror').name).toBe('The Midnight Bandit');
    expect(personaFor('Sci-Fi & Fantasy').name).toBe('The Starry-Eyed Scavenger');
    expect(personaFor(null).name).toBe('The All-Night Snacker');
  });

  it('accepts the new homepage rows', async () => {
    const rows = [{ type: 'family_favorites' }, { type: 'because_you_liked' }, { type: 'movie_nights' }];
    expect((await kid.req('PUT', '/api/home/layout', { rows })).json()).toEqual({ rows, custom: true });
  });
});
