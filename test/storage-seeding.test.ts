import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRelease } from '../src/server/arr/parser.js';
import { decide } from '../src/server/arr/decision.js';
import { cleanUpSeeding, trackDownloads } from '../src/server/arr/tracker.js';
import { defaultProfileId } from '../src/server/arr/profiles.js';
import { emptyOldRecycled, BIN_DIR } from '../src/server/files/recycle.js';
import { storageJob } from '../src/server/storage/service.js';
import { downloads, libraryItems, monitored, recycleBin } from '../src/server/db/schema.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, tmdbRoutes } from './fakes.js';

describe('anime numbering', () => {
  it('reads fansub names with absolute episode numbers', () => {
    expect(parseRelease('[SubsPlease] Sousou no Frieren - 12 (1080p) [A1B2C3D4].mkv')).toMatchObject({ title: 'Sousou no Frieren', absolute: [12], season: null, group: 'SubsPlease', resolution: '1080p' });
    expect(parseRelease('[Erai-raws] One Piece - 1100v2 [720p].mkv')).toMatchObject({ title: 'One Piece', absolute: [1100] });
    expect(parseRelease('[Group] Show - 01-03 [1080p]').absolute).toEqual([1, 2, 3]);
    // Ordinary names are untouched.
    expect(parseRelease('Show.S01E02.1080p.WEB-DL-GRP')).toMatchObject({ absolute: [], season: 1, episodes: [2] });
    expect(parseRelease('Movie - 2019 1080p').absolute).toEqual([]);
  });

  it('matches an absolute number to the season it falls in', () => {
    const profile = { id: 1, name: 'Any', qualities: ['WEBDL-1080p', 'Unknown'] as never, cutoff: 'WEBDL-1080p' as never, upgradesAllowed: true, language: 'any' };
    const target = { kind: 'show' as const, title: 'Sousou no Frieren', year: 2023, episodes: [{ season: 2, episode: 1, absolute: 29, currentQuality: null }] };
    const d = decide({ title: '[SubsPlease] Sousou no Frieren - 29 (1080p) [ABCDEF12]', guid: 'g', size: 1e9, indexer: 'x', protocol: 'torrent', link: 'l' } as never, target, profile as never, new Set());
    expect(d.covers).toEqual({ season: 2, episodes: [1] });
    expect(d.rejections).not.toContain('No season or episode in the name');
    const miss = decide({ title: '[SubsPlease] Sousou no Frieren - 30 (1080p)', guid: 'g2', size: 1e9, indexer: 'x', protocol: 'torrent', link: 'l' } as never, target, profile as never, new Set());
    expect(miss.rejections).toContain('No wanted episode numbered 30');
  });
});

const QBIT = 'http://qbit.local:8080';

describe('seeding goals and stalled downloads', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let torrents: Record<string, unknown>[] = [];
  const deleted: string[] = [];

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    torrents = [];
    deleted.length = 0;
    fakeFetch({
      ...tmdbRoutes,
      [`${QBIT}/api/v2/auth/login`]: () => new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } }),
      [`${QBIT}/api/v2/torrents/info`]: () => torrents,
      [`${QBIT}/api/v2/torrents/delete`]: (_u: URL, init?: RequestInit) => (deleted.push(String(init?.body)), new Response('')),
    });
    await owner.req('POST', '/api/download-clients', { name: 'qBit', type: 'qbittorrent', url: QBIT, username: 'a', password: 'b' });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  const addDownload = (values: Partial<typeof downloads.$inferInsert>) =>
    t.app.ctx.db
      .insert(downloads)
      .values({ clientId: 1, downloadId: 'h1', title: 'Some.Release.1080p', protocol: 'torrent', status: 'downloading', addedAt: Date.now(), category: 'cinemask', ...values })
      .returning()
      .get();

  it('keeps an imported torrent until it reaches the ratio or the time', async () => {
    await owner.req('PUT', '/api/settings/downloading', { seedRatio: 2, seedMinutes: 600 });
    const d = addDownload({ status: 'imported', seeding: true, importedAt: Date.now() });
    torrents = [{ hash: 'h1', name: 'x', progress: 1, state: 'uploading', size: 1, save_path: '/d', tags: 'mm-1', ratio: 1.2, seeding_time: 3600 }];
    expect(await cleanUpSeeding(t.app.ctx)).toBe(0);
    expect(deleted).toHaveLength(0);
    torrents = [{ ...torrents[0], ratio: 2.1 }];
    expect(await cleanUpSeeding(t.app.ctx)).toBe(1);
    expect(deleted[0]).toMatch(/hashes=h1/);
    expect(t.app.ctx.db.select().from(downloads).where(eq(downloads.id, d.id)).get()!.seeding).toBe(false);
  });

  it('gives up on a download that stops moving', async () => {
    await owner.req('PUT', '/api/settings/downloading', { stalledMinutes: 30 });
    const d = addDownload({ progress: 0.4, progressAt: Date.now() - 31 * 60_000 });
    torrents = [{ hash: 'h1', name: 'x', progress: 0.4, state: 'stalledDL', size: 1, save_path: '/d', tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);
    const row = t.app.ctx.db.select().from(downloads).where(eq(downloads.id, d.id)).get()!;
    expect(row).toMatchObject({ status: 'failed', error: 'Stalled: no progress for 30 minutes' });
    expect(deleted[0]).toMatch(/deleteFiles=true/);
  });

  it('leaves a download alone while it moves', async () => {
    await owner.req('PUT', '/api/settings/downloading', { stalledMinutes: 30 });
    const d = addDownload({ progress: 0.4, progressAt: Date.now() - 60 * 60_000 });
    torrents = [{ hash: 'h1', name: 'x', progress: 0.5, state: 'downloading', size: 1, save_path: '/d', tags: 'mm-1' }];
    await trackDownloads(t.app.ctx);
    const row = t.app.ctx.db.select().from(downloads).where(eq(downloads.id, d.id)).get()!;
    expect(row.status).toBe('downloading');
    expect(row.progressAt).toBeGreaterThan(Date.now() - 5000);
  });
});

describe('storage manager', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let movies: string;

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    movies = path.join(t.dir, 'media', 'movies');
    fs.mkdirSync(movies, { recursive: true });
    await owner.req('PUT', '/api/settings/media', { moviesPath: movies, tvPath: path.join(t.dir, 'media', 'tv') });
  });
  afterEach(async () => t.close());

  const addMovie = (title: string, tmdbId: number, extra: Partial<typeof monitored.$inferInsert> = {}) => {
    const folder = path.join(movies, title);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, `${title}.mkv`);
    fs.writeFileSync(file, 'x'.repeat(1000 * tmdbId));
    return t.app.ctx.db
      .insert(monitored)
      .values({ kind: 'movie', tmdbId, title, profileId: defaultProfileId(t.app.ctx, 'movie'), path: folder, filePath: file, fileQuality: 'WEBDL-1080p', addedAt: Date.now() - 400 * 86_400_000, ...extra })
      .returning()
      .get();
  };
  const watched = (tmdbId: number, viewCount: number, lastViewedAt: number | null) =>
    t.app.ctx.db.insert(libraryItems).values({ server: 'plex', externalKey: String(tmdbId), kind: 'movie', tmdbId, title: 'x', viewCount, lastViewedAt }).run();

  it('suggests long-unwatched titles, never kept ones, and frees them into the recycle bin', async () => {
    const old = addMovie('Old Watched', 3);
    addMovie('Never Watched', 2);
    const kept = addMovie('Kept One', 4, { keep: true });
    watched(3, 2, Date.now() - 300 * 86_400_000);
    watched(2, 0, null);
    watched(4, 0, null);
    const s = (await owner.req('GET', '/api/storage')).json() as { suggestions: { id: number; why: string }[]; largest: { title: string }[]; used: number };
    expect(s.largest.map((x) => x.title)).toEqual(['Kept One', 'Old Watched', 'Never Watched']);
    expect(s.used).toBe(9000);
    expect(s.suggestions.map((x) => x.id)).toEqual([old.id, old.id + 1]);
    expect(s.suggestions[0]!.why).toMatch(/Last watched 300 days ago/);

    const r = (await owner.req('POST', '/api/storage/free-up', { ids: [old.id, kept.id] })).json() as { removed: number; freed: number; skipped: string[] };
    expect(r).toMatchObject({ removed: 1, freed: 3000, skipped: ['Kept One: marked Keep'] });
    expect(fs.existsSync(path.join(movies, 'Old Watched'))).toBe(false);
    const bin = t.app.ctx.db.select().from(recycleBin).all();
    expect(bin).toHaveLength(1);
    expect(bin[0]!.binPath.startsWith(path.join(movies, BIN_DIR))).toBe(true);
    expect(t.app.ctx.db.select().from(monitored).where(eq(monitored.id, old.id)).get()).toMatchObject({ monitored: false, filePath: null });

    // Restore puts it back where it was.
    expect((await owner.req('POST', `/api/storage/recycle/${bin[0]!.id}/restore`, {})).statusCode).toBe(200);
    expect(fs.existsSync(path.join(movies, 'Old Watched', 'Old Watched.mkv'))).toBe(true);
    expect(t.app.ctx.db.select().from(recycleBin).all()).toHaveLength(0);
    expect(fs.readdirSync(path.join(movies, BIN_DIR))).toEqual([]);
  });

  it('deleting files uses the bin, which empties itself after the set days', async () => {
    const m = addMovie('Gone Soon', 1);
    expect((await owner.req('POST', `/api/monitored/${m.id}/delete-files`, { scope: 'movie' })).statusCode).toBe(200);
    const [item] = t.app.ctx.db.select().from(recycleBin).all();
    expect(item).toMatchObject({ title: 'Gone Soon', size: 1000, reason: 'Deleted', deletedByName: null });
    expect(fs.existsSync(item!.binPath)).toBe(true);
    expect(emptyOldRecycled(t.app.ctx, [movies])).toBe(0);
    t.app.ctx.db.update(recycleBin).set({ deletedAt: Date.now() - 31 * 86_400_000 }).run();
    expect(emptyOldRecycled(t.app.ctx, [movies])).toBe(1);
    expect(fs.existsSync(item!.binPath)).toBe(false);
  });

  it('with the bin off, files are deleted straight away; delete rules only run with it on', async () => {
    await owner.req('PUT', '/api/settings/storage', { recycleBin: false, autoDelete: true });
    const m = addMovie('Unwatched', 2);
    watched(2, 0, null);
    expect(storageJob(t.app.ctx).removed).toBe(0);
    await owner.req('POST', `/api/monitored/${m.id}/delete-files`, { scope: 'movie' });
    expect(t.app.ctx.db.select().from(recycleBin).all()).toHaveLength(0);
    expect(fs.existsSync(m.filePath!)).toBe(false);

    await owner.req('PUT', '/api/settings/storage', { recycleBin: true, autoDelete: true });
    const n = addMovie('Unwatched Too', 5);
    watched(5, 0, null);
    expect(storageJob(t.app.ctx).removed).toBe(1);
    expect(t.app.ctx.db.select().from(recycleBin).all().map((r) => r.title)).toEqual(['Unwatched Too']);
    expect(fs.existsSync(n.filePath!)).toBe(false);
  });

  it('is for managers only', async () => {
    const u = await createUser(owner, 'viewer', 'user');
    const c = new Client(t.app);
    await c.login('viewer', u.password);
    expect((await c.req('GET', '/api/storage')).statusCode).toBe(403);
    expect((await c.req('POST', '/api/storage/free-up', { ids: [1] })).statusCode).toBe(403);
    expect((await c.req('POST', '/api/storage/recycle/1/restore', {})).statusCode).toBe(403);
    expect((await c.req('PATCH', '/api/monitored/1', { keep: true })).statusCode).toBe(403);
  });
});
