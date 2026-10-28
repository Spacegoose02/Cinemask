import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, makeApp, setupOwner } from './helpers.js';
import { BINGEBANDIT, bingeBanditCollections, bingeBanditFiles, bingeBanditRoutes, fakeFetch, tmdbRoutes } from './fakes.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
  await owner.req('PUT', '/api/settings/bingebandit', { enabled: true, url: BINGEBANDIT, apiKey: 'bb_secret' });
  await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'tmdb-key' });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

describe('BingeBandit library quality', () => {
  it('reads every file once from the admin file list instead of opening each title', async () => {
    const { calls } = fakeFetch({ ...bingeBanditRoutes, ...bingeBanditFiles, ...tmdbRoutes });
    await t.librarySync.run();
    expect(t.librarySync.status.results.bingebandit).toMatchObject({ ok: true, movies: 1, episodes: 2 });
    expect((await owner.req('GET', '/api/media/movie/116149')).json().availability.resolution).toBe('1080p');
    const eps = t.app.ctx.dbHandle.sqlite.prepare('select episode, resolution from library_episodes order by episode').all();
    expect(eps).toEqual([
      { episode: 1, resolution: '2160p' },
      { episode: 2, resolution: '720p' },
    ]);
    // Seasons are still read for episode names and plays, but no movie or episode page is.
    expect(calls.filter((u) => /\/api\/items\/(100|202|203)$/.test(new URL(u).pathname))).toEqual([]);
  });
});

describe('BingeBandit collections', () => {
  const sync = async (routes: Record<string, (url: URL, init?: RequestInit) => unknown>) => {
    const f = fakeFetch({ ...bingeBanditRoutes, ...bingeBanditFiles, ...tmdbRoutes, ...routes });
    await t.librarySync.run();
    return f;
  };

  it('imports hand-picked collections to sync back, and smart ones as copies', async () => {
    const bb = bingeBanditCollections(
      [
        { id: 5, libraryId: 1, name: 'Bears', overview: 'Ursine films', mode: '', poster: '/api/images/tmdb/bears.jpg' },
        { id: 6, libraryId: 1, name: 'Kids picks', overview: '', mode: '', labelRule: 'Kids' },
        { id: 7, libraryId: 2, name: 'Empty', overview: '', mode: '' },
      ],
      { 5: [100], 6: [100] },
    );
    await sync(bb.routes);
    expect((await owner.req('POST', '/api/collections/import', { server: 'bingebandit' })).json()).toEqual({ imported: 2, updated: 0 });
    const cols = (await owner.req('GET', '/api/collections')).json() as { name: string; source: string; poster: string; library: string; syncBingebandit: boolean; description: string | null }[];
    const bears = cols.find((c) => c.name === 'Bears')!;
    expect(bears).toMatchObject({ source: 'bingebandit', poster: 'bingebandit:/api/images/tmdb/bears.jpg', library: 'Movies', syncBingebandit: true, description: 'Ursine films' });
    expect(cols.find((c) => c.name === 'Kids picks')).toMatchObject({ syncBingebandit: false });
    // Importing again updates instead of copying.
    expect((await owner.req('POST', '/api/collections/import', { server: 'bingebandit' })).json()).toEqual({ imported: 0, updated: 2 });

    // The cover shows through the image proxy, and only image paths of that shape are fetched.
    const img = await owner.req('GET', `/api/images?src=${encodeURIComponent('bingebandit:/api/images/tmdb/bears.jpg')}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    for (const src of ['bingebandit:/api/images/tmdb/../admin/users', 'bingebandit:/api/admin/users']) {
      expect((await owner.req('GET', `/api/images?src=${encodeURIComponent(src)}`)).statusCode).toBe(400);
    }
  });

  it('pushes a collection with its cover, then renames it and takes titles out', async () => {
    const bb = bingeBanditCollections();
    const { fn } = await sync(bb.routes);
    const col = (
      await owner.req('POST', '/api/collections', { name: 'Bears', description: 'Ursine films', poster: '/bears.jpg', syncBingebandit: true, items: [{ kind: 'movie', tmdbId: 116149 }, { kind: 'movie', tmdbId: 555 }] })
    ).json();
    const pushed = (await owner.req('POST', `/api/collections/${col.id}/push`, {})).json();
    expect(pushed.bingebandit).toEqual({ added: 1, removed: 0, notOnServer: 1 });
    const made = bb.cols.find((c) => c.name === 'Bears')!;
    expect(made).toMatchObject({ libraryId: 1, poster: 'https://image.tmdb.org/t/p/original/bears.jpg' });
    expect([...made.members]).toEqual([100]);
    expect(JSON.parse(t.app.ctx.dbHandle.sqlite.prepare('select bingebandit_ids from collections where id = ?').pluck().get(col.id) as string)).toEqual([made.id]);

    // Renamed here: renamed there, keeping the same BingeBandit collection.
    await owner.req('PUT', `/api/collections/${col.id}`, { name: 'Bear films' });
    await owner.req('POST', `/api/collections/${col.id}/push`, {});
    expect(made).toMatchObject({ name: 'Bear films', overview: 'Ursine films' });
    expect(bb.cols).toHaveLength(1);

    // A title taken out here leaves the BingeBandit collection too, and its other collections stay.
    bb.cols.push({ id: 9, libraryId: 1, name: 'Favourites', overview: '', mode: '', members: new Set([100]) });
    await owner.req('DELETE', `/api/collections/${col.id}/items/movie/116149`);
    const r = (await owner.req('POST', `/api/collections/${col.id}/push`, {})).json();
    expect(r.bingebandit).toMatchObject({ removed: 1 });
    expect([...made.members]).toEqual([]);
    expect([...bb.cols.find((c) => c.id === 9)!.members]).toEqual([100]);
    expect(fn.mock.calls.some(([u]) => String(u).includes('bb_secret'))).toBe(false);
  });

  it("leaves a BingeBandit smart collection of the same name alone", async () => {
    const bb = bingeBanditCollections([{ id: 5, libraryId: 1, name: 'Bears', overview: '', mode: '', labelRule: 'Bears' }]);
    await sync(bb.routes);
    const col = (await owner.req('POST', '/api/collections', { name: 'Bears', syncBingebandit: true, items: [{ kind: 'movie', tmdbId: 116149 }] })).json();
    const res = await owner.req('POST', `/api/collections/${col.id}/push`, {});
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain('picks its titles by rules or a list');
  });
});
