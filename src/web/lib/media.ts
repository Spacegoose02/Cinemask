export type MediaKind = 'movie' | 'show';
export type Availability = 'on_server' | 'partial' | 'not_on_server' | 'not_available';

export interface AvailabilityInfo {
  status: Availability;
  resolution: string | null;
  servers: string[];
}

export interface MediaCardData {
  kind: MediaKind;
  tmdbId: number | null;
  title: string;
  year: number | string | null;
  posterPath: string | null;
  availability?: AvailabilityInfo;
  resolution?: string | null;
}

export const poster = (path: string | null | undefined, size: 'w185' | 'w342' | 'w500' | 'w780' | 'original' = 'w342') =>
  path ? `https://image.tmdb.org/t/p/${size}${path}` : null;

export const STATUS_LABEL: Record<Availability, string> = {
  on_server: 'On server',
  partial: 'Partly on server',
  not_on_server: 'Not on server',
  not_available: 'Not available yet',
};

export const mediaPath = (kind: MediaKind, tmdbId: number) => `/${kind === 'movie' ? 'movie' : 'tv'}/${tmdbId}`;
