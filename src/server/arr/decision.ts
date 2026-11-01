import type { Release } from './indexers.js';
import { parseRelease, titlesMatch, type ParsedRelease } from './parser.js';
import type { Profile } from './profiles.js';
import { qualityRank } from './quality.js';
import { scoreRelease, type CustomFormat } from './formats.js';

export interface Target {
  kind: 'movie' | 'show';
  title: string;
  altTitles?: string[];
  year: number | null;
  /** For shows: the episodes still wanted, with the quality already on disk (if any). */
  episodes?: { season: number; episode: number; currentQuality: string | null; airDate?: string | null; currentFormatScore?: number | null }[];
  /** For movies: quality already on disk. */
  currentQuality?: string | null;
  /** For movies: the custom format score of the file on disk, when known. */
  currentFormatScore?: number | null;
}

export interface Decision {
  release: Release;
  parsed: ParsedRelease;
  accepted: boolean;
  rejections: string[];
  score: number;
  /** Episodes this release would cover. */
  covers: { season: number; episodes: number[] } | null;
  /** Set when the release is bigger than the size limit: its size per movie or per episode, in bytes. */
  oversize: number | null;
  /** Set when the only thing holding the release back is the delay profile: when it may be grabbed. */
  delayedUntil: number | null;
  /** Custom format score under the profile, and the formats it matched. */
  formatScore: number;
  formats: string[];
}

export interface DecideOptions {
  /** Reject CAM, telesync, telecine and screener copies. */
  skipCam?: boolean;
  /** Largest wanted size in bytes, per movie or per episode. Bigger releases are still accepted but only used when nothing smaller is. */
  maxSize?: number | null;
  /** Delay profile: minutes to wait after a release appears, per protocol, before grabbing it automatically. */
  delay?: { usenet: number; torrent: number; bypassAtCutoff: boolean };
  /** Releases of this protocol win over equal ones of the other. */
  preferredProtocol?: 'any' | 'usenet' | 'torrent';
  /** For tests: the current time. */
  now?: number;
  /** Custom formats the profile's scores refer to. */
  formats?: CustomFormat[];
}

const THEATRICAL_LABEL = { cam: 'CAM', telesync: 'telesync', telecine: 'telecine', screener: 'screener' } as const;

/** Decides whether a release is wanted for a target under a quality profile, and how good it is. */
export function decide(release: Release, target: Target, profile: Profile, blocklisted: Set<string>, opts: DecideOptions = {}): Decision {
  const parsed = parseRelease(release.title);
  const rejections: string[] = [];
  let covers: Decision['covers'] = null;

  if (!titlesMatch(parsed.title, target.title, ...(target.altTitles ?? []))) rejections.push('Title does not match');

  if (target.kind === 'movie') {
    if (parsed.season !== null || parsed.airDate) rejections.push('Looks like a TV episode');
    if (parsed.year && target.year && Math.abs(parsed.year - target.year) > 1) rejections.push(`Year ${parsed.year} does not match ${target.year}`);
  } else {
    if (parsed.season === null && parsed.airDate) {
      // News and talk shows (20/20, 48 Hours, nightly shows) name episodes by the date they aired.
      const ep = (target.episodes ?? []).find((e) => e.airDate === parsed.airDate);
      if (ep) covers = { season: ep.season, episodes: [ep.episode] };
      else rejections.push(`No wanted episode aired on ${parsed.airDate}`);
    } else if (parsed.season === null) rejections.push('No season or episode in the name');
    else {
      const wantedInSeason = (target.episodes ?? []).filter((e) => e.season === parsed.season);
      const relEps = parsed.fullSeason ? wantedInSeason.map((e) => e.episode) : parsed.episodes;
      const useful = relEps.filter((n) => wantedInSeason.some((e) => e.episode === n));
      if (!useful.length) rejections.push('No wanted episodes in this release');
      covers = { season: parsed.season, episodes: relEps };
    }
  }

  if (opts.skipCam && parsed.theatrical) rejections.push(`${THEATRICAL_LABEL[parsed.theatrical]} copy (turned off in Settings → Media management)`);
  if (!profile.qualities.includes(parsed.quality)) rejections.push(`${parsed.quality} is not allowed by "${profile.name}"`);
  if (profile.language !== 'any' && !parsed.languages.includes(profile.language) && !parsed.languages.includes('multi')) {
    rejections.push(`Language is ${parsed.languages.join(', ')}, wanted ${profile.language}`);
  }

  // A season pack is judged per episode, so a 20 GB pack of ten episodes passes a 3 GB limit.
  const perItem = release.size ? release.size / Math.max(1, target.kind === 'show' ? (covers?.episodes.length ?? 1) : 1) : null;

  // Custom formats: a release scoring under the profile's minimum isn't wanted.
  const fmt = opts.formats?.length ? scoreRelease(opts.formats, profile.formatScores ?? {}, release, parsed, perItem) : { score: 0, matched: [] };
  if (fmt.score < (profile.minFormatScore ?? 0)) rejections.push(`Format score ${fmt.score} is below the profile's minimum of ${profile.minFormatScore}`);

  // Upgrades: only when better than what's on disk: a better quality while under the cutoff, or the
  // same quality with a higher format score while under the profile's "upgrade until" score.
  const covered = (target.episodes ?? []).filter((e) => covers && e.season === covers.season && covers.episodes.includes(e.episode));
  const current =
    target.kind === 'movie'
      ? (target.currentQuality ?? null)
      : covered.map((e) => e.currentQuality).reduce<string | null>((worst, q) => (q === null || worst === null ? null : qualityRank(q) < qualityRank(worst) ? q : worst), 'Remux-2160p');
  const currentScore =
    target.kind === 'movie'
      ? (target.currentFormatScore ?? null)
      : covered.some((e) => e.currentFormatScore === null || e.currentFormatScore === undefined)
        ? null
        : covered.length
          ? Math.min(...covered.map((e) => e.currentFormatScore!))
          : null;
  if (current) {
    const atCutoff = qualityRank(current) >= qualityRank(profile.cutoff);
    const betterQuality = !atCutoff && qualityRank(parsed.quality) > qualityRank(current);
    const until = profile.upgradeUntilFormatScore ?? 0;
    const betterFormat = until > 0 && currentScore !== null && currentScore < until && qualityRank(parsed.quality) >= qualityRank(current) && fmt.score > currentScore;
    if (!profile.upgradesAllowed) rejections.push('Already have it and upgrades are off');
    else if (betterQuality || betterFormat) {
      // wanted
    } else if (atCutoff) rejections.push(until > 0 && currentScore !== null && currentScore < until ? `Format score ${fmt.score} is not better than ${currentScore}` : `Already at cutoff (${current})`);
    else rejections.push(`Not better than ${current}`);
  }

  if (blocklisted.has(release.title)) rejections.push('Blocklisted after a failed download');
  if (release.protocol === 'torrent' && release.seeders === 0) rejections.push('No seeders');

  // Delay profile: give a better release time to turn up, unless this one already meets the cutoff.
  let delayedUntil: number | null = null;
  const wait = opts.delay ? (release.protocol === 'usenet' ? opts.delay.usenet : release.protocol === 'torrent' ? opts.delay.torrent : 0) : 0;
  if (wait > 0 && release.publishedAt && !(opts.delay!.bypassAtCutoff && qualityRank(parsed.quality) >= qualityRank(profile.cutoff))) {
    const until = release.publishedAt + wait * 60_000;
    const now = opts.now ?? Date.now();
    if (until > now) {
      if (!rejections.length) delayedUntil = until;
      rejections.push(`Waiting ${Math.ceil((until - now) / 60_000)} more min for a better release (delay profile)`);
    }
  }

  // Quality first, then the format score, then the smaller things.
  const score =
    qualityRank(parsed.quality) * 1e9 +
    Math.max(-99_999, Math.min(99_999, fmt.score)) * 1000 +
    (opts.preferredProtocol && opts.preferredProtocol !== 'any' && release.protocol === opts.preferredProtocol ? 200 : 0) +
    (parsed.proper ? 100 : 0) +
    (parsed.fullSeason ? 50 : 0) +
    Math.min(release.seeders ?? 50, 99);

  const oversize = opts.maxSize && perItem && perItem > opts.maxSize ? perItem : null;

  return { release, parsed, accepted: rejections.length === 0, rejections, score, covers, oversize, delayedUntil, formatScore: fmt.score, formats: fmt.matched };
}

/** Best first: anything within the size limit beats anything over it, then by score. */
export function byPreference(a: Decision, b: Decision): number {
  return Number(a.oversize !== null) - Number(b.oversize !== null) || b.score - a.score;
}

export function bestDecision(decisions: Decision[]): Decision | null {
  return decisions.filter((d) => d.accepted).sort(byPreference)[0] ?? null;
}
