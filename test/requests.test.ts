import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, PLEX, plexRoutes, tmdbRoutes } from './fakes.js';

const BLUEY = 82728;

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
let kid: Client;
let sib: Client;

beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  fakeFetch({ ...plexRoutes, ...tmdbRoutes });
  await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
  for (const [name, set] of [
    ['kid', (c: Client) => (kid = c)],
    ['sib', (c: Client) => (sib = c)],
  ] as const) {
    const u = await createUser(owner, name, 'user');
    const c = new Client(t.app);
    await c.login(name, u.password);
    set(c);
  }
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

const ask = async (c: Client, seasons: number[] | null) => (await c.req('POST', '/api/requests', { kind: 'show', tmdbId: BLUEY, seasons })).json();
const seasonsOf = (r: { seasons: string | null }) => (r.seasons ? JSON.parse(r.seasons) : null);

describe('show requests', () => {
  it('adds new seasons to your own waiting request instead of dropping them', async () => {
    const first = await ask(kid, [1]);
    expect(await ask(kid, [1])).toMatchObject({ id: first.id });
    const more = await ask(kid, [2]);
    expect(more.id).toBe(first.id);
    expect(seasonsOf(more)).toEqual([1, 2]);
  });

  it('asks again for seasons an approved request did not cover, and only those', async () => {
    const first = await ask(kid, [1]);
    await owner.req('POST', `/api/requests/${first.id}/approve`, {});
    expect((await ask(kid, [1])).id).toBe(first.id);
    const next = await ask(kid, [1, 2]);
    expect(next.id).not.toBe(first.id);
    expect(next.status).toBe('pending');
    expect(seasonsOf(next)).toEqual([2]);
  });

  it("doesn't fold someone else's waiting request into yours", async () => {
    const theirs = await ask(sib, [1]);
    const mine = await ask(kid, [2]);
    expect(mine.id).not.toBe(theirs.id);
    expect(seasonsOf(mine)).toEqual([2]);
    expect((await kid.req('GET', '/api/requests')).json().map((r: { id: number }) => r.id)).toEqual([mine.id]);
  });

  it('a request for every season covers any later one', async () => {
    const all = await ask(kid, null);
    expect((await ask(kid, [3])).id).toBe(all.id);
  });

  it('the title page lists the open seasons, and shows a declined request with its reason', async () => {
    const one = await ask(kid, [1]);
    await owner.req('POST', `/api/requests/${one.id}/approve`, {});
    const two = await ask(kid, [2]);
    expect((await kid.req('GET', `/api/monitored/lookup/show/${BLUEY}`)).json().openRequest).toEqual({ seasons: [1, 2] });
    await owner.req('POST', `/api/requests/${two.id}/decline`, { reason: 'Not yet' });
    const lookup = (await kid.req('GET', `/api/monitored/lookup/show/${BLUEY}`)).json();
    expect(lookup.request).toMatchObject({ id: two.id, status: 'declined', reason: 'Not yet' });
    expect(lookup.openRequest).toEqual({ seasons: [1] });
  });

  it('is only ready once every aired episode of the requested seasons is on a server', async () => {
    const r = await ask(kid, [1]);
    await owner.req('POST', `/api/requests/${r.id}/approve`, {});
    await owner.req('PUT', '/api/settings/plex', { enabled: true, url: PLEX, token: 'plex-token' });
    // Plex has episodes 1 and 2 of season 1; TMDB lists three.
    await t.librarySync.run();
    expect((await kid.req('GET', '/api/requests')).json()[0].status).toBe('approved');

    const episodes = `${PLEX}/library/sections/2/all`;
    const withThird = (url: URL) => {
      const body = plexRoutes[episodes](url) as { MediaContainer: { Metadata: object[] } };
      if (url.searchParams.get('type') === '4') body.MediaContainer.Metadata.push({ ratingKey: '203', grandparentRatingKey: '20', parentIndex: 1, index: 3, title: 'Three', Media: [{ videoResolution: '1080' }] });
      return body;
    };
    fakeFetch({ ...plexRoutes, ...tmdbRoutes, [episodes]: withThird });
    await t.librarySync.run();
    expect((await kid.req('GET', '/api/requests')).json()[0].status).toBe('available');
  });
});
