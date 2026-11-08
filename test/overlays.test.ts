import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, PLEX } from './fakes.js';
import { applyOverlays, badgesFor, overlaySvg } from '../src/server/posters/overlays.js';

const TMDB_POSTER = 'https://image.tmdb.org/t/p/w780/paddington.jpg';

describe('poster overlays', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let uploads: { key: string; type: string; body: Buffer }[];
  let posterFetches: number;
  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    uploads = [];
    posterFetches = 0;
    const poster = await sharp({ create: { width: 500, height: 750, channels: 3, background: '#2050a0' } }).jpeg().toBuffer();
    fakeFetch({
      [TMDB_POSTER]: () => (posterFetches++, new Response(new Uint8Array(poster), { headers: { 'content-type': 'image/jpeg' } })),
      [`${PLEX}/library/metadata/`]: (url: URL, init?: RequestInit) => {
        uploads.push({ key: url.pathname.split('/')[3]!, type: new Headers(init?.headers).get('content-type') ?? '', body: Buffer.from(init!.body as Uint8Array) });
        return new Response('');
      },
    });
    await owner.req('PUT', '/api/settings/plex', { enabled: true, url: PLEX, token: 'tok' });
    const db = t.app.ctx.dbHandle.sqlite;
    db.prepare("INSERT INTO media (kind, tmdb_id, title, year, poster_path, rating) VALUES ('movie', 116149, 'Paddington', 2014, '/paddington.jpg', 7.6), ('movie', 2, 'No Poster', 2000, NULL, 6)").run();
    db.prepare("INSERT INTO library_items (server, external_key, kind, title, tmdb_id, resolution, added_at) VALUES ('plex', '10', 'movie', 'Paddington', 116149, '2160p', ?), ('plex', '11', 'movie', 'No Poster', 2, '1080p', 0)").run(Date.now());
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('works out badges from the library and settings', () => {
    const m = { rating: 7.64, tmdbStatus: 'Ended', certification: 'PG' } as never;
    expect(badgesFor(t.app.ctx, { kind: 'movie', resolution: '2160p', addedAt: Date.now(), media: m })).toEqual({ resolution: '4K', rating: '7.6', isNew: 'New' });
    t.app.ctx.settings.update('overlays', { showStatus: true, certification: true, rating: false, newDays: 0 });
    expect(badgesFor(t.app.ctx, { kind: 'show', resolution: '1080p', addedAt: Date.now(), media: m })).toEqual({ resolution: '1080p', status: 'Ended', certification: 'PG' });
    // Text is escaped in the drawing.
    expect(overlaySvg({ certification: '<b>' })).toContain('&#60;b&#62;');
  });

  it('does nothing while off, then draws each poster once and redraws only what changed', async () => {
    expect(await applyOverlays(t.app.ctx)).toBeNull();
    expect(uploads).toHaveLength(0);

    t.app.ctx.settings.update('overlays', { enabled: true });
    const first = await applyOverlays(t.app.ctx);
    expect(first).toMatchObject({ updated: 1, failed: 0 });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.key).toBe('10');
    expect(uploads[0]!.type).toBe('image/jpeg');
    const meta = await sharp(uploads[0]!.body).metadata();
    expect([meta.width, meta.height]).toEqual([1000, 1500]);

    // Nothing changed: no download, no upload.
    await applyOverlays(t.app.ctx);
    expect(uploads).toHaveLength(1);
    expect(posterFetches).toBe(1);

    // A setting change redraws.
    t.app.ctx.settings.update('overlays', { rating: false });
    await applyOverlays(t.app.ctx);
    expect(uploads).toHaveLength(2);
  });

  it('lets admins preview, run and remove, and keeps it from managers', async () => {
    t.app.ctx.settings.update('overlays', { enabled: true });
    const status = (await owner.req('GET', '/api/overlays')).json();
    expect(status).toMatchObject({ enabled: true, applied: 0, sample: { kind: 'movie', tmdbId: 116149 } });
    const preview = await owner.req('GET', '/api/overlays/preview/movie/116149');
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/jpeg');
    expect(uploads).toHaveLength(0); // a preview never reaches a server
    expect((await owner.req('GET', '/api/overlays/preview/movie/2')).statusCode).toBe(404);

    expect((await owner.req('POST', '/api/overlays/run')).json()).toEqual({ started: true });
    await vi.waitFor(() => expect((t.app.ctx.dbHandle.sqlite.prepare('SELECT count(*) AS n FROM poster_overlays').get() as { n: number }).n).toBe(1));
    await vi.waitFor(async () => expect((await owner.req('GET', '/api/overlays')).json().running).toBe(false));

    expect((await owner.req('POST', '/api/overlays/remove')).json()).toEqual({ started: true });
    await vi.waitFor(() => expect((t.app.ctx.dbHandle.sqlite.prepare('SELECT count(*) AS n FROM poster_overlays').get() as { n: number }).n).toBe(0));
    expect(uploads).toHaveLength(2); // the clean poster went back

    const u = await createUser(owner, 'mgr', 'manager');
    const c = new Client(t.app);
    await c.login('mgr', u.password);
    expect((await c.req('GET', '/api/overlays')).statusCode).toBe(403);
    expect((await c.req('GET', '/api/overlays/preview/movie/116149')).statusCode).toBe(403);
    expect((await c.req('POST', '/api/overlays/run')).statusCode).toBe(403);
    expect((await c.req('POST', '/api/overlays/remove')).statusCode).toBe(403);
    expect((await c.req('PUT', '/api/settings/overlays', { enabled: false })).statusCode).toBe(403);
  });

  it("won't fetch a chosen poster from an unknown host", async () => {
    t.app.ctx.dbHandle.sqlite.prepare("UPDATE media SET poster_override = 'https://internal.example/x.jpg' WHERE tmdb_id = 116149").run();
    t.app.ctx.settings.update('overlays', { enabled: true });
    await applyOverlays(t.app.ctx);
    // It used TMDB's poster instead.
    expect(posterFetches).toBe(1);
    expect(uploads).toHaveLength(1);
  });
});
