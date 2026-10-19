import { fetchJson, normalizeResolution } from './http.js';
import type { MediaServerClient, ServerItem } from './mediaserver.js';

interface PlexGuid {
  id: string;
}
interface PlexMetadata {
  ratingKey: string;
  type: string;
  title: string;
  year?: number;
  addedAt?: number;
  Guid?: PlexGuid[];
  Media?: { videoResolution?: string }[];
  grandparentRatingKey?: string;
  parentIndex?: number;
  index?: number;
}
interface Container<T> {
  MediaContainer: T;
}

export function idsFromGuids(guids: PlexGuid[] | undefined) {
  const get = (scheme: string) => guids?.find((g) => g.id.startsWith(`${scheme}://`))?.id.slice(scheme.length + 3) ?? null;
  const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : null);
  return { tmdbId: num(get('tmdb')), tvdbId: num(get('tvdb')), imdbId: get('imdb') };
}

export class PlexClient implements MediaServerClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  private get<T>(path: string) {
    const base = this.url.replace(/\/+$/, '');
    return fetchJson<Container<T>>('Plex', `${base}${path}`, { headers: { 'X-Plex-Token': this.token } }, 60_000).then((r) => r.MediaContainer);
  }

  async test() {
    const id = await this.get<{ friendlyName: string; version: string; machineIdentifier: string }>('/');
    return { name: id.friendlyName, version: id.version, machineId: id.machineIdentifier };
  }

  async fetchLibrary(): Promise<ServerItem[]> {
    const sections = await this.get<{ Directory?: { key: string; type: string }[] }>('/library/sections');
    const items: ServerItem[] = [];
    for (const section of sections.Directory ?? []) {
      if (section.type !== 'movie' && section.type !== 'show') continue;
      const all = await this.get<{ Metadata?: PlexMetadata[] }>(`/library/sections/${section.key}/all?includeGuids=1`);
      const byKey = new Map<string, ServerItem>();
      for (const m of all.Metadata ?? []) {
        const item: ServerItem = {
          externalKey: m.ratingKey,
          kind: section.type === 'movie' ? 'movie' : 'show',
          title: m.title,
          year: m.year ?? null,
          ...idsFromGuids(m.Guid),
          resolution: section.type === 'movie' ? normalizeResolution(m.Media?.[0]?.videoResolution) : null,
          addedAt: m.addedAt ? m.addedAt * 1000 : null,
          episodes: section.type === 'show' ? [] : undefined,
        };
        byKey.set(m.ratingKey, item);
        items.push(item);
      }
      if (section.type === 'show') {
        // type=4 lists every episode in the section in one call.
        const eps = await this.get<{ Metadata?: PlexMetadata[] }>(`/library/sections/${section.key}/all?type=4`);
        for (const e of eps.Metadata ?? []) {
          const show = e.grandparentRatingKey ? byKey.get(e.grandparentRatingKey) : undefined;
          if (!show || e.parentIndex === undefined || e.index === undefined) continue;
          show.episodes!.push({ season: e.parentIndex, episode: e.index, title: e.title, resolution: normalizeResolution(e.Media?.[0]?.videoResolution) });
        }
      }
    }
    return items;
  }
}
