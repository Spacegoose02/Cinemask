import { fetchJson, normalizeResolution } from './http.js';
import type { MediaServerClient, ServerItem } from './mediaserver.js';

interface JfItem {
  Id: string;
  Type: string;
  Name: string;
  ProductionYear?: number;
  DateCreated?: string;
  ProviderIds?: Record<string, string>;
  MediaStreams?: { Type: string; Height?: number }[];
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
}

function height(item: JfItem): number | undefined {
  return item.MediaStreams?.find((s) => s.Type === 'Video')?.Height;
}

export class JellyfinClient implements MediaServerClient {
  constructor(
    private readonly url: string,
    private readonly apiKey: string,
  ) {}

  private get<T>(path: string) {
    const base = this.url.replace(/\/+$/, '');
    return fetchJson<T>('Jellyfin', `${base}${path}`, { headers: { Authorization: `MediaBrowser Token="${this.apiKey}"` } }, 60_000);
  }

  async test() {
    const info = await this.get<{ ServerName: string; Version: string; Id: string }>('/System/Info');
    return { name: info.ServerName, version: info.Version, machineId: info.Id };
  }

  async refresh() {
    const base = this.url.replace(/\/+$/, '');
    await fetch(`${base}/Library/Refresh`, { method: 'POST', headers: { Authorization: `MediaBrowser Token="${this.apiKey}"` }, signal: AbortSignal.timeout(10_000) });
  }

  async fetchLibrary(): Promise<ServerItem[]> {
    const fields = 'Fields=ProviderIds,MediaStreams,DateCreated,ProductionYear';
    const top = await this.get<{ Items: JfItem[] }>(`/Items?Recursive=true&IncludeItemTypes=Movie,Series&${fields}`);
    const byId = new Map<string, ServerItem>();
    const items: ServerItem[] = top.Items.map((i) => {
      const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : null);
      const item: ServerItem = {
        externalKey: i.Id,
        kind: i.Type === 'Movie' ? 'movie' : 'show',
        title: i.Name,
        year: i.ProductionYear ?? null,
        tmdbId: num(i.ProviderIds?.Tmdb),
        tvdbId: num(i.ProviderIds?.Tvdb),
        imdbId: i.ProviderIds?.Imdb ?? null,
        resolution: i.Type === 'Movie' ? normalizeResolution(height(i)) : null,
        addedAt: i.DateCreated ? Date.parse(i.DateCreated) : null,
        episodes: i.Type === 'Series' ? [] : undefined,
      };
      byId.set(i.Id, item);
      return item;
    });
    const eps = await this.get<{ Items: JfItem[] }>(`/Items?Recursive=true&IncludeItemTypes=Episode&Fields=MediaStreams`);
    for (const e of eps.Items) {
      const show = e.SeriesId ? byId.get(e.SeriesId) : undefined;
      if (!show || e.ParentIndexNumber === undefined || e.IndexNumber === undefined) continue;
      show.episodes!.push({ season: e.ParentIndexNumber, episode: e.IndexNumber, title: e.Name, resolution: normalizeResolution(height(e)) });
    }
    return items;
  }
}
