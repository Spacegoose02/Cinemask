/**
 * File and folder naming from templates such as
 * "{Series Title} - S{season:00}E{episode:00} - {Episode Title}".
 */
export interface NamingValues {
  movieTitle?: string;
  seriesTitle?: string;
  year?: number | null;
  season?: number;
  episodes?: number[];
  episodeTitle?: string | null;
  quality?: string | null;
  resolution?: string | null;
  airDate?: string | null;
  tmdbId?: number;
}

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const ILLEGAL = /[<>"/\\|?*\u0000-\u001f]/g;

/** Makes a single path segment safe on Windows, macOS and Linux shares. */
export function sanitizeSegment(s: string): string {
  return s
    .replace(/:/g, ' -')
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
}

function pad(n: number, spec: string | undefined): string {
  return spec && /^0+$/.test(spec) ? String(n).padStart(spec.length, '0') : String(n);
}

export function renderName(template: string, v: NamingValues): string {
  const out = template.replace(/\{([A-Za-z ]+)(?::([0-9]+))?\}/g, (_m, rawToken: string, spec?: string) => {
    const token = rawToken.trim().toLowerCase();
    switch (token) {
      case 'movie title':
        return v.movieTitle ?? '';
      case 'series title':
        return v.seriesTitle ?? '';
      case 'year':
        return v.year ? String(v.year) : '';
      case 'season':
        return v.season !== undefined ? pad(v.season, spec) : '';
      case 'episode': {
        const eps = v.episodes ?? [];
        if (!eps.length) return '';
        // Multi-episode files: 01-E02
        return eps.length > 1 ? `${pad(eps[0]!, spec)}-E${pad(eps[eps.length - 1]!, spec)}` : pad(eps[0]!, spec);
      }
      case 'episode title':
        return v.episodeTitle ?? '';
      case 'quality':
        return v.quality ?? '';
      case 'resolution':
        return v.resolution ?? '';
      case 'air date':
        return v.airDate ?? '';
      case 'tmdb id':
        return v.tmdbId ? String(v.tmdbId) : '';
      default:
        return '';
    }
  });
  // Tidy separators left behind by empty tokens, e.g. "Title () - " → "Title".
  const tidy = out
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/(\s-\s*)+$/g, '')
    .replace(/\s-\s-\s/g, ' - ')
    .replace(/\s{2,}/g, ' ');
  return sanitizeSegment(tidy);
}

export const NAMING_TOKENS = ['{Movie Title}', '{Series Title}', '{Year}', '{season:00}', '{episode:00}', '{Episode Title}', '{Quality}', '{Resolution}', '{Air Date}', '{TMDB Id}'];
