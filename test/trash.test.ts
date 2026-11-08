import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { fakeFetch } from './fakes.js';
import { toRules, type TrashFormat } from '../src/server/arr/trash.js';
import { formatMatches } from '../src/server/arr/formats.js';
import { parseRelease } from '../src/server/arr/parser.js';

const RAW = 'https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/docs/json/radarr';
const spec = (implementation: string, value: unknown, extra: Partial<{ negate: boolean; required: boolean }> = {}) => ({ name: 'x', implementation, negate: false, required: false, fields: { value }, ...extra });
const hdr: TrashFormat = { trash_id: 'a'.repeat(32), name: 'HDR', trash_scores: { default: 500 }, specifications: [spec('ReleaseTitleSpecification', '\\b(HDR)\\b'), spec('ReleaseTitleSpecification', '\\b(HDR10(?![+]|P(lus)?))')] };
const brdisk: TrashFormat = { trash_id: 'b'.repeat(32), name: 'BR-DISK', trash_scores: { default: -10000 }, specifications: [spec('ReleaseTitleSpecification', '\\b(BDMV|COMPLETE[ .]BLURAY)\\b', { required: true })] };
const remux4k: TrashFormat = { trash_id: 'c'.repeat(32), name: 'Remux 2160p', trash_scores: { default: 100 }, specifications: [spec('QualityModifierSpecification', 5), spec('ResolutionSpecification', 2160), spec('ReleaseTitleSpecification', '\\bGRP\\b')] };
const original: TrashFormat = { trash_id: 'd'.repeat(32), name: 'Language: Not Original', trash_scores: { default: -10000 }, specifications: [spec('LanguageSpecification', -2, { negate: true })] };
const tier: TrashFormat = { trash_id: 'e'.repeat(32), name: 'WEB Tier 01', trash_scores: { default: 1700 }, specifications: [spec('ReleaseGroupSpecification', '^(FLUX|NTb)$'), spec('SourceSpecification', 7), spec('SourceSpecification', 8)] };
const profile = {
  trash_id: 'f'.repeat(32),
  name: 'HD Bluray + WEB',
  trash_description: 'Covers:<br>- Bluray 1080p',
  upgradeAllowed: true,
  cutoff: 'Bluray-1080p',
  minFormatScore: 0,
  cutoffFormatScore: 10000,
  items: [{ name: 'Bluray-1080p', allowed: true }, { name: 'WEB 1080p', allowed: true, items: ['WEBRip-1080p', 'WEBDL-1080p'] }, { name: 'Bluray-1080p Remux', allowed: false }],
  formatItems: { HDR: hdr.trash_id, 'WEB Tier 01': tier.trash_id, 'Language: Not Original': original.trash_id },
};
const group = { name: '[Unwanted]', default: 'true', custom_formats: [{ name: 'BR-DISK', trash_id: brdisk.trash_id, required: false, default: true }], quality_profiles: { include: { 'HD Bluray + WEB': profile.trash_id } } };

describe('TRaSH Guides formats', () => {
  const p = (t: string) => parseRelease(t);
  const rel = (title: string) => ({ title, indexer: 'i', protocol: 'torrent' as const, size: 1 });
  const fmt = (f: TrashFormat) => ({ id: 1, name: f.name, rules: toRules('radarr', f)! });

  it('keeps title specs as "any of these" and folds other kinds into required rules', () => {
    expect(formatMatches(fmt(hdr), rel('Movie.2020.2160p.HDR10.WEB'), p('Movie.2020.2160p.HDR10.WEB'))).toBe(true);
    const r = fmt(remux4k);
    expect(r.rules.filter((x) => x.required)).toHaveLength(2);
    expect(formatMatches(r, rel('Movie.2020.2160p.BluRay.REMUX.GRP'), p('Movie.2020.2160p.BluRay.REMUX.GRP'))).toBe(true);
    // Radarr needs the resolution and the modifier too, not just one of the three.
    expect(formatMatches(r, rel('Movie.2020.1080p.BluRay.REMUX.GRP'), p('Movie.2020.1080p.BluRay.REMUX.GRP'))).toBe(false);
    // Two sources fold into one required "either" rule beside the group list.
    const t = fmt(tier);
    expect(formatMatches(t, rel('Movie.2020.1080p.WEBRip.x264-FLUX'), p('Movie.2020.1080p.WEBRip.x264-FLUX'))).toBe(true);
    expect(formatMatches(t, rel('Movie.2020.1080p.BluRay.x264-FLUX'), p('Movie.2020.1080p.BluRay.x264-FLUX'))).toBe(false);
  });

  it("skips formats Cinemask can't check", () => {
    expect(toRules('radarr', original)).toBeNull();
    expect(toRules('radarr', { ...hdr, specifications: [spec('IndexerFlagSpecification', 1)] })).toBeNull();
    expect(toRules('radarr', { ...hdr, specifications: [spec('ReleaseTitleSpecification', '(?>atomic)')] })).toBeNull();
  });
});

describe('TRaSH Guides sync', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let trees = 0;
  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    trees = 0;
    const files: Record<string, unknown> = { 'quality-profiles/hd-bluray-web.json': profile, 'cf/hdr.json': hdr, 'cf/br-disk.json': brdisk, 'cf/web-tier-01.json': tier, 'cf/language-not-original.json': original, 'cf/remux.json': remux4k, 'cf-groups/unwanted.json': group };
    fakeFetch({
      'https://api.github.com/repos/TRaSH-Guides/Guides/git/trees/master': () => (trees++, { tree: Object.keys(files).map((f) => ({ path: `docs/json/radarr/${f}`, type: 'blob' })) }),
      ...Object.fromEntries(Object.entries(files).map(([f, body]) => [`${RAW}/${f}`, () => body])),
    });
    const { forgetGuideCache } = await import('../src/server/arr/trash.js');
    forgetGuideCache();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await t.close();
  });

  it('lists guide profiles, makes a linked profile from one, and only admins can', async () => {
    const list = (await owner.req('GET', '/api/trash/radarr/profiles')).json();
    expect(list).toEqual([{ id: profile.trash_id, name: 'HD Bluray + WEB', description: 'Covers:\n- Bluray 1080p', formats: 4 }]);

    const u = await createUser(owner, 'mgr', 'manager');
    const mgr = new Client(t.app);
    await mgr.login('mgr', u.password);
    expect((await mgr.req('GET', '/api/trash/radarr/profiles')).statusCode).toBe(403);
    expect((await mgr.req('POST', '/api/trash/apply', { app: 'radarr', trashId: profile.trash_id })).statusCode).toBe(403);

    // A format made by hand with the same name keeps it.
    await owner.req('POST', '/api/custom-formats', { name: 'HDR', rules: [{ kind: 'title', pattern: 'HDR' }] });
    const res = (await owner.req('POST', '/api/trash/apply', { app: 'radarr', trashId: profile.trash_id })).json();
    expect(res.skipped).toEqual(['Language: Not Original']);
    expect(res.formats).toBe(3);
    expect(res.profile).toMatchObject({ name: 'TRaSH HD Bluray + WEB', qualities: ['WEBRip-1080p', 'WEBDL-1080p', 'Bluray-1080p'], cutoff: 'Bluray-1080p', upgradeUntilFormatScore: 10000, trash: { app: 'radarr', id: profile.trash_id } });
    const formats = (await owner.req('GET', '/api/custom-formats')).json().formats as { id: number; name: string }[];
    expect(formats.map((f) => f.name).sort()).toEqual(['BR-DISK', 'HDR', 'HDR (TRaSH)', 'WEB Tier 01']);
    const id = (n: string) => String(formats.find((f) => f.name === n)!.id);
    expect(res.profile.formatScores).toEqual({ [id('HDR (TRaSH)')]: 500, [id('BR-DISK')]: -10000, [id('WEB Tier 01')]: 1700 });

    // Syncing again updates in place; no duplicates.
    expect((await owner.req('POST', '/api/trash/sync', {})).json()).toEqual({ synced: 1 });
    expect(((await owner.req('GET', '/api/custom-formats')).json().formats as unknown[]).length).toBe(4);
    expect(trees).toBe(2);

    expect((await owner.req('POST', '/api/trash/unlink', { profileId: res.profileId })).json().trash).toBeNull();
    expect((await owner.req('POST', '/api/trash/sync', {})).json()).toEqual({ synced: 0 });
  });
});
