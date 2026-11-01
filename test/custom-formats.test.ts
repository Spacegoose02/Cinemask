import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { decide } from '../src/server/arr/decision.js';
import { formatMatches, PRESETS, scoreRelease, type CustomFormat } from '../src/server/arr/formats.js';
import { parseRelease } from '../src/server/arr/parser.js';
import type { Release } from '../src/server/arr/indexers.js';
import type { Profile } from '../src/server/arr/profiles.js';

const rel = (title: string, extra: Partial<Release> = {}): Release => ({ guid: title, title, protocol: 'torrent', size: 8e9, seeders: 20, indexer: 'Tracker', downloadUrl: 'http://x', publishedAt: null, ...extra }) as Release;
const fmt = (id: number, name: string): CustomFormat => ({ id, name, rules: PRESETS.find((p) => p.name === name)!.rules });

describe('matching formats', () => {
  it('reads HDR, Dolby Vision, Atmos and release groups from release names', () => {
    const t = 'Dune.Part.Two.2024.2160p.UHD.BluRay.DV.HDR10.TrueHD.Atmos.7.1.x265-GROUP';
    const parsed = parseRelease(t);
    const names = ['Dolby Vision', 'HDR', 'Atmos', 'Lossless audio', 'x265 / HEVC', 'Low-quality groups', 'HDR10+'];
    const hits = names.filter((n) => formatMatches(fmt(1, n), rel(t), parsed));
    expect(hits).toEqual(['Dolby Vision', 'HDR', 'Atmos', 'Lossless audio', 'x265 / HEVC']);
    expect(formatMatches(fmt(1, 'Low-quality groups'), rel('Dune.2021.1080p.BluRay.x264-YTS.MX'), parseRelease('Dune.2021.1080p.BluRay.x264-YTS'))).toBe(true);
  });

  it('needs every required rule, and one of the others of each kind', () => {
    const f: CustomFormat = {
      id: 1,
      name: '4K HDR from a streaming service',
      rules: [
        { kind: 'title', pattern: '\\b2160p\\b', negate: false, required: true },
        { kind: 'title', pattern: '\\bHDR\\b', negate: false, required: false },
        { kind: 'title', pattern: '\\bDV\\b', negate: false, required: false },
        { kind: 'title', pattern: '\\bREMUX\\b', negate: true, required: true },
      ],
    };
    const m = (t: string) => formatMatches(f, rel(t), parseRelease(t));
    expect(m('Show.S01E01.2160p.NF.WEB-DL.DV.H.265-X')).toBe(true);
    expect(m('Show.S01E01.1080p.NF.WEB-DL.HDR.H.265-X')).toBe(false);
    expect(m('Show.S01E01.2160p.NF.WEB-DL.H.265-X')).toBe(false);
    expect(m('Show.S01E01.2160p.BluRay.REMUX.HDR-X')).toBe(false);
  });

  it('adds up the scores of the formats a release matches', () => {
    const formats = [fmt(1, 'HDR'), fmt(2, 'Atmos'), fmt(3, 'Low-quality groups')];
    const t = 'Film.2023.2160p.WEB-DL.HDR.DDP5.1.Atmos-GOOD';
    expect(scoreRelease(formats, { '1': 500, '2': 200, '3': -10000 }, rel(t), parseRelease(t))).toEqual({ score: 700, matched: ['HDR', 'Atmos'] });
  });
});

describe('deciding with scores', () => {
  const formats = [fmt(1, 'HDR'), fmt(2, 'Low-quality groups')];
  const profile: Profile = {
    id: 1,
    name: '4K',
    qualities: ['WEBDL-2160p', 'Bluray-2160p'],
    cutoff: 'WEBDL-2160p',
    upgradesAllowed: true,
    language: 'any',
    formatScores: { '1': 500, '2': -10000 },
    minFormatScore: 0,
    upgradeUntilFormatScore: 500,
  };
  const movie = { kind: 'movie' as const, title: 'Film', year: 2023 };

  it('rejects releases under the minimum score and prefers higher scores at the same quality', () => {
    const lq = decide(rel('Film.2023.2160p.WEB-DL.x265-YTS'), movie, profile, new Set(), { formats });
    expect(lq.accepted).toBe(false);
    expect(lq.rejections[0]).toMatch(/Format score -10000 is below/);
    const plain = decide(rel('Film.2023.2160p.WEB-DL.x265-GOOD'), movie, profile, new Set(), { formats });
    const hdr = decide(rel('Film.2023.2160p.WEB-DL.HDR.x265-GOOD'), movie, profile, new Set(), { formats });
    expect(hdr.score).toBeGreaterThan(plain.score);
    // Quality still comes first.
    const blu = decide(rel('Film.2023.2160p.BluRay.x265-GOOD'), movie, profile, new Set(), { formats });
    expect(blu.score).toBeGreaterThan(hdr.score);
  });

  it('upgrades a file at the cutoff quality to a better-scoring release, until the score is reached', () => {
    const have = { ...movie, currentQuality: 'WEBDL-2160p', currentFormatScore: 0 };
    expect(decide(rel('Film.2023.2160p.WEB-DL.HDR.x265-GOOD'), have, profile, new Set(), { formats }).accepted).toBe(true);
    expect(decide(rel('Film.2023.2160p.WEB-DL.x265-OTHER'), have, profile, new Set(), { formats }).rejections).toContain('Format score 0 is not better than 0');
    const done = { ...movie, currentQuality: 'WEBDL-2160p', currentFormatScore: 500 };
    expect(decide(rel('Film.2023.2160p.WEB-DL.HDR.x265-GOOD'), done, profile, new Set(), { formats }).rejections).toContain('Already at cutoff (WEBDL-2160p)');
    // A file whose score isn't known is left alone.
    const unknown = { ...movie, currentQuality: 'WEBDL-2160p', currentFormatScore: null };
    expect(decide(rel('Film.2023.2160p.WEB-DL.HDR.x265-GOOD'), unknown, profile, new Set(), { formats }).accepted).toBe(false);
  });
});

describe('custom format routes', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let manager: Client;
  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    const m = await createUser(owner, 'mgr', 'manager');
    manager = new Client(t.app);
    await manager.login('mgr', m.password);
  });
  afterEach(async () => t.close());

  it('adds the ready-made formats with suggested scores, and only admins change formats', async () => {
    const [p] = (await owner.req('GET', '/api/profiles')).json();
    expect((await manager.req('POST', '/api/custom-formats/presets', { profileIds: [p.id] })).statusCode).toBe(403);
    const res = (await owner.req('POST', '/api/custom-formats/presets', { profileIds: [p.id] })).json();
    expect(res.added).toBe(PRESETS.length);
    const hdr = res.formats.find((f: { name: string }) => f.name === 'HDR');
    const profile = (await owner.req('GET', '/api/profiles')).json().find((x: { id: number }) => x.id === p.id);
    expect(profile.formatScores[String(hdr.id)]).toBe(500);
    // Running it again adds nothing and keeps scores someone changed.
    await owner.req('PUT', `/api/profiles/${p.id}`, { ...profile, formatScores: { ...profile.formatScores, [String(hdr.id)]: 50 } });
    expect((await owner.req('POST', '/api/custom-formats/presets', { profileIds: [p.id] })).json().added).toBe(0);
    expect((await owner.req('GET', '/api/profiles')).json().find((x: { id: number }) => x.id === p.id).formatScores[String(hdr.id)]).toBe(50);
    expect((await manager.req('GET', '/api/custom-formats')).json().presets.every((x: { added: boolean }) => x.added)).toBe(true);
  });

  it('refuses bad patterns, and deleting a format drops it from profiles', async () => {
    expect((await owner.req('POST', '/api/custom-formats', { name: 'Bad', rules: [{ kind: 'title', pattern: '([' }] })).statusCode).toBe(400);
    const f = (await owner.req('POST', '/api/custom-formats', { name: 'Remux', rules: [{ kind: 'title', pattern: '\\bREMUX\\b' }] })).json();
    expect((await owner.req('POST', '/api/custom-formats', { name: 'remux', rules: [{ kind: 'title', pattern: 'x' }] })).statusCode).toBe(409);
    const [p] = (await owner.req('GET', '/api/profiles')).json();
    await owner.req('PUT', `/api/profiles/${p.id}`, { ...p, formatScores: { [String(f.id)]: 100, '9999': 5 } });
    expect((await owner.req('GET', '/api/profiles')).json()[0].formatScores).toEqual({ [String(f.id)]: 100 });
    await owner.req('DELETE', `/api/custom-formats/${f.id}`);
    expect((await owner.req('GET', '/api/profiles')).json()[0].formatScores).toEqual({});
  });
});
