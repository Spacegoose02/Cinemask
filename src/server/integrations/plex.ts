import { fetchJson, IntegrationError, normalizeResolution } from './http.js';
import { rollUpViews, type MediaServerClient, type ServerItem } from './mediaserver.js';

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
  viewCount?: number;
  lastViewedAt?: number;
  Label?: { tag: string }[];
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
          viewCount: m.viewCount ?? 0,
          lastViewedAt: m.lastViewedAt ? m.lastViewedAt * 1000 : null,
          labels: (m.Label ?? []).map((l) => l.tag),
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
          show.episodes!.push({
            season: e.parentIndex,
            episode: e.index,
            title: e.title,
            resolution: normalizeResolution(e.Media?.[0]?.videoResolution),
            viewCount: e.viewCount ?? 0,
            lastViewedAt: e.lastViewedAt ? e.lastViewedAt * 1000 : null,
          });
        }
        for (const item of byKey.values()) rollUpViews(item);
      }
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
        headers: { 'X-Plex-Token': this.token, Accept: 'application/json', ...(contentType ? { 'Content-Type': contentType } : {}) },
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new IntegrationError('Plex', 'could not connect');
    }
    if (!res.ok) throw new IntegrationError('Plex', `responded with HTTP ${res.status}`, res.status);
    return res;
  }

  /** The library section an item lives in (needed to edit its tags). */
  async sectionOf(ratingKey: string): Promise<string> {
    const r = await this.get<{ librarySectionID?: number | string; Metadata?: { librarySectionID?: number | string }[] }>(`/library/metadata/${encodeURIComponent(ratingKey)}`);
    const id = r.Metadata?.[0]?.librarySectionID ?? r.librarySectionID;
    if (id === undefined) throw new IntegrationError('Plex', 'could not find the item\'s library');
    return String(id);
  }

  /** Adds or removes a label on an item. Labels are what Plex smart collections and sharing filters use. */
  async setLabel(section: string, kind: 'movie' | 'show', ratingKey: string, label: string, remove = false) {
    const qs = new URLSearchParams({ type: kind === 'movie' ? '1' : '2', id: ratingKey, includeExternalMedia: '1', 'label.locked': '1' });
    qs.set(remove ? 'label[].tag.tag-' : 'label[0].tag.tag', label);
    await this.send('PUT', `/library/sections/${encodeURIComponent(section)}/all?${qs.toString()}`);
  }

  /** Adds or removes a collection tag on an item. Plex creates the collection when the first item is tagged. */
  async setCollectionTag(section: string, kind: 'movie' | 'show', ratingKey: string, name: string, remove = false) {
    const qs = new URLSearchParams({ type: kind === 'movie' ? '1' : '2', id: ratingKey, includeExternalMedia: '1', 'collection.locked': '1' });
    qs.set(remove ? 'collection[].tag.tag-' : 'collection[0].tag.tag', name);
    await this.send('PUT', `/library/sections/${encodeURIComponent(section)}/all?${qs.toString()}`);
  }

  async collections(): Promise<{ ratingKey: string; title: string; summary?: string; thumb?: string; section: string; subtype?: string }[]> {
    const sections = await this.get<{ Directory?: { key: string; type: string }[] }>('/library/sections');
    const out: { ratingKey: string; title: string; summary?: string; thumb?: string; section: string; subtype?: string }[] = [];
    for (const sec of sections.Directory ?? []) {
      if (sec.type !== 'movie' && sec.type !== 'show') continue;
      const r = await this.get<{ Metadata?: { ratingKey: string; title: string; summary?: string; thumb?: string; subtype?: string }[] }>(`/library/sections/${sec.key}/collections`);
      for (const c of r.Metadata ?? []) out.push({ ...c, section: sec.key });
    }
    return out;
  }

  async collectionChildren(ratingKey: string): Promise<string[]> {
    const r = await this.get<{ Metadata?: { ratingKey: string }[] }>(`/library/collections/${encodeURIComponent(ratingKey)}/children`);
    return (r.Metadata ?? []).map((m) => m.ratingKey);
  }

  async renameCollection(section: string, ratingKey: string, title: string) {
    const qs = new URLSearchParams({ type: '18', id: ratingKey, 'title.value': title, 'title.locked': '1' });
    await this.send('PUT', `/library/sections/${encodeURIComponent(section)}/all?${qs.toString()}`);
  }

  async setPosterUrl(ratingKey: string, url: string) {
    await this.send('POST', `/library/metadata/${encodeURIComponent(ratingKey)}/posters?url=${encodeURIComponent(url)}`);
  }

  async uploadPoster(ratingKey: string, data: Buffer, contentType: string) {
    await this.send('POST', `/library/metadata/${encodeURIComponent(ratingKey)}/posters`, new Uint8Array(data), contentType);
  }

  /** Fetches an image from the server so the browser never sees the Plex token. */
  async image(path: string): Promise<{ type: string; body: Buffer }> {
    const res = await this.send('GET', path);
    return { type: res.headers.get('content-type') ?? 'image/jpeg', body: Buffer.from(await res.arrayBuffer()) };
  }
}
