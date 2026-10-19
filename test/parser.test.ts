import { describe, expect, it } from 'vitest';
import { normalizeTitle, parseRelease, titlesMatch } from '../src/server/arr/parser.js';
import { renderName } from '../src/server/arr/naming.js';

describe('release parser', () => {
  const cases: [string, Partial<ReturnType<typeof parseRelease>>][] = [
    ['Expedition.Unknown.S01E01.Tigers.1080p.WEB-DL.DDP5.1.H.264-NTb', { title: 'Expedition Unknown', season: 1, episodes: [1], quality: 'WEBDL-1080p', group: 'NTb' }],
    ['Bluey.2018.S03E05E06.720p.HDTV.x264-GRP', { title: 'Bluey', year: 2018, season: 3, episodes: [5, 6], quality: 'HDTV-720p' }],
    ['The.Office.US.S02E01-E03.1080p.BluRay.x264', { title: 'The Office US', season: 2, episodes: [1, 2, 3], quality: 'Bluray-1080p' }],
    ['Show Name 1x05 480p WEBRip', { title: 'Show Name', season: 1, episodes: [5], quality: 'WEBRip-480p' }],
    ['Planet.Earth.III.S01.COMPLETE.2160p.UHD.BluRay.REMUX-FraMeSToR', { title: 'Planet Earth III', season: 1, episodes: [], fullSeason: true, quality: 'Remux-2160p' }],
    ['Show.Name.Season.2.1080p.AMZN.WEBRip', { title: 'Show Name', season: 2, fullSeason: true, quality: 'WEBRip-1080p' }],
    ['The.Daily.Show.2024.03.14.720p.WEB.h264-EDITH', { title: 'The Daily Show', airDate: '2024-03-14', quality: 'WEBDL-720p' }],
    ['Paddington.2.2017.1080p.BluRay.x264-SPARKS', { title: 'Paddington 2', year: 2017, season: null, quality: 'Bluray-1080p' }],
    ['Blade.Runner.2049.2017.2160p.UHD.BluRay.REMUX.HDR.HEVC', { title: 'Blade Runner 2049', year: 2017, quality: 'Remux-2160p' }],
    ['Amelie.2001.FRENCH.720p.BluRay.x264', { title: 'Amelie', year: 2001, languages: ['fr'], quality: 'Bluray-720p' }],
    ['Movie.Title.2020.MULTi.1080p.WEB.H264.PROPER-GRP', { title: 'Movie Title', languages: ['multi'], proper: true }],
    ['Some.Old.Movie.1985.DVDRip.XviD', { title: 'Some Old Movie', year: 1985, quality: 'DVD' }],
    ['No.Quality.Info.2021', { title: 'No Quality Info', year: 2021, quality: 'Unknown' }],
  ];
  for (const [name, expected] of cases) {
    it(name, () => expect(parseRelease(name)).toMatchObject(expected));
  }

  it('defaults to English when no language is tagged', () => {
    expect(parseRelease('Movie.2020.1080p.WEB-DL').languages).toEqual(['en']);
  });
});

describe('title matching', () => {
  it('ignores punctuation, accents, articles and ampersands', () => {
    expect(normalizeTitle('The Lord of the Rings: The Two Towers')).toBe('lord of the rings the two towers');
    expect(titlesMatch('Amelie', 'Amélie')).toBe(true);
    expect(titlesMatch('Law and Order SVU', 'Law & Order: SVU')).toBe(true);
    expect(titlesMatch('Bluey 2018', 'Bluey')).toBe(true);
    expect(titlesMatch('Blue', 'Bluey')).toBe(false);
  });
});

describe('naming', () => {
  it('renders the board example', () => {
    expect(
      renderName('Season {season} - {Series Title} - S{season:00}E{episode:00} - {Episode Title}', {
        seriesTitle: 'Expedition Unknown',
        season: 1,
        episodes: [1],
        episodeTitle: 'Tigers fighting',
      }),
    ).toBe('Season 1 - Expedition Unknown - S01E01 - Tigers fighting');
  });

  it('handles multi-episode files and illegal characters', () => {
    expect(renderName('{Series Title} - S{season:00}E{episode:00}', { seriesTitle: 'CSI: Miami', season: 2, episodes: [3, 4] })).toBe('CSI - Miami - S02E03-E04');
  });

  it('drops empty tokens cleanly', () => {
    expect(renderName('{Movie Title} ({Year}) - {Quality}', { movieTitle: 'Up' })).toBe('Up');
    expect(renderName('{Movie Title} ({Year})', { movieTitle: 'Up', year: 2009 })).toBe('Up (2009)');
  });

  it('cannot produce path traversal', () => {
    expect(renderName('{Movie Title}', { movieTitle: '../../etc/passwd' })).toBe('etcpasswd');
    expect(renderName('{Movie Title}', { movieTitle: '..' })).toBe('');
  });
});
