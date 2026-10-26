export type MediaKind = 'movie' | 'show';
export type Availability = 'on_server' | 'partial' | 'not_on_server' | 'not_available';

export interface AvailabilityInfo {
  status: Availability;
  resolution: string | null;
  servers: string[];
}

/** A media server's name as people know it. */
export const serverName = (s: string) => ({ plex: 'Plex', jellyfin: 'Jellyfin', bingebandit: 'BingeBandit' })[s] ?? s;

export interface MediaCardData {
  kind: MediaKind;
  tmdbId: number | null;
  title: string;
  year: number | string | null;
  posterPath: string | null;
  availability?: AvailabilityInfo;
  resolution?: string | null;
  /** Plays on Plex/Jellyfin; a show counts once every episode has been played. */
  viewCount?: number | null;
}

/** Image URL for a poster value: a TMDB path, an https link, or an image held by Plex/Jellyfin/the app (proxied). */
export const poster = (path: string | null | undefined, size: 'w185' | 'w342' | 'w500' | 'w780' | 'original' = 'w342') => {
  if (!path) return null;
  if (path.startsWith('/')) return `https://image.tmdb.org/t/p/${size}${path}`;
  if (path.startsWith('https://')) return path;
  if (/^(plex|jellyfin|local|abs):/.test(path)) return `/api/images?src=${encodeURIComponent(path)}`;
  return null;
};

export const STATUS_LABEL: Record<Availability, string> = {
  on_server: 'On server',
  partial: 'Partly on server',
  not_on_server: 'Not on server',
  not_available: 'Not available yet',
};

export const mediaPath = (kind: MediaKind, tmdbId: number) => `/${kind === 'movie' ? 'movie' : 'tv'}/${tmdbId}`;
