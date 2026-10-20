import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { fetchJson, IntegrationError } from '../integrations/http.js';

export type Protocol = 'torrent' | 'usenet';

export interface Release {
  guid: string;
  title: string;
  downloadUrl: string;
  infoUrl: string | null;
  size: number;
  publishedAt: number | null;
  indexer: string;
  indexerId: number;
  protocol: Protocol;
  seeders: number | null;
  peers: number | null;
}

export interface SearchQuery {
  type: 'search' | 'movie' | 'tvsearch' | 'book' | 'audio';
  q?: string;
  imdbId?: string | null;
  tmdbId?: number | null;
  tvdbId?: number | null;
  season?: number;
  episode?: number;
  categories: number[];
  /** Omit q/ids to fetch the latest releases (RSS). */
  limit?: number;
}

/** Standard Newznab category ids. */
export const CATEGORIES = { movies: [2000], tv: [5000], audiobooks: [3030], books: [7000, 7020] };

export interface IndexerConfig {
  id: number;
  name: string;
  type: 'newznab' | 'torznab';
  url: string;
  apiKey: string;
  categories: number[];
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, isArray: (name) => name === 'item' || name.endsWith(':attr') });

type XmlNode = Record<string, unknown>;

function attrs(item: XmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['torznab:attr', 'newznab:attr']) {
    for (const a of (item[key] as XmlNode[] | undefined) ?? []) out[String(a['@_name'])] = String(a['@_value']);
  }
  return out;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : v && typeof v === 'object' && '#text' in v ? String((v as XmlNode)['#text']) : v === undefined ? '' : String(v));

/** Parses a Newznab/Torznab RSS response. Exported for tests. */
export function parseFeed(body: string, indexer: Pick<IndexerConfig, 'id' | 'name' | 'type'>): Release[] {
  const doc = xml.parse(body) as XmlNode;
  const error = doc.error as XmlNode | undefined;
  if (error) throw new IntegrationError(indexer.name, String(error['@_description'] ?? 'returned an error'));
  const channel = ((doc.rss as XmlNode | undefined)?.channel ?? {}) as XmlNode;
  const items = (channel.item as XmlNode[] | undefined) ?? [];
  const protocol: Protocol = indexer.type === 'torznab' ? 'torrent' : 'usenet';
  return items.flatMap((item) => {
    const a = attrs(item);
    const enclosure = item.enclosure as XmlNode | undefined;
    const link = a.magneturl || text(enclosure?.['@_url']) || text(item.link);
    const title = text(item.title);
    if (!title || !link) return [];
    const size = Number(a.size ?? enclosure?.['@_length'] ?? item.size ?? 0);
    const pub = text(item.pubDate);
    return [
      {
        // An opaque key: an indexer's guid (or the link standing in for one) can carry its API key or passkey.
        guid: createHash('sha256').update(`${indexer.id}:${text(item.guid) || link}`).digest('hex').slice(0, 32),
        title,
        downloadUrl: link,
        infoUrl: text(item.comments) || null,
        size: Number.isFinite(size) ? size : 0,
        publishedAt: pub ? Date.parse(pub) || null : null,
        indexer: indexer.name,
        indexerId: indexer.id,
        protocol,
        seeders: a.seeders !== undefined ? Number(a.seeders) : null,
        peers: a.peers !== undefined ? Number(a.peers) : null,
      },
    ];
  });
}

export async function searchIndexer(cfg: IndexerConfig, query: SearchQuery): Promise<Release[]> {
  const params = new URLSearchParams({ t: query.type, apikey: cfg.apiKey, extended: '1', limit: String(query.limit ?? 100) });
  const cats = cfg.categories.length ? query.categories.filter((c) => cfg.categories.some((x) => Math.floor(x / 1000) === Math.floor(c / 1000))) : query.categories;
  if (cats.length) params.set('cat', cats.join(','));
  if (query.q) params.set('q', query.q);
  if (query.imdbId) params.set('imdbid', query.imdbId.replace(/^tt/, ''));
  if (query.tmdbId) params.set('tmdbid', String(query.tmdbId));
  if (query.tvdbId) params.set('tvdbid', String(query.tvdbId));
  if (query.season !== undefined) params.set('season', String(query.season));
  if (query.episode !== undefined) params.set('ep', String(query.episode));
  const base = cfg.url.replace(/\/+$/, '').replace(/\/api$/, '');
  let res: Response;
  try {
    res = await fetch(`${base}/api?${params.toString()}`, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new IntegrationError(cfg.name, 'could not connect');
  }
  if (res.status === 401 || res.status === 403) throw new IntegrationError(cfg.name, 'the API key was rejected', res.status);
  if (!res.ok) throw new IntegrationError(cfg.name, `responded with HTTP ${res.status}`, res.status);
  return parseFeed(await res.text(), cfg);
}

export async function testIndexer(cfg: IndexerConfig): Promise<number> {
  const results = await searchIndexer(cfg, { type: 'search', categories: [...CATEGORIES.movies, ...CATEGORIES.tv], limit: 5 });
  return results.length;
}

export interface ProwlarrIndexer {
  id: number;
  name: string;
  protocol: Protocol;
  enable: boolean;
  capabilities?: { categories?: { id: number }[] };
}

/** Lists Prowlarr's indexers. Each is reachable through Prowlarr's Newznab/Torznab proxy at <prowlarr>/<id>/api. */
export async function listProwlarrIndexers(url: string, apiKey: string): Promise<ProwlarrIndexer[]> {
  return fetchJson<ProwlarrIndexer[]>('Prowlarr', `${url.replace(/\/+$/, '')}/api/v1/indexer`, { headers: { 'X-Api-Key': apiKey } });
}
