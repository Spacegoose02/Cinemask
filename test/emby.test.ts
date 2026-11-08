import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, jellyfinRoutes, JELLYFIN, tmdbRoutes } from './fakes.js';
import { refreshMediaServers } from '../src/server/arr/tracker.js';
import { trackPlays } from '../src/server/playing/service.js';
import { openDatabase } from '../src/server/db/database.js';
import { MIGRATIONS } from '../src/server/db/migrations.js';

const EMBY = 'http://emby.local:8096';

/** Emby answers like Jellyfin, but only to its own token header. */
function embyRoutes(refreshed: string[] = []) {
  const routes: Record<string, (url: URL, init?: RequestInit) => unknown> = {};
  for (const [k, fn] of Object.entries(jellyfinRoutes)) routes[k.replace(JELLYFIN, EMBY)] = fn;
  routes[`${EMBY}/System/Info`] = () => ({ ServerName: 'Den Emby', Version: '4.8.10', Id: 'em1' });
  routes[`${EMBY}/Users/Query`] = () => ({ Items: [{ Id: 'u1', Name: 'goose', Policy: { IsAdministrator: true } }] });
  routes[`${EMBY}/Library/Refresh`] = () => (refreshed.push('emby'), new Response(null, { status: 204 }));
  routes[`${EMBY}/Sessions`] = () => [
    { Id: 'em-s1', UserName: 'nan', Client: 'Emby Theater', DeviceName: 'Lounge', RemoteEndPoint: '192.168.1.20', NowPlayingItem: { Id: 'm1', Name: 'Paddington', Type: 'Movie', ProductionYear: 2014, RunTimeTicks: 57_000_000_000, Width: 3840, Height: 2160 }, PlayState: { PositionTicks: 6_000_000_000, IsPaused: false, PlayMethod: 'DirectPlay' } },
  ];
  const guarded: typeof routes = {};
  for (const [k, fn] of Object.entries(routes)) {
    guarded[k] = (url, init) => {
      const h = new Headers(init?.headers);
      return h.get('x-emby-token') === 'em-key' ? fn(url, init) : new Response('', { status: 401 });
    };
  }
  return guarded;
}

describe('Emby', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'tmdb-key' });
    await owner.req('PUT', '/api/settings/emby', { enabled: true, url: EMBY, apiKey: 'em-key' });
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('tests the connection with its own token header and keeps the key secret', async () => {
    const { calls } = fakeFetch(embyRoutes());
    const res = await owner.req('POST', '/api/integrations/emby/test');
    expect(res.json()).toEqual({ ok: true, message: 'Connected to Den Emby (Emby 4.8.10)' });
    expect(calls[0]).not.toContain('em-key');
    expect(JSON.stringify((await owner.req('GET', '/api/settings/emby')).json())).not.toContain('em-key');
  });

  it('syncs the library so its titles count as available', async () => {
    fakeFetch({ ...embyRoutes(), ...tmdbRoutes });
    await t.librarySync.run();
    expect(t.librarySync.status.results.emby).toEqual({ ok: true, movies: 1, shows: 1, episodes: 1 });
    const lib = (await owner.req('GET', '/api/library?q=paddington')).json();
    expect(lib.items[0]).toMatchObject({ resolution: '2160p', servers: ['emby'] });
    expect((await owner.req('GET', '/api/media/movie/116149')).json().availability.status).toBe('on_server');
  });

  it('is rescanned after imports and shows in Now playing', async () => {
    const refreshed: string[] = [];
    fakeFetch({ ...embyRoutes(refreshed), ...tmdbRoutes });
    await refreshMediaServers(t.app.ctx);
    expect(refreshed).toEqual(['emby']);
    t.app.ctx.dbHandle.sqlite.prepare("INSERT INTO library_items (server, external_key, kind, title, tmdb_id) VALUES ('emby','m1','movie','Paddington',116149)").run();
    await trackPlays(t.app.ctx, Date.now());
    const now = (await owner.req('GET', '/api/playing')).json();
    expect(now.sessions).toEqual([expect.objectContaining({ server: 'emby', user: 'nan', title: 'Paddington', tmdbId: 116149, decision: 'direct', quality: '2160p', local: true })]);
  });

  it('reports a wrong key', async () => {
    await owner.req('PUT', '/api/settings/emby', { apiKey: 'wrong' });
    fakeFetch(embyRoutes());
    const res = (await owner.req('POST', '/api/integrations/emby/test')).json();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/Emby/);
  });

  it('keeps its settings and test to admins', async () => {
    const u = await createUser(owner, 'mgr', 'manager');
    const c = new Client(t.app);
    await c.login('mgr', u.password);
    expect((await c.req('GET', '/api/settings/emby')).statusCode).toBe(403);
    expect((await c.req('POST', '/api/integrations/emby/test')).statusCode).toBe(403);
  });
});

describe('migration 33', () => {
  it('keeps library items, their episodes and match overrides', () => {
    const h = openDatabase(':memory:');
    const db = h.sqlite;
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((m) => m.id < 33)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
    }
    db.prepare("INSERT INTO library_items (id, server, external_key, kind, title) VALUES (5, 'jellyfin', 's1', 'show', 'Bluey')").run();
    db.prepare("INSERT INTO library_episodes (library_item_id, season, episode) VALUES (5, 1, 1)").run();
    db.prepare("INSERT INTO match_overrides VALUES ('plex', '10', 116149, 1)").run();
    // Run as migrate() does, with foreign keys on, so a dropped table would cascade.
    db.transaction(() => db.exec(MIGRATIONS.find((m) => m.id === 33)!.sql))();
    expect(db.prepare('SELECT count(*) AS n FROM library_episodes WHERE library_item_id = 5').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM match_overrides').get()).toEqual({ n: 1 });
    db.prepare("INSERT INTO library_items (server, external_key, kind, title) VALUES ('emby', 'x', 'movie', 'X')").run();
    db.close();
  });
});
