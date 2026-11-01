import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';
import { decide } from '../src/server/arr/decision.js';
import type { Release } from '../src/server/arr/indexers.js';
import type { Profile } from '../src/server/arr/profiles.js';

const PADDINGTON = 116149;
const FUTURE = 555;
const BLUEY = 82728;

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
let kid: Client;
let kidId: number;
let sib: Client;

const providers = (flatrate: { provider_id: number; provider_name: string }[]) => () => ({ results: { US: { link: 'https://tmdb/watch', flatrate: flatrate.map((p) => ({ ...p, logo_path: '/l.png' })) } } });

beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  fakeFetch({
    ...tmdbRoutes,
    [`https://api.themoviedb.org/3/movie/${PADDINGTON}/watch/providers`]: providers([{ provider_id: 8, provider_name: 'Netflix' }]),
    [`https://api.themoviedb.org/3/movie/${FUTURE}/watch/providers`]: providers([]),
  });
  await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
  const k = await createUser(owner, 'kid', 'user');
  kidId = k.id;
  kid = new Client(t.app);
  await kid.login('kid', k.password);
  const s = await createUser(owner, 'sib', 'user');
  sib = new Client(t.app);
  await sib.login('sib', s.password);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

const askMovie = (c: Client, tmdbId: number, extra: object = {}) => c.req('POST', '/api/requests', { kind: 'movie', tmdbId, ...extra });
const askShow = (c: Client, seasons: number[] | null) => c.req('POST', '/api/requests', { kind: 'show', tmdbId: BLUEY, seasons });

describe('request limits', () => {
  it('stops a user at the movie limit, with a readable message, and shows what is left', async () => {
    await owner.req('PUT', '/api/settings/requests', { movieLimit: 1 });
    expect((await kid.req('GET', '/api/requests/quota')).json().movies).toMatchObject({ limit: 1, used: 0, remaining: 1 });
    expect((await askMovie(kid, PADDINGTON)).statusCode).toBe(200);
    const over = await askMovie(kid, FUTURE);
    expect(over.statusCode).toBe(429);
    expect(over.json().error).toMatch(/used all 1 movie requests/);
    expect((await kid.req('GET', '/api/requests/quota')).json().movies).toMatchObject({ used: 1, remaining: 0 });
  });

  it("doesn't count declined requests, and never limits managers", async () => {
    await owner.req('PUT', '/api/settings/requests', { movieLimit: 1 });
    const r = (await askMovie(kid, PADDINGTON)).json();
    await owner.req('POST', `/api/requests/${r.id}/decline`, {});
    expect((await askMovie(kid, FUTURE)).statusCode).toBe(200);
    const q = (await owner.req('GET', '/api/requests/quota')).json();
    expect(q).toMatchObject({ exempt: true, movies: { limit: 0 } });
  });

  it('a per-user limit overrides the default, and 0 means no limit', async () => {
    await owner.req('PUT', '/api/settings/requests', { movieLimit: 1 });
    await owner.req('PATCH', `/api/users/${kidId}`, { movieRequestLimit: 0 });
    expect((await askMovie(kid, PADDINGTON)).statusCode).toBe(200);
    expect((await askMovie(kid, FUTURE)).statusCode).toBe(200);
  });

  it('counts show seasons, including seasons added to a waiting request', async () => {
    await owner.req('PUT', '/api/settings/requests', { seasonLimit: 1 });
    expect((await askShow(kid, [1])).statusCode).toBe(200);
    const more = await askShow(kid, [2]);
    expect(more.statusCode).toBe(429);
    expect(more.json().error).toMatch(/season/);
  });

  it("users can't change their own limits", async () => {
    expect((await kid.req('PATCH', `/api/users/${kidId}`, { movieRequestLimit: 0 })).statusCode).toBe(403);
  });
});

describe('me too', () => {
  it('a second person asking for the same title follows the first request instead of making a new one', async () => {
    const first = (await askMovie(sib, PADDINGTON)).json();
    const again = (await askMovie(kid, PADDINGTON)).json();
    expect(again).toMatchObject({ id: first.id, following: true });
    const mine = (await kid.req('GET', '/api/requests')).json();
    expect(mine).toEqual([expect.objectContaining({ id: first.id, following: true })]);
    expect((await sib.req('GET', '/api/requests')).json()[0]).toMatchObject({ followers: 1, following: false });
    // A follower can't cancel someone else's request, only stop following it.
    expect((await kid.req('DELETE', `/api/requests/${first.id}`)).statusCode).toBe(403);
    await kid.req('DELETE', `/api/requests/${first.id}/follow`);
    expect((await kid.req('GET', '/api/requests')).json()).toEqual([]);
  });
});

describe('4K requests and notes', () => {
  it('only people allowed to can ask for 4K', async () => {
    expect((await askMovie(kid, PADDINGTON, { fourK: true })).statusCode).toBe(403);
    expect((await kid.req('GET', '/api/requests/quota')).json().canRequest4k).toBe(false);
    await owner.req('PATCH', `/api/users/${kidId}`, { canRequest4k: true });
    const r = await askMovie(kid, PADDINGTON, { fourK: true, note: 'The bear one' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ fourK: true, note: 'The bear one', status: 'pending' });
  });

  it('a 4K request is separate from an HD one, and approval uses the 4K profile', async () => {
    await owner.req('PATCH', `/api/users/${kidId}`, { canRequest4k: true });
    const profiles = (await owner.req('GET', '/api/profiles')).json() as { id: number; name: string }[];
    const uhd = profiles.find((p) => /2160|UHD|4K/i.test(p.name)) ?? profiles[profiles.length - 1]!;
    await owner.req('PUT', '/api/settings/requests', { fourKMovieProfile: uhd.id });
    const hd = (await askMovie(sib, PADDINGTON)).json();
    const fourK = (await askMovie(kid, PADDINGTON, { fourK: true })).json();
    expect(fourK.id).not.toBe(hd.id);
    await owner.req('POST', `/api/requests/${fourK.id}/approve`, {});
    const mon = (await owner.req('GET', `/api/monitored/lookup/movie/${PADDINGTON}`)).json().monitored;
    expect(mon.profileId).toBe(uhd.id);
  });
});

describe('already streaming', () => {
  it('tells everyone where it streams, and can block user requests for it', async () => {
    expect((await kid.req('GET', `/api/requests/streaming/movie/${PADDINGTON}`)).json()).toMatchObject({ mode: 'warn', hit: { providers: [{ id: 8, name: 'Netflix' }] } });
    expect((await askMovie(kid, PADDINGTON)).statusCode).toBe(200);
    await owner.req('PUT', '/api/settings/requests', { streaming: 'block' });
    const blocked = await askMovie(sib, FUTURE);
    expect(blocked.statusCode).toBe(200); // not streaming anywhere
    await kid.req('DELETE', `/api/requests/${(await kid.req('GET', '/api/requests')).json()[0].id}`);
    const refused = await askMovie(kid, PADDINGTON);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/Netflix/);
    // Only the household's own services count once some are picked.
    await owner.req('PUT', '/api/settings/requests', { streamingProviders: [337] });
    expect((await askMovie(kid, PADDINGTON)).statusCode).toBe(200);
  });
});

describe('requester progress', () => {
  it('says where an approved request has got to', async () => {
    const r = (await askMovie(kid, FUTURE)).json();
    await owner.req('POST', `/api/requests/${r.id}/approve`, {});
    const [row] = (await kid.req('GET', '/api/requests')).json();
    expect(row.progress).toMatchObject({ state: 'unreleased' });
    const pending = (await askMovie(kid, PADDINGTON)).json();
    expect((await kid.req('GET', '/api/requests')).json().find((x: { id: number }) => x.id === pending.id).progress).toBeNull();
  });
});

describe('delay profile', () => {
  const profile: Profile = { id: 1, name: 'HD', qualities: ['WEBDL-720p', 'WEBDL-1080p', 'Bluray-1080p'], cutoff: 'Bluray-1080p', upgradesAllowed: true, language: 'any' };
  const target = { kind: 'movie' as const, title: 'Paddington', year: 2014 };
  const rel = (title: string, protocol: 'usenet' | 'torrent', ageMin: number): Release =>
    ({ guid: title, title, protocol, size: 4e9, seeders: 10, indexer: 'x', downloadUrl: 'http://x', publishedAt: NOW - ageMin * 60_000 }) as Release;
  const NOW = Date.parse('2026-11-01T12:00:00Z');
  const opts = { delay: { usenet: 0, torrent: 120, bypassAtCutoff: true }, now: NOW };

  it('holds a new torrent back until the delay is over', () => {
    const d = decide(rel('Paddington.2014.1080p.WEB-DL', 'torrent', 30), target, profile, new Set(), opts);
    expect(d.accepted).toBe(false);
    expect(d.rejections[0]).toMatch(/Waiting 90 more min/);
    expect(d.delayedUntil).toBe(NOW + 90 * 60_000);
    expect(decide(rel('Paddington.2014.1080p.WEB-DL', 'torrent', 150), target, profile, new Set(), opts).accepted).toBe(true);
  });

  it("doesn't wait for a release already at the cutoff, or for Usenet with no delay", () => {
    expect(decide(rel('Paddington.2014.1080p.BluRay.x264', 'torrent', 1), target, profile, new Set(), opts).accepted).toBe(true);
    expect(decide(rel('Paddington.2014.1080p.WEB-DL', 'usenet', 1), target, profile, new Set(), opts).accepted).toBe(true);
  });

  it('prefers the chosen protocol between equal releases', () => {
    const u = decide(rel('Paddington.2014.1080p.WEB-DL-A', 'usenet', 500), target, profile, new Set(), { preferredProtocol: 'usenet' });
    const tor = decide(rel('Paddington.2014.1080p.WEB-DL-B', 'torrent', 500), target, profile, new Set(), { preferredProtocol: 'usenet' });
    expect(u.score).toBeGreaterThan(tor.score);
  });
});
