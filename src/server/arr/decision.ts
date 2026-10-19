import type { Release } from './indexers.js';
import { parseRelease, titlesMatch, type ParsedRelease } from './parser.js';
import type { Profile } from './profiles.js';
import { qualityRank } from './quality.js';

export interface Target {
  kind: 'movie' | 'show';
  title: string;
  altTitles?: string[];
  year: number | null;
  /** For shows: the episodes still wanted, with the quality already on disk (if any). */
  episodes?: { season: number; episode: number; currentQuality: string | null }[];
  /** For movies: quality already on disk. */
  currentQuality?: string | null;
}

export interface Decision {
  release: Release;
  parsed: ParsedRelease;
  accepted: boolean;
  rejections: string[];
  score: number;
  /** Episodes this release would cover. */
  covers: { season: number; episodes: number[] } | null;
}

/** Decides whether a release is wanted for a target under a quality profile, and how good it is. */
export function decide(release: Release, target: Target, profile: Profile, blocklisted: Set<string>): Decision {
  const parsed = parseRelease(release.title);
  const rejections: string[] = [];
  let covers: Decision['covers'] = null;

  if (!titlesMatch(parsed.title, target.title, ...(target.altTitles ?? []))) rejections.push('Title does not match');

  if (target.kind === 'movie') {
    if (parsed.season !== null || parsed.airDate) rejections.push('Looks like a TV episode');
    if (parsed.year && target.year && Math.abs(parsed.year - target.year) > 1) rejections.push(`Year ${parsed.year} does not match ${target.year}`);
  } else {
    if (parsed.season === null) rejections.push('No season or episode in the name');
    else {
      const wantedInSeason = (target.episodes ?? []).filter((e) => e.season === parsed.season);
      const relEps = parsed.fullSeason ? wantedInSeason.map((e) => e.episode) : parsed.episodes;
      const useful = relEps.filter((n) => wantedInSeason.some((e) => e.episode === n));
      if (!useful.length) rejections.push('No wanted episodes in this release');
      covers = { season: parsed.season, episodes: relEps };
    }
  }

  if (!profile.qualities.includes(parsed.quality)) rejections.push(`${parsed.quality} is not allowed by "${profile.name}"`);
  if (profile.language !== 'any' && !parsed.languages.includes(profile.language) && !parsed.languages.includes('multi')) {
    rejections.push(`Language is ${parsed.languages.join(', ')}, wanted ${profile.language}`);
  }

  // Upgrades: only when better than what's on disk and that is still below the cutoff.
  const current =
    target.kind === 'movie'
      ? (target.currentQuality ?? null)
      : (target.episodes ?? [])
          .filter((e) => covers && e.season === covers.season && covers.episodes.includes(e.episode))
          .map((e) => e.currentQuality)
          .reduce<string | null>((worst, q) => (q === null || worst === null ? null : qualityRank(q) < qualityRank(worst) ? q : worst), 'Remux-2160p');
  if (current) {
    if (!profile.upgradesAllowed) rejections.push('Already have it and upgrades are off');
    else if (qualityRank(current) >= qualityRank(profile.cutoff)) rejections.push(`Already at cutoff (${current})`);
    else if (qualityRank(parsed.quality) <= qualityRank(current)) rejections.push(`Not better than ${current}`);
  }

  if (blocklisted.has(release.title)) rejections.push('Blocklisted after a failed download');
  if (release.protocol === 'torrent' && release.seeders === 0) rejections.push('No seeders');

  const score =
    qualityRank(parsed.quality) * 1000 +
    (parsed.proper ? 100 : 0) +
    (parsed.fullSeason ? 50 : 0) +
    Math.min(release.seeders ?? 50, 99);

  return { release, parsed, accepted: rejections.length === 0, rejections, score, covers };
}

export function bestDecision(decisions: Decision[]): Decision | null {
  return decisions.filter((d) => d.accepted).sort((a, b) => b.score - a.score)[0] ?? null;
}
