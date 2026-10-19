import { sqliteTable, text, integer, index, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const ROLES = ['user', 'manager', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  displayName: text('display_name'),
  email: text('email'),
  passwordHash: text('password_hash'),
  role: text('role', { enum: ROLES }).notNull().default('user'),
  isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  oidcSubject: text('oidc_subject').unique(),
  plexId: text('plex_id').unique(),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: integer('locked_until'),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256 of the cookie token; the raw token is never stored
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON; secret leaves are encrypted strings
  updatedAt: integer('updated_at').notNull(),
});

export const authStates = sqliteTable('auth_states', {
  state: text('state').primaryKey(),
  kind: text('kind').notNull(), // 'oidc' | 'plex'
  data: text('data').notNull(), // JSON
  expiresAt: integer('expires_at').notNull(),
});

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id'),
    username: text('username'),
    action: text('action').notNull(),
    target: text('target'),
    details: text('details'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('audit_created_idx').on(t.createdAt)],
);

export const MEDIA_KINDS = ['movie', 'show'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export const SERVERS = ['plex', 'jellyfin'] as const;
export type ServerType = (typeof SERVERS)[number];

/** Metadata for a movie or show, keyed by TMDB id. Filled from TMDB and cached. */
export const media = sqliteTable(
  'media',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    title: text('title').notNull(),
    year: integer('year'),
    overview: text('overview'),
    posterPath: text('poster_path'),
    backdropPath: text('backdrop_path'),
    releaseDate: text('release_date'),
    digitalRelease: text('digital_release'),
    physicalRelease: text('physical_release'),
    nextAirDate: text('next_air_date'),
    tmdbStatus: text('tmdb_status'),
    runtime: integer('runtime'),
    genres: text('genres'),
    network: text('network'),
    rating: real('rating'),
    trailerKey: text('trailer_key'),
    metadataUpdatedAt: integer('metadata_updated_at'),
  },
  (t) => [uniqueIndex('media_kind_tmdb').on(t.kind, t.tmdbId)],
);

/** What is actually on a media server, refreshed by library sync. */
export const libraryItems = sqliteTable(
  'library_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    server: text('server', { enum: SERVERS }).notNull(),
    externalKey: text('external_key').notNull(),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    resolution: text('resolution'),
    addedAt: integer('added_at'),
    mediaId: integer('media_id').references(() => media.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('library_server_key').on(t.server, t.externalKey), index('library_items_media_idx').on(t.mediaId)],
);

export const libraryEpisodes = sqliteTable('library_episodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  libraryItemId: integer('library_item_id')
    .notNull()
    .references(() => libraryItems.id, { onDelete: 'cascade' }),
  season: integer('season').notNull(),
  episode: integer('episode').notNull(),
  title: text('title'),
  resolution: text('resolution'),
});

export const httpCache = sqliteTable('http_cache', {
  key: text('key').primaryKey(),
  body: text('body').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const qualityProfiles = sqliteTable('quality_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  qualities: text('qualities').notNull(), // JSON QualityId[]
  cutoff: text('cutoff').notNull(),
  upgradesAllowed: integer('upgrades_allowed', { mode: 'boolean' }).notNull().default(true),
  /** 'any', or an ISO 639-1 code such as 'en'. Releases in other languages are skipped. */
  language: text('language').notNull().default('any'),
  createdAt: integer('created_at').notNull(),
});

/** A movie or show the app keeps an eye on: searches for it, downloads and upgrades it. */
export const monitored = sqliteTable(
  'monitored',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    profileId: integer('profile_id')
      .notNull()
      .references(() => qualityProfiles.id),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    seasons: text('seasons'), // JSON number[]; null means every season
    path: text('path'),
    filePath: text('file_path'),
    fileQuality: text('file_quality'),
    addedBy: integer('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: integer('added_at').notNull(),
    lastSearchAt: integer('last_search_at'),
  },
  (t) => [uniqueIndex('monitored_kind_tmdb').on(t.kind, t.tmdbId)],
);

export const monitoredEpisodes = sqliteTable(
  'monitored_episodes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    monitoredId: integer('monitored_id')
      .notNull()
      .references(() => monitored.id, { onDelete: 'cascade' }),
    season: integer('season').notNull(),
    episode: integer('episode').notNull(),
    title: text('title'),
    airDate: text('air_date'),
    monitored: integer('monitored', { mode: 'boolean' }).notNull().default(true),
    filePath: text('file_path'),
    fileQuality: text('file_quality'),
  },
  (t) => [uniqueIndex('monitored_episode_key').on(t.monitoredId, t.season, t.episode)],
);

export const REQUEST_STATUSES = ['pending', 'approved', 'declined', 'available'] as const;

export const requests = sqliteTable(
  'requests',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    posterPath: text('poster_path'),
    seasons: text('seasons'),
    status: text('status', { enum: REQUEST_STATUSES }).notNull(),
    requestedBy: integer('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedByName: text('requested_by_name'),
    decidedByName: text('decided_by_name'),
    decidedAt: integer('decided_at'),
    reason: text('reason'),
    monitoredId: integer('monitored_id').references(() => monitored.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('requests_status_idx').on(t.status)],
);

export const indexers = sqliteTable('indexers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: ['newznab', 'torznab'] }).notNull(),
  url: text('url').notNull(),
  apiKey: text('api_key'), // encrypted
  categories: text('categories').notNull().default('[]'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(25),
  source: text('source', { enum: ['manual', 'prowlarr'] }).notNull().default('manual'),
  prowlarrId: integer('prowlarr_id').unique(),
});

export const DOWNLOAD_CLIENT_TYPES = ['qbittorrent', 'transmission', 'deluge', 'rtorrent', 'flood', 'utorrent', 'sabnzbd', 'nzbget'] as const;
export type DownloadClientType = (typeof DOWNLOAD_CLIENT_TYPES)[number];

export const downloadClients = sqliteTable('download_clients', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: DOWNLOAD_CLIENT_TYPES }).notNull(),
  protocol: text('protocol', { enum: ['torrent', 'usenet'] }).notNull(),
  url: text('url').notNull(),
  username: text('username'),
  password: text('password'), // encrypted
  category: text('category').notNull().default('media-manager'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  priority: integer('priority').notNull().default(1),
});

export const DOWNLOAD_STATUSES = ['queued', 'downloading', 'paused', 'completed', 'importing', 'imported', 'failed', 'removed'] as const;
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number];

export const downloads = sqliteTable(
  'downloads',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    clientId: integer('client_id').references(() => downloadClients.id, { onDelete: 'set null' }),
    downloadId: text('download_id'),
    monitoredId: integer('monitored_id').references(() => monitored.id, { onDelete: 'set null' }),
    episodes: text('episodes'), // JSON {season, episodes[]} for TV grabs
    title: text('title').notNull(),
    quality: text('quality'),
    size: integer('size'),
    protocol: text('protocol', { enum: ['torrent', 'usenet', 'direct'] }).notNull(),
    indexer: text('indexer'),
    status: text('status', { enum: DOWNLOAD_STATUSES }).notNull(),
    progress: real('progress').notNull().default(0),
    error: text('error'),
    outputPath: text('output_path'),
    sourceUrl: text('source_url'),
    addedBy: integer('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: integer('added_at').notNull(),
    completedAt: integer('completed_at'),
    importedAt: integer('imported_at'),
  },
  (t) => [index('downloads_status_idx').on(t.status)],
);

export const blocklist = sqliteTable('blocklist', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  monitoredId: integer('monitored_id').references(() => monitored.id, { onDelete: 'cascade' }),
  releaseTitle: text('release_title').notNull(),
  indexer: text('indexer'),
  reason: text('reason'),
  createdAt: integer('created_at').notNull(),
});
