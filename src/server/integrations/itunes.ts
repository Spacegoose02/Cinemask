import { fetchJson } from './http.js';

export interface PodcastCard {
  itunesId: number;
  title: string;
  author: string | null;
  artwork: string | null;
  feedUrl: string | null;
  genre: string | null;
  episodes: number | null;
}

interface ItunesResult {
  collectionId: number;
  collectionName?: string;
  trackName?: string;
  artistName?: string;
  artworkUrl600?: string;
  artworkUrl100?: string;
  feedUrl?: string;
  primaryGenreName?: string;
  trackCount?: number;
}

const toCard = (r: ItunesResult): PodcastCard => ({
  itunesId: r.collectionId,
  title: r.collectionName ?? r.trackName ?? 'Untitled',
  author: r.artistName ?? null,
  artwork: r.artworkUrl600 ?? r.artworkUrl100 ?? null,
  feedUrl: r.feedUrl ?? null,
  genre: r.primaryGenreName ?? null,
  episodes: r.trackCount ?? null,
});

/** Podcast search and charts from Apple's public directory (no key needed). */
export async function searchPodcasts(term: string, country = 'US'): Promise<PodcastCard[]> {
  const qs = new URLSearchParams({ media: 'podcast', entity: 'podcast', term, limit: '30', country });
  const r = await fetchJson<{ results: ItunesResult[] }>('Apple Podcasts', `https://itunes.apple.com/search?${qs.toString()}`);
  return r.results.filter((x) => x.feedUrl).map(toCard);
}

export async function topPodcasts(country = 'us', limit = 30): Promise<PodcastCard[]> {
  const top = await fetchJson<{ feed: { results: { id: string }[] } }>('Apple Podcasts', `https://rss.applemarketingtools.com/api/v2/${encodeURIComponent(country.toLowerCase())}/podcasts/top/${limit}/podcasts.json`);
  const ids = top.feed.results.map((r) => r.id).filter((id) => /^\d+$/.test(id));
  if (!ids.length) return [];
  const r = await fetchJson<{ results: ItunesResult[] }>('Apple Podcasts', `https://itunes.apple.com/lookup?id=${ids.join(',')}&entity=podcast`);
  const byId = new Map(r.results.map((x) => [String(x.collectionId), toCard(x)]));
  return ids.map((id) => byId.get(id)).filter((c): c is PodcastCard => Boolean(c?.feedUrl));
}

/** Looks one podcast up by id, so an "add" uses the feed URL Apple lists rather than one from the browser. */
export async function lookupPodcast(itunesId: number): Promise<PodcastCard | null> {
  const r = await fetchJson<{ results: ItunesResult[] }>('Apple Podcasts', `https://itunes.apple.com/lookup?id=${itunesId}&entity=podcast`);
  const hit = r.results.find((x) => x.collectionId === itunesId && x.feedUrl);
  return hit ? toCard(hit) : null;
}
