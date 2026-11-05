import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { trackDownloads } from '../src/server/arr/tracker.js';
import { fromProbe, problemsOf, resolutionOf } from '../src/server/files/mediainfo.js';
import { isSubRip, movieHash, pickSubtitle } from '../src/server/files/subtitles.js';
import { Client, createUser, makeApp, setupOwner } from './helpers.js';
import { bodyText, fakeFetch, torrentFile, tmdbRoutes } from './fakes.js';

const INDEXER = 'http://indexer.local';
const QBIT = 'http://qbit.local:8080';
const OS = 'https://api.opensubtitles.com/api/v1';

function torznab(items: { title: string; seeders?: number }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
${items
  .map(
    (i, n) => `<item><title>${i.title}</title><guid>guid-${n}-${i.title}</guid><link>${INDEXER}/dl/${n}</link><size>2000000000</size>
<pubDate>Mon, 01 Jan 2024 00:00:00 +0000</pubDate><enclosure url="${INDEXER}/dl/${n}.torrent" length="2000000000" type="application/x-bittorrent"/>
<torznab:attr name="seeders" value="${i.seeders ?? 20}"/></item>`,
  )
  .join('\n')}
</channel></rss>`;
}

describe('file details', () => {
  it('reads resolution, HDR, audio and subtitle languages from ffprobe output', () => {
    const info = fromProbe(
      {
        streams: [
          { codec_type: 'video', codec_name: 'hevc', width: 3840, height: 1600, color_transfer: 'smpte2084' },
          { codec_type: 'audio', codec_name: 'truehd', channels: 8, tags: { language: 'ger' } },
          { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' }, disposition: { forced: 1 } },
        ],
        format: { duration: '5700' },
      },
      null,
    );
    expect(info).toMatchObject({ resolution: '2160p', hdr: 'HDR10', durationMin: 95, audio: [{ codec: 'truehd', channels: 8, language: 'de' }], subtitles: [{ language: 'en', forced: true }] });
    expect(problemsOf(info, 'WEBDL-2160p', 'en')).toEqual(['No EN audio (has de)']);
    expect(problemsOf({ ...info, width: 1280, height: 720, resolution: '720p' }, 'Bluray-1080p', 'de')).toEqual(['Sold as 1080p but the picture is 720p (1280×720)']);
    // Untagged audio isn't held against a file.
    expect(problemsOf({ ...info, audio: [{ codec: 'aac', channels: 2, language: null, title: null }] }, 'WEBDL-2160p', 'en')).toEqual([]);
    expect(resolutionOf(1920, 800)).toBe('1080p');
  });
});

describe('subtitles', () => {
  it('hashes a file the way OpenSubtitles does', () => {
    const dir = fs.mkdtempSync('/tmp/cm-hash-');
    const f = path.join(dir, 'v.mkv');
    fs.writeFileSync(f, Buffer.alloc(200_000, 1));
    // 200000 + 2 × 8192 words of 0x0101010101010101, mod 2^64.
    const expected = (BigInt(200_000) + 2n * 8192n * 0x0101010101010101n) & 0xffffffffffffffffn;
    expect(movieHash(f)).toBe(expected.toString(16).padStart(16, '0'));
    fs.rmSync(dir, { recursive: true });
  });

  it('only writes what is plainly a SubRip file', () => {
    expect(isSubRip('1\n00:00:01,000 --> 00:00:02,000\nHello, bear.\n')).toBe(true);
    expect(isSubRip('<html>not a subtitle</html>')).toBe(false);
    expect(isSubRip('1\n00:00:01,000 --> 00:00:02,000\n\0binary')).toBe(false);
  });

  it('prefers an exact file match, then human-made, then the most downloaded', () => {
    const r = (id: number, a: Record<string, unknown>) => ({ attributes: { language: 'en', download_count: 0, hearing_impaired: false, files: [{ file_id: id, file_name: 'x' }], ...a } });
    const list = [r(1, { download_count: 5000 }), r(2, { download_count: 10, moviehash_match: true }), r(3, { download_count: 9000, machine_translated: true })];
    expect(pickSubtitle(list, 'prefer_not')!.attributes.files[0]!.file_id).toBe(2);
    expect(pickSubtitle([list[0]!, list[2]!], 'prefer_not')!.attributes.files[0]!.file_id).toBe(1);
    expect(pickSubtitle(list, 'only')).toBeNull();
  });
});

describe('problem reports', () => {
  let t: Awaited<ReturnType<typeof makeApp>>;
  let owner: Client;
  let kid: Client;
  let sib: Client;
  let media: string;
  let dl: string;
  let qbitTorrents: Record<string, unknown>[] = [];
  const added: string[] = [];

  beforeEach(async () => {
    t = await makeApp();
    owner = await setupOwner(t.app);
    media = path.join(t.dir, 'media');
    dl = path.join(t.dir, 'downloads');
    fs.mkdirSync(dl, { recursive: true });
    qbitTorrents = [];
    added.length = 0;
    fakeFetch({
      ...tmdbRoutes,
      [`${INDEXER}/api`]: () =>
        new Response(torznab([{ title: 'Paddington.2014.1080p.BluRay.x264-SPARKS', seeders: 50 }, { title: 'Paddington.2014.1080p.WEB-DL.DDP5.1-OTHER', seeders: 10 }])),
      [`${INDEXER}/dl/`]: torrentFile,
      [`${QBIT}/api/v2/auth/login`]: () => new Response('Ok.', { headers: { 'set-cookie': 'SID=abc; path=/' } }),
      [`${QBIT}/api/v2/torrents/add`]: (_u: URL, init?: RequestInit) => (added.push(bodyText(init?.body)), new Response('Ok.')),
      [`${QBIT}/api/v2/torrents/info`]: () => qbitTorrents,
      [`${OS}/subtitles`]: () => ({ data: [{ attributes: { language: 'en', download_count: 100, hearing_impaired: false, moviehash_match: false, files: [{ file_id: 77, file_name: 'p.srt' }] } }] }),
      [`${OS}/download`]: () => ({ link: 'https://www.opensubtitles.com/download/abc/p.srt' }),
      'https://www.opensubtitles.com/download/': () => new Response('1\n00:00:01,000 --> 00:00:02,000\nHello, bear.\n'),
    });
    await owner.req('PUT', '/api/settings/metadata', { tmdbApiKey: 'k' });
    await owner.req('PUT', '/api/settings/media', { downloadsPath: dl, moviesPath: path.join(media, 'movies'), tvPath: path.join(media, 'tv') });
    await owner.req('POST', '/api/indexers', { name: 'Test', type: 'torznab', url: INDEXER, apiKey: 'k' });
    await owner.req('POST', '/api/download-clients', { name: 'qBit', type: 'qbittorrent', url: QBIT, username: 'a', password: 'b' });
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

  /** Finishes the download with this tag in qBittorrent and imports it. */
  const finish = async (tag: string, release: string) => {
    const folder = path.join(dl, release);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${release}.mkv`), `video ${release}`);
    qbitTorrents = [{ hash: tag, name: release, progress: 1, state: 'stalledUP', size: 5, content_path: folder, save_path: dl, tags: tag }];
    await trackDownloads(t.app.ctx);
  };

  const downloadPaddington = async () => {
    await owner.req('POST', '/api/requests', { kind: 'movie', tmdbId: 116149 });
    await vi.waitFor(() => expect(added).toHaveLength(1));
    await finish('mm-1', 'Paddington.2014.1080p.BluRay.x264-SPARKS');
  };

  it('a report can be fixed with one click: the copy is blocklisted, another grabbed, and the reporter hears when it is in', async () => {
    await downloadPaddington();
    const issue = (await kid.req('POST', '/api/issues', { kind: 'movie', tmdbId: 116149, type: 'audio', message: 'It is in German' })).json();
    expect(issue).toMatchObject({ status: 'open', title: 'Paddington', fixes: ['replace'] });
    // The same problem again joins the open report.
    expect((await sib.req('POST', '/api/issues', { kind: 'movie', tmdbId: 116149, type: 'audio' })).json()).toMatchObject({ id: issue.id, duplicate: true });
    expect((await sib.req('GET', `/api/issues/title/movie/116149`)).json()).toEqual([expect.objectContaining({ id: issue.id, mine: false })]);
    // Only managers fix, and users only see their own reports.
    expect((await kid.req('POST', `/api/issues/${issue.id}/fix`, { action: 'replace' })).statusCode).toBe(403);
    expect((await sib.req('GET', '/api/issues')).json()).toEqual([]);
    expect((await owner.req('GET', '/api/issues/count')).json()).toEqual({ open: 1 });

    const fix = (await owner.req('POST', `/api/issues/${issue.id}/fix`, { action: 'replace' })).json();
    expect(fix.ok).toBe(true);
    expect(fix.issue.status).toBe('fixing');
    await vi.waitFor(() => expect(added).toHaveLength(2));
    const rows = t.app.ctx.dbHandle.sqlite.prepare('SELECT title, replace_file, issue_id FROM downloads ORDER BY id').all();
    expect(rows[1]).toEqual({ title: 'Paddington.2014.1080p.WEB-DL.DDP5.1-OTHER', replace_file: 1, issue_id: issue.id });
    expect(t.app.ctx.dbHandle.sqlite.prepare('SELECT release_title, reason FROM blocklist').all()).toEqual([{ release_title: 'Paddington.2014.1080p.BluRay.x264-SPARKS', reason: 'Reported: Wrong language or bad audio' }]);

    // The WEB-DL is a lower quality than the BluRay, but it replaces it because it's a fix.
    await finish('mm-2', 'Paddington.2014.1080p.WEB-DL.DDP5.1-OTHER');
    const mine = (await kid.req('GET', '/api/issues?status=all')).json();
    expect(mine[0]).toMatchObject({ status: 'resolved', resolution: expect.stringContaining('Replaced with a different copy') });
    const mon = t.app.ctx.dbHandle.sqlite.prepare('SELECT file_quality, file_release FROM monitored').get();
    expect(mon).toEqual({ file_quality: 'WEBDL-1080p', file_release: 'Paddington.2014.1080p.WEB-DL.DDP5.1-OTHER' });
    // Still not right? The reporter can reopen it.
    expect((await kid.req('POST', `/api/issues/${issue.id}/reopen`, {})).json().status).toBe('open');
    expect((await sib.req('POST', `/api/issues/${issue.id}/reopen`, {})).statusCode).toBe(403);
  });

  it('fetches subtitles for a subtitle report and saves them next to the movie', async () => {
    await downloadPaddington();
    await owner.req('PUT', '/api/settings/subtitles', { enabled: true, apiKey: 'os-key', auto: false });
    const issue = (await kid.req('POST', '/api/issues', { kind: 'movie', tmdbId: 116149, type: 'subtitles' })).json();
    const fix = (await owner.req('POST', `/api/issues/${issue.id}/fix`, { action: 'subtitles' })).json();
    expect(fix).toMatchObject({ ok: true, issue: { status: 'resolved' } });
    const srt = path.join(media, 'movies', 'Paddington (2014)', 'Paddington (2014) - Bluray-1080p.en.srt');
    expect(fs.readFileSync(srt, 'utf8')).toContain('Hello, bear.');
    // Already there: nothing new is fetched unless asked.
    const m = (await owner.req('GET', '/api/monitored/lookup/movie/116149')).json().monitored;
    expect((await owner.req('POST', `/api/monitored/${m.id}/subtitles`, {})).json()).toEqual({ saved: [], missing: [] });
    expect((await kid.req('POST', `/api/monitored/${m.id}/subtitles`, {})).statusCode).toBe(403);
  });

  it('can fix reports automatically when that is turned on, and needs a season for shows', async () => {
    await downloadPaddington();
    await owner.req('PUT', '/api/settings/issues', { autoFix: true });
    const r = (await kid.req('POST', '/api/issues', { kind: 'movie', tmdbId: 116149, type: 'video' })).json();
    expect(r.status).toBe('fixing');
    expect(r.autoFix).toMatch(/grabbed a different one/);
    expect((await kid.req('POST', '/api/issues', { kind: 'movie', tmdbId: 116149, type: 'other' })).statusCode).toBe(400);
    expect((await kid.req('POST', '/api/issues', { kind: 'movie', tmdbId: 116149, type: 'audio', season: 1 })).statusCode).toBe(400);
  });

  it('people withdraw only their own open reports', async () => {
    const r = (await kid.req('POST', '/api/issues', { kind: 'movie', tmdbId: 116149, type: 'playback' })).json();
    expect((await sib.req('DELETE', `/api/issues/${r.id}`)).statusCode).toBe(403);
    // Not monitored yet: the fix says so instead of failing.
    expect((await owner.req('POST', `/api/issues/${r.id}/fix`, { action: 'replace' })).json()).toMatchObject({ ok: false, message: expect.stringContaining('Monitor it first') });
    expect((await kid.req('DELETE', `/api/issues/${r.id}`)).statusCode).toBe(200);
  });
});
