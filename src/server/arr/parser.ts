import { qualityFor, type QualityId } from './quality.js';

export interface ParsedRelease {
  title: string;
  year: number | null;
  season: number | null;
  episodes: number[];
  /** Anime-style absolute episode numbers ("[Group] Show - 112 [1080p]"), when there's no season. */
  absolute: number[];
  fullSeason: boolean;
  airDate: string | null;
  resolution: string | null;
  source: string | null;
  quality: QualityId;
  proper: boolean;
  languages: string[];
  group: string | null;
  /** Recorded in a cinema or from a pre-release copy: CAM, TELESYNC, TELECINE or SCREENER. */
  theatrical: 'cam' | 'telesync' | 'telecine' | 'screener' | null;
}

const LANGUAGES: [RegExp, string][] = [
  [/\b(multi|dual[ .-]?audio)\b/i, 'multi'],
  [/\b(english|eng)\b/i, 'en'],
  [/\b(french|vff|vfq|vostfr|truefrench)\b/i, 'fr'],
  [/\b(german|deutsch)\b/i, 'de'],
  [/\b(spanish|espanol|castellano|latino)\b/i, 'es'],
  [/\b(italian|ita)\b/i, 'it'],
  [/\b(dutch|flemish)\b/i, 'nl'],
  [/\b(japanese|jpn)\b/i, 'ja'],
  [/\b(korean|kor)\b/i, 'ko'],
  [/\b(hindi)\b/i, 'hi'],
  [/\b(russian|rus)\b/i, 'ru'],
  [/\b(portuguese|brazilian|pt-br)\b/i, 'pt'],
  [/\b(polish|pl)\b/i, 'pl'],
  [/\b(swedish|swe)\b/i, 'sv'],
  [/\b(danish)\b/i, 'da'],
  [/\b(norwegian|nor)\b/i, 'no'],
  [/\b(finnish)\b/i, 'fi'],
  [/\b(chinese|mandarin|cantonese)\b/i, 'zh'],
  [/\b(hungarian)\b/i, 'hu'],
  [/\b(czech|cz)\b/i, 'cs'],
  [/\b(turkish)\b/i, 'tr'],
  [/\b(arabic)\b/i, 'ar'],
  [/\b(hebrew)\b/i, 'he'],
  [/\b(ukrainian|ukr)\b/i, 'uk'],
  [/\b(greek)\b/i, 'el'],
  [/\b(romanian)\b/i, 'ro'],
  [/\b(thai)\b/i, 'th'],
  [/\b(vietnamese)\b/i, 'vi'],
  [/\b(nordic)\b/i, 'nordic'],
];

/** Parses a scene/P2P release name like "Show.Name.S01E02.1080p.WEB-DL.DDP5.1-GROUP". */
export function parseRelease(raw: string): ParsedRelease {
  const name = raw.replace(/\.(mkv|mp4|avi|m4v|ts|nzb|torrent)$/i, '');
  // Fansub releases put the group first and a checksum last: "[SubsPlease] Show - 12 (1080p) [A1B2C3D4]".
  const leadGroup = /^\s*\[([^\]]{1,40})\]\s*/.exec(name);
  const s = name
    .slice(leadGroup ? leadGroup[0].length : 0)
    .replace(/\s*\[[0-9A-F]{8}\]\s*$/i, '')
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  let season: number | null = null;
  let episodes: number[] = [];
  let fullSeason = false;
  let airDate: string | null = null;
  let cut = s.length;
  const mark = (index: number) => (cut = Math.min(cut, index));

  const se = /\bS(\d{1,2})[ -]?((?:E\d{1,3}(?:[ -]?(?:E|-E?)\d{1,3})*))/i.exec(s);
  const xFormat = /\b(\d{1,2})x(\d{2,3})(?:-?x?(\d{2,3}))?\b/i.exec(s);
  const seasonOnly = /\b(?:S(\d{1,2})(?!\s?E\d)|Season[ -]?(\d{1,2}))\b/i.exec(s);
  const daily = /\b((?:19|20)\d{2})[ -](\d{2})[ -](\d{2})\b/.exec(s);
  if (se) {
    season = Number(se[1]);
    const nums = se[2]!.match(/\d{1,3}/g)!.map(Number);
    // "E01-E03" and "E01-03" mean a range; "E01E02" lists episodes.
    episodes = /-/.test(se[2]!) && nums.length === 2 ? range(nums[0]!, nums[1]!) : nums;
    mark(se.index);
  } else if (xFormat) {
    season = Number(xFormat[1]);
    episodes = xFormat[3] ? range(Number(xFormat[2]), Number(xFormat[3])) : [Number(xFormat[2])];
    mark(xFormat.index);
  } else if (daily) {
    airDate = `${daily[1]}-${daily[2]}-${daily[3]}`;
    mark(daily.index);
  } else if (seasonOnly) {
    season = Number(seasonOnly[1] ?? seasonOnly[2]);
    fullSeason = true;
    mark(seasonOnly.index);
  }
  let absolute: number[] = [];
  if (season === null && !airDate) {
    // "Show - 12", "Show - 012v2", "Show - 01-12": a number after " - " that isn't a year.
    const abs = /\s-\s(\d{1,4})(?:v\d)?(?:\s?[-~]\s?(\d{1,4})(?:v\d)?)?(?=\s|$|\[|\()/.exec(s);
    const n = abs ? Number(abs[1]) : NaN;
    if (abs && !(n >= 1900 && n <= 2099) && n > 0) {
      absolute = abs[2] ? range(n, Number(abs[2])) : [n];
      mark(abs.index);
    }
  }
  if (!fullSeason && /\bcomplete\b/i.test(s) && season !== null && episodes.length === 0) fullSeason = true;

  // The release year is the last year-like number before the episode/quality tags
  // ("Blade Runner 2049 2017 2160p" → 2017), never the first word of the title.
  const tagStart = /\b(2160p|4k|uhd|1080[pi]|720p|576p|480p|remux|blu ?ray|web ?dl|web ?rip|web|hdtv|dvd ?rip)\b/i.exec(s)?.index ?? s.length;
  const limit = Math.min(cut, tagStart);
  const yearMatch = [...s.matchAll(/\b(19\d{2}|20\d{2})\b/g)].filter((m) => m.index! > 0 && m.index! < limit && (!daily || m.index !== daily.index)).pop();
  const year = yearMatch ? Number(yearMatch[1]) : null;
  if (yearMatch && !airDate) mark(yearMatch.index!);
  // Where the title surely ends: an episode, a date or a year (a resolution can follow a language tag).
  const titleEnd = cut;

  let resolution: string | null = null;
  const resMatch = /\b(2160p|4k|uhd|1080[pi]|720p|576p|480p)\b/i.exec(s);
  if (resMatch) {
    const r = resMatch[1]!.toLowerCase();
    resolution = r === '2160p' || r === '4k' || r === 'uhd' ? '2160p' : r.startsWith('1080') ? '1080p' : r === '720p' ? '720p' : 'SD';
    mark(resMatch.index);
  }

  let source: string | null = null;
  const lower = ` ${s.toLowerCase()} `;
  if (/\bremux\b/.test(lower)) source = 'remux';
  else if (/\b(blu ?ray|bdrip|brrip|bdremux|bd)\b/.test(lower)) source = 'bluray';
  else if (/\bweb ?rip\b/.test(lower)) source = 'webrip';
  else if (/\b(web ?dl|web|amzn|nf|dsnp|hmax|atvp|itunes)\b/.test(lower)) source = 'webdl';
  else if (/\b(hdtv|pdtv|sdtv|dsr|tvrip)\b/.test(lower)) source = 'tv';
  else if (/\b(dvd ?rip|dvd|dvdr|ntsc|pal)\b/.test(lower)) source = 'dvd';
  let theatrical: ParsedRelease['theatrical'] = null;
  for (const th of s.matchAll(/\b(hd ?cam|cam ?rip|cam|hd ?ts|telesync|pdvd|ts|hd ?tc|tc|telecine|(?:dvd ?)?scr|screener)\b/gi)) {
    const t = th[1]!.toLowerCase().replace(/ /g, '');
    // A title can contain these words ("Cam", "TS"), so only count them after a year or resolution.
    if (s[th.index - 1] === '-' && th.index + th[0].length === s.length) continue; // the release group
    if (th.index === 0 || !/\b(19|20)\d{2}\b|\b\d{3,4}p\b/i.test(s.slice(0, th.index))) continue;
    theatrical = t.includes('cam') ? 'cam' : t === 'ts' || t === 'hdts' || t === 'telesync' || t === 'pdvd' ? 'telesync' : t.includes('tc') || t === 'telecine' ? 'telecine' : 'screener';
    mark(th.index);
    break;
  }
  for (const m of [/\b(remux|blu ?ray|bdrip|brrip|web ?dl|web ?rip|web|hdtv|dvd ?rip)\b/i.exec(s)]) if (m) mark(m.index);

  // A language word counts only after the title ("The French Dispatch 2021 1080p" is English, while
  // "Show S01E01 GERMAN 1080p" isn't); with no episode, date or year to end the title, anywhere but the start.
  const from = titleEnd < s.length ? titleEnd : 1;
  const languages: string[] = [];
  for (const [re, code] of LANGUAGES) {
    const m = re.exec(s.slice(from));
    if (!m) continue;
    languages.push(code);
    mark(from + m.index);
  }

  const group = leadGroup?.[1]?.trim() ?? /-([A-Za-z0-9]+)$/.exec(name.trim())?.[1] ?? null;
  const title = s
    .slice(0, cut)
    .replace(/[([{]$/, '')
    .replace(/[\s-]+$/, '')
    .trim();

  return {
    title,
    year,
    season,
    episodes,
    absolute,
    fullSeason,
    airDate,
    resolution,
    source,
    quality: qualityFor(resolution, source),
    proper: /\b(proper|repack|rerip)\b/i.test(s),
    languages: languages.length ? languages : ['en'],
    group,
    theatrical,
  };
}

function range(a: number, b: number): number[] {
  if (b < a || b - a > 100) return [a];
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

/** Lowercase, accent-free, punctuation-free form for comparing titles. */
export function normalizeTitle(t: string): string {
  return t
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an) /, '')
    .trim();
}

/** TV networks that release names (or TMDB) put before or after a show's name: "Dateline NBC", "ABC 20/20". */
const NETWORK = '(abc|nbc|cbs|fox|pbs|cnn|msnbc|bbc|itv|hbo|cw|amc|tlc|hgtv)';
const withoutNetwork = (t: string) => t.replace(new RegExp(`^${NETWORK} (?=.)`), '').replace(new RegExp(`(?<=.) ${NETWORK}$`), '');

export function titlesMatch(releaseTitle: string, ...candidates: string[]): boolean {
  const r = normalizeTitle(releaseTitle);
  return candidates.some((c) => {
    const n = normalizeTitle(c);
    // Allow the release to carry a trailing year or country tag the database title lacks.
    if (r === n || r === `${n} ${new Date().getFullYear()}` || r.replace(/ (19|20)\d{2}$/, '') === n || r.replace(/ (us|uk)$/, '') === n) return true;
    // A network name on one side only: "Dateline" is "Dateline NBC", "ABC 20 20" is "20/20".
    return withoutNetwork(r) === withoutNetwork(n);
  });
}

export const VIDEO_EXTENSIONS = ['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.mov', '.wmv'];
