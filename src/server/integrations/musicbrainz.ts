import { eq } from 'drizzle-orm';
import type { Orm } from '../db/database.js';
import { httpCache } from '../db/schema.js';
import { sha256 } from '../security/crypto.js';
import { fetchJson } from './http.js';

/**
 * MusicBrainz: free music metadata, no key. Its rules ask for a descriptive User-Agent and at most
 * one request a second, so calls queue behind each other and answers are cached.
 * Albums are release groups (one album, all its editions); covers come from the Cover Art Archive.
 */
export const MUSICBRAINZ = 'https://musicbrainz.org/ws/2';
const SERVICE = 'MusicBrainz';
const DAY = 24 * 60 * 60 * 1000;

export const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ArtistCard {
  mbid: string;
  name: string;
  disambiguation: string | null;
  country: string | null;
  type: string | null;
}

export interface AlbumCard {
  mbid: string;
  title: string;
  artist: string;
  artistMbid: string | null;
  year: number | null;
  /** Album, EP, Single… plus secondary types such as Live or Compilation. */
  type: string;
  secondary: string[];
  cover: string;
}

interface MbArtist {
  id: string;
  name: string;
  disambiguation?: string;
  country?: string;
  type?: string;
}
interface MbReleaseGroup {
  id: string;
  title: string;
  'first-release-date'?: string;
  'primary-type'?: string;
  'secondary-types'?: string[];
  'artist-credit'?: { name: string; joinphrase?: string; artist: { id: string; name: string } }[];
}

export const coverArt = (mbid: string, size: 250 | 500 = 250) => `https://coverartarchive.org/release-group/${mbid}/front-${size}`;

const toArtist = (a: MbArtist): ArtistCard => ({ mbid: a.id, name: a.name, disambiguation: a.disambiguation || null, country: a.country ?? null, type: a.type ?? null });

export function toAlbum(rg: MbReleaseGroup, fallbackArtist?: { mbid: string; name: string }): AlbumCard {
  const credit = rg['artist-credit'];
  const year = Number(rg['first-release-date']?.slice(0, 4));
  return {
    mbid: rg.id,
    title: rg.title,
    artist: credit?.length ? credit.map((c) => `${c.name}${c.joinphrase ?? ''}`).join('') : (fallbackArtist?.name ?? 'Unknown artist'),
    artistMbid: credit?.[0]?.artist.id ?? fallbackArtist?.mbid ?? null,
    year: Number.isInteger(year) && year > 0 ? year : null,
    type: rg['primary-type'] ?? 'Other',
    secondary: rg['secondary-types'] ?? [],
    cover: coverArt(rg.id),
  };
}

let queue: Promise<unknown> = Promise.resolve();
let last = 0;
let interval = 1100;
/** Tests talk to a fake MusicBrainz and needn't wait. */
export const setMusicBrainzInterval = (ms: number) => (interval = ms);

export class MusicBrainzClient {
  constructor(
    private readonly db: () => Orm,
    private readonly userAgent: string,
  ) {}

  private async get<T>(path: string, ttlMs: number, fresh = false): Promise<T> {
    const key = sha256(`mb:${path}`);
    const hit = fresh ? null : this.db().select().from(httpCache).where(eq(httpCache.key, key)).get();
    if (hit && hit.expiresAt > Date.now()) return JSON.parse(hit.body) as T;
    // One request a second, across the whole app.
    const run = queue.then(async () => {
      const wait = last + interval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fetchJson<T>(SERVICE, `${MUSICBRAINZ}${path}${path.includes('?') ? '&' : '?'}fmt=json`, { headers: { 'User-Agent': this.userAgent } }, 20_000);
    });
    queue = run.catch(() => undefined);
    const data = await run;
    const body = JSON.stringify(data);
    this.db()
      .insert(httpCache)
      .values({ key, body, expiresAt: Date.now() + ttlMs })
      .onConflictDoUpdate({ target: httpCache.key, set: { body, expiresAt: Date.now() + ttlMs } })
      .run();
    return data;
  }

  async searchArtists(q: string): Promise<ArtistCard[]> {
    const r = await this.get<{ artists: MbArtist[] }>(`/artist?query=${encodeURIComponent(q)}&limit=20`, DAY);
    return r.artists.map(toArtist);
  }

  async searchAlbums(q: string): Promise<AlbumCard[]> {
    const r = await this.get<{ 'release-groups': MbReleaseGroup[] }>(`/release-group?query=${encodeURIComponent(q)}&limit=25`, DAY);
    return r['release-groups'].map((rg) => toAlbum(rg));
  }

  async artist(mbid: string): Promise<ArtistCard | null> {
    try {
      return toArtist(await this.get<MbArtist>(`/artist/${mbid}`, 7 * DAY));
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /** An artist's albums and EPs (studio releases first), newest first. `fresh` skips the cache, for spotting new releases. */
  async albumsBy(artist: ArtistCard, fresh = false): Promise<AlbumCard[]> {
    const r = await this.get<{ 'release-groups': MbReleaseGroup[] }>(`/release-group?artist=${artist.mbid}&type=album|ep&limit=100`, DAY, fresh);
    return r['release-groups']
      .map((rg) => toAlbum(rg, artist))
      .sort((a, b) => Number(a.secondary.length > 0) - Number(b.secondary.length > 0) || (b.year ?? 0) - (a.year ?? 0));
  }

  async album(mbid: string): Promise<AlbumCard | null> {
    try {
      return toAlbum(await this.get<MbReleaseGroup>(`/release-group/${mbid}?inc=artist-credits`, 7 * DAY));
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }
}
