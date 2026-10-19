/**
 * Release qualities, lowest to highest. A quality profile allows a subset and names a cutoff:
 * once a file at or above the cutoff exists, the app stops looking for upgrades.
 */
export const QUALITIES = [
  { id: 'Unknown', resolution: null, source: 'unknown' },
  { id: 'SDTV', resolution: 'SD', source: 'tv' },
  { id: 'DVD', resolution: 'SD', source: 'dvd' },
  { id: 'WEBRip-480p', resolution: 'SD', source: 'webrip' },
  { id: 'WEBDL-480p', resolution: 'SD', source: 'webdl' },
  { id: 'HDTV-720p', resolution: '720p', source: 'tv' },
  { id: 'WEBRip-720p', resolution: '720p', source: 'webrip' },
  { id: 'WEBDL-720p', resolution: '720p', source: 'webdl' },
  { id: 'Bluray-720p', resolution: '720p', source: 'bluray' },
  { id: 'HDTV-1080p', resolution: '1080p', source: 'tv' },
  { id: 'WEBRip-1080p', resolution: '1080p', source: 'webrip' },
  { id: 'WEBDL-1080p', resolution: '1080p', source: 'webdl' },
  { id: 'Bluray-1080p', resolution: '1080p', source: 'bluray' },
  { id: 'Remux-1080p', resolution: '1080p', source: 'remux' },
  { id: 'HDTV-2160p', resolution: '2160p', source: 'tv' },
  { id: 'WEBRip-2160p', resolution: '2160p', source: 'webrip' },
  { id: 'WEBDL-2160p', resolution: '2160p', source: 'webdl' },
  { id: 'Bluray-2160p', resolution: '2160p', source: 'bluray' },
  { id: 'Remux-2160p', resolution: '2160p', source: 'remux' },
] as const;

export type QualityId = (typeof QUALITIES)[number]['id'];
export const QUALITY_IDS = QUALITIES.map((q) => q.id) as [QualityId, ...QualityId[]];

export function qualityRank(id: string | null | undefined): number {
  return QUALITIES.findIndex((q) => q.id === id);
}

export function qualityFor(resolution: string | null, source: string | null): QualityId {
  if (!resolution && !source) return 'Unknown';
  const res = resolution ?? (source === 'dvd' || source === 'tv' ? 'SD' : '1080p');
  const src = source ?? 'webdl';
  if (res === 'SD') {
    if (src === 'dvd' || src === 'bluray' || src === 'remux') return 'DVD';
    if (src === 'webrip') return 'WEBRip-480p';
    if (src === 'webdl') return 'WEBDL-480p';
    return 'SDTV';
  }
  const map: Record<string, string> = { tv: 'HDTV', webrip: 'WEBRip', webdl: 'WEBDL', bluray: 'Bluray', remux: 'Remux', dvd: 'WEBDL' };
  const id = `${map[src] ?? 'WEBDL'}-${res}`;
  return (QUALITY_IDS as string[]).includes(id) ? (id as QualityId) : 'Unknown';
}

const byRes = (...res: string[]) => QUALITIES.filter((q) => q.resolution && res.includes(q.resolution)).map((q) => q.id);

export interface ProfileSeed {
  name: string;
  qualities: QualityId[];
  cutoff: QualityId;
}

/** The profiles a new install starts with, matching the board's list. */
export const DEFAULT_PROFILES: ProfileSeed[] = [
  { name: 'Any', qualities: QUALITY_IDS.filter((q) => q !== 'Unknown'), cutoff: 'WEBDL-1080p' },
  { name: 'SD', qualities: byRes('SD'), cutoff: 'DVD' },
  { name: 'HD-720p', qualities: byRes('720p'), cutoff: 'Bluray-720p' },
  { name: 'HD-1080p', qualities: byRes('1080p'), cutoff: 'Bluray-1080p' },
  { name: 'Ultra-HD', qualities: byRes('2160p'), cutoff: 'Bluray-2160p' },
  { name: '720p or above', qualities: byRes('720p', '1080p', '2160p'), cutoff: 'WEBDL-1080p' },
  { name: '1080p or above', qualities: byRes('1080p', '2160p'), cutoff: 'WEBDL-2160p' },
];
