import type { FastifyInstance } from 'fastify';

/** One-line descriptions for the endpoints people script against most. Others get a generic line. */
const SUMMARIES: Record<string, string> = {
  'GET /api/auth/me': 'The signed-in user (or the API key owner).',
  'GET /api/stats': 'Counts for dashboards and Home Assistant sensors: library size, requests, downloads, books, health.',
  'GET /api/search': 'Search TMDB and the library. Query: q.',
  'GET /api/library': 'Movies and shows on BingeBandit, Plex or Jellyfin.',
  'GET /api/discover': 'Browse TMDB with filters (kind, genres, providers, years, rating, language, sort).',
  'GET /api/requests': 'Movie and show requests. Users see their own; managers see everyone\'s. Query: status.',
  'POST /api/requests': 'Request a movie or show. Body: {"kind":"movie"|"show","tmdbId":123,"seasons":[1,2]?}.',
  'POST /api/requests/{id}/approve': 'Approve a request (manager). Body: {"profileId"?}.',
  'POST /api/requests/{id}/decline': 'Decline a request (manager). Body: {"reason"?}.',
  'GET /api/downloads': 'Active downloads, or history with ?history=true (manager).',
  'GET /api/calendar': 'Upcoming releases for monitored titles. Query: start, end (YYYY-MM-DD, at most 100 days).',
  'GET /api/monitored': 'Monitored movies and shows (manager).',
  'GET /api/books': 'Book and audiobook requests. Query: status.',
  'POST /api/books': 'Request a book. Body: {"workKey":"/works/OL…W","format":"audiobook"|"ebook"}.',
  'GET /api/books/search': 'Search Open Library. Query: q.',
  'GET /api/books/library': 'What is in Audiobookshelf. Query: type=book|podcast.',
  'GET /api/podcasts/top': 'Top podcasts from Apple\'s charts.',
  'GET /api/collections': 'Collections.',
  'GET /api/lists': 'Lists.',
  'GET /api/home/layout': 'Your home page rows.',
};

const toOpenApiPath = (url: string) => url.replace(/:(\w+)/g, '{$1}');

/**
 * An OpenAPI 3.1 description built from the registered routes, so it can't drift from the code.
 * Request bodies are validated in each handler; the summaries above describe the common ones.
 */
export function buildOpenApi(app: FastifyInstance, version: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of app.apiRoutes) {
    const p = toOpenApiPath(r.url);
    const method = r.method.toLowerCase();
    const params = [...p.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const key = `${r.method} ${p}`;
    paths[p] ??= {};
    paths[p][method] = {
      tags: [p.split('/')[2] ?? 'api'],
      summary: SUMMARIES[key] ?? `${r.method} ${p}`,
      description: `Requires: ${r.access === 'public' ? 'nothing' : `${r.access} role`}. ${r.apiKey ? 'Works with an API key.' : 'Not available to API keys; use the web app.'}`,
      'x-access': r.access,
      'x-api-key': r.apiKey,
      ...(params.length ? { parameters: params } : {}),
      ...(r.access === 'public' ? { security: [] } : {}),
      responses: { 200: { description: 'OK (JSON)' }, 400: { description: 'Invalid input' }, 401: { description: 'Missing or invalid credentials' }, 403: { description: 'Not allowed for this user or key' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Cinemask API',
      version,
      description:
        'Send an API key from Account → API keys in the X-Api-Key header (or Authorization: Bearer). A key acts as its owner with their current role; read-only keys can only use GET. Keys never reach account, settings or user management endpoints.',
    },
    components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
    security: [{ apiKey: [] }],
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  };
}
