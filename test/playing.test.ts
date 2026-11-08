import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch, JELLYFIN, PLEX } from './fakes.js';
import { trackPlays } from '../src/server/playing/service.js';

describe('now playing and watch stats', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let plexSessions: unknown[] = [];
  let jfSessions: unknown[] = [];
  let stopped: string[] = [];
  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    stopped = [];
    plexSessions = [
      {
        sessionKey: '7',
        ratingKey: '10',
        type: 'movie',
        title: 'Paddington',
        year: 2014,
        viewOffset: 600_000,
        duration: 5_700_000,
        User: { title: 'Grandma' },
        Player: { title: 'Living Room TV', platform: 'Roku', state: 'playing', local: true },
        Session: { id: 'sess-a', bandwidth: 8000, location: 'lan' },
        Media: [{ videoResolution: '1080' }],
      },
    ];
    jfSessions = [
      { Id: 'jf-s1', UserName: 'kid', Client: 'Jellyfin Web', DeviceName: 'Chrome', RemoteEndPoint: '203.0.113.9', NowPlayingItem: { Id: 'e9', Name: 'Pilot', Type: 'Episode', SeriesName: 'Bluey', SeriesId: 's1', ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 4_200_000_000, Width: 1280, Height: 720 }, PlayState: { PositionTicks: 600_000_000, IsPaused: false, PlayMethod: 'Transcode' }, TranscodingInfo: { IsVideoDirect: false, IsAudioDirect: true, Bitrate: 4_000_000 } },
      { Id: 'jf-idle', UserName: 'sib' },
    ];
    fakeFetch({
      [`${PLEX}/status/sessions/terminate`]: (u: URL) => (stopped.push(`plex:${u.searchParams.get('sessionId')}`), new Response('')),
      [`${PLEX}/status/sessions`]: () => ({ MediaContainer: { Metadata: plexSessions } }),
      [`${PLEX}/library/sections`]: () => ({ MediaContainer: { Directory: [] } }),
      [`${JELLYFIN}/Sessions`]: () => jfSessions,
      [`${JELLYFIN}/System/Info`]: () => ({ ServerName: 'JF', Version: '10', Id: 'x' }),
    });
    await owner.req('PUT', '/api/settings/plex', { enabled: true, url: PLEX, token: 'tok' });
    await owner.req('PUT', '/api/settings/jellyfin', { enabled: true, url: JELLYFIN, apiKey: 'k' });
    t.app.ctx.dbHandle.sqlite.prepare("INSERT INTO library_items (server, external_key, kind, title, tmdb_id) VALUES ('plex','10','movie','Paddington',116149), ('jellyfin','s1','show','Bluey',82728)").run();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('follows plays across checks, counts only time spent playing, and finishes plays that stop', async () => {
    const t0 = Date.now();
    await trackPlays(t.app.ctx, t0);
    const now = (await owner.req('GET', '/api/playing')).json();
    expect(now.sessions).toHaveLength(2);
    const movie = now.sessions.find((s: { kind: string }) => s.kind === 'movie');
    expect(movie).toMatchObject({ user: 'Grandma', title: 'Paddington', tmdbId: 116149, decision: 'direct', quality: '1080p', player: 'Living Room TV', local: true });
    expect(movie.progress).toBeCloseTo(600 / 5700, 3);
    const ep = now.sessions.find((s: { kind: string }) => s.kind === 'episode');
    expect(ep).toMatchObject({ user: 'kid', show: 'Bluey', season: 1, episode: 1, tmdbId: 82728, decision: 'transcode', quality: '720p', bandwidthKbps: 4000, local: false });

    // A minute later, still playing; then paused for a minute (doesn't count); then gone.
    await trackPlays(t.app.ctx, t0 + 60_000);
    (plexSessions[0] as { Player: { state: string } }).Player.state = 'paused';
    await trackPlays(t.app.ctx, t0 + 120_000);
    await trackPlays(t.app.ctx, t0 + 180_000);
    plexSessions = [];
    // An hour-long gap only adds two minutes.
    await trackPlays(t.app.ctx, t0 + 3_600_000);
    jfSessions = [];
    await trackPlays(t.app.ctx, t0 + 3_660_000);
    expect((await owner.req('GET', '/api/playing')).json().sessions).toEqual([]);

    const stats = (await owner.req('GET', '/api/playing/stats?days=7')).json();
    expect(stats.plays).toBe(2);
    const byUser = Object.fromEntries(stats.users.map((u: { user: string; hours: number }) => [u.user, u.hours]));
    expect(byUser).toEqual({ kid: 0.1, Grandma: 0 });
    expect(stats.decisions).toEqual({ direct: 1, copy: 0, transcode: 1 });
    expect(stats.titles.map((x: { title: string }) => x.title).sort()).toEqual(['Bluey', 'Paddington']);
    expect(stats.history).toHaveLength(2);
  });

  it('lets managers see and only admins stop streams', async () => {
    await trackPlays(t.app.ctx);
    const u = await createUser(owner, 'kid', 'user');
    const m = await createUser(owner, 'mgr', 'manager');
    const kid = new Client(t.app);
    await kid.login('kid', u.password);
    const mgr = new Client(t.app);
    await mgr.login('mgr', m.password);
    expect((await kid.req('GET', '/api/playing')).statusCode).toBe(403);
    expect((await kid.req('GET', '/api/playing/stats')).statusCode).toBe(403);
    const sessions = (await mgr.req('GET', '/api/playing')).json().sessions as { id: number; server: string }[];
    const plex = sessions.find((s) => s.server === 'plex')!;
    expect((await mgr.req('POST', `/api/playing/${plex.id}/stop`, {})).statusCode).toBe(403);
    expect((await owner.req('POST', `/api/playing/${plex.id}/stop`, { reason: 'Bedtime' })).statusCode).toBe(200);
    expect(stopped).toEqual(['plex:sess-a']);
  });
});
