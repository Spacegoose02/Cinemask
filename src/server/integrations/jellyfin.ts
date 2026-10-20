import { fetchJson, IntegrationError, normalizeResolution } from './http.js';
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

  // ---------------- Writes: collections and posters ----------------

  private async send(method: string, path: string, body?: string | Uint8Array, contentType?: string): Promise<Response> {
    const base = this.url.replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        body,
        headers: { Authorization: `MediaBrowser Token="${this.apiKey}"`, Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new IntegrationError('Jellyfin', 'could not connect');
    }
    if (!res.ok) throw new IntegrationError('Jellyfin', `responded with HTTP ${res.status}`, res.status);
    return res;
  }

  async createCollection(name: string, ids: string[]): Promise<string> {
    const qs = new URLSearchParams({ Name: name, Ids: ids.join(',') });
    const r = (await (await this.send('POST', `/Collections?${qs.toString()}`)).json()) as { Id: string };
    return r.Id;
  }

  async collectionItems(id: string): Promise<string[]> {
    const r = await this.get<{ Items: { Id: string }[] }>(`/Items?ParentId=${encodeURIComponent(id)}`);
    return r.Items.map((i) => i.Id);
  }

  async addToCollection(id: string, ids: string[]) {
    if (ids.length) await this.send('POST', `/Collections/${encodeURIComponent(id)}/Items?Ids=${ids.map(encodeURIComponent).join(',')}`);
  }

  async removeFromCollection(id: string, ids: string[]) {
    if (ids.length) await this.send('DELETE', `/Collections/${encodeURIComponent(id)}/Items?Ids=${ids.map(encodeURIComponent).join(',')}`);
  }

  async renameItem(id: string, name: string) {
    const item = await this.get<Record<string, unknown>>(`/Items/${encodeURIComponent(id)}`);
    await this.send('POST', `/Items/${encodeURIComponent(id)}`, JSON.stringify({ ...item, Name: name }), 'application/json');
  }

  async boxSets(): Promise<{ Id: string; Name: string; Overview?: string }[]> {
    const r = await this.get<{ Items: { Id: string; Name: string; Overview?: string }[] }>('/Items?Recursive=true&IncludeItemTypes=BoxSet&Fields=Overview');
    return r.Items;
  }

  async setPosterUrl(id: string, url: string) {
    await this.send('POST', `/Items/${encodeURIComponent(id)}/RemoteImages/Download?Type=Primary&ImageUrl=${encodeURIComponent(url)}`);
  }

  async uploadPoster(id: string, data: Buffer, contentType: string) {
    await this.send('POST', `/Items/${encodeURIComponent(id)}/Images/Primary`, data.toString('base64'), contentType);
  }

  async image(path: string): Promise<{ type: string; body: Buffer }> {
    const res = await this.send('GET', path);
    return { type: res.headers.get('content-type') ?? 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
  }
}
