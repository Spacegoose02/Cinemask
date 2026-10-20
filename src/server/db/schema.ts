import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

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
  homeLayout: text('home_layout'), // JSON HomeRow[]; null means the default layout
  theme: text('theme'), // null means the browser's last choice (dark by default)
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
    posterOverride: text('poster_override'), // poster chosen in the app; pushed to Plex/Jellyfin
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
    /** Times played by the server's own account, and when last. Null when the server doesn't say. */
    viewCount: integer('view_count'),
    lastViewedAt: integer('last_viewed_at'),
    /** Plex labels or Jellyfin tags. JSON string[]. */
    labels: text('labels'),
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
  viewCount: integer('view_count'),
  lastViewedAt: integer('last_viewed_at'),
});

/** A title fixed by hand to the right TMDB entry. Library sync applies it every time. */
export const matchOverrides = sqliteTable(
  'match_overrides',
  {
    server: text('server', { enum: SERVERS }).notNull(),
    externalKey: text('external_key').notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.server, t.externalKey] })],
);

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
    /** Which root folder (Settings → Media management) new files go to; null is the default one. */
    rootId: text('root_id'),
    /** Largest wanted release in MB, per movie or per episode. Null uses the default from settings; 0 means no limit. */
    maxSizeMb: integer('max_size_mb'),
  },
  (t) => [uniqueIndex('monitored_kind_tmdb').on(t.kind, t.tmdbId)],
);

/** Titles removed from monitoring by hand, so library sync doesn't add them back. */
export const monitorExclusions = sqliteTable(
  'monitor_exclusions',
  {
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.tmdbId] })],
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
    bookId: integer('book_id'), // set for audiobook/ebook grabs instead of monitoredId
    /** Download-client category or label it was sent with. */
    category: text('category'),
    /** Something worth knowing that didn't stop the download, e.g. bigger than the size limit. */
    warning: text('warning'),
    /** For links: where the finished download goes, as a destination key (see arr/roots.ts), with an optional name. JSON. */
    destination: text('destination'),
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

export const LIST_SOURCES = ['mdblist', 'tmdb_list', 'tmdb_discover', 'csv'] as const;
export type ListSource = (typeof LIST_SOURCES)[number];

export const lists = sqliteTable('lists', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  source: text('source', { enum: LIST_SOURCES }).notNull(),
  config: text('config').notNull().default('{}'), // JSON, depends on source
  kind: text('kind', { enum: MEDIA_KINDS }),
  autoAdd: integer('auto_add', { mode: 'boolean' }).notNull().default(false),
  profileId: integer('profile_id').references(() => qualityProfiles.id, { onDelete: 'set null' }),
  searchOnAdd: integer('search_on_add', { mode: 'boolean' }).notNull().default(true),
  syncHours: integer('sync_hours').notNull().default(12),
  lastSyncAt: integer('last_sync_at'),
  lastError: text('last_error'),
  itemCount: integer('item_count').notNull().default(0),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
});

export const listItems = sqliteTable(
  'list_items',
  {
    listId: integer('list_id')
      .notNull()
      .references(() => lists.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    posterPath: text('poster_path'),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.kind, t.tmdbId] })],
);

export const COLLECTION_SOURCES = ['manual', 'tmdb', 'list', 'plex', 'jellyfin'] as const;

export const collections = sqliteTable('collections', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  description: text('description'),
  poster: text('poster'), // TMDB path, https URL, or plex:/jellyfin: image path
  source: text('source', { enum: COLLECTION_SOURCES }).notNull(),
  sourceId: text('source_id'),
  syncPlex: integer('sync_plex', { mode: 'boolean' }).notNull().default(false),
  syncJellyfin: integer('sync_jellyfin', { mode: 'boolean' }).notNull().default(false),
  plexKey: text('plex_key'),
  jellyfinId: text('jellyfin_id'),
  lastPushAt: integer('last_push_at'),
  lastError: text('last_error'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
  /** Label put on every item of this collection in Plex, for smart filters and other tools. */
  plexLabel: text('plex_label'),
  /** Keep the items in step with everything on the server carrying this label (Plex) or tag (Jellyfin). */
  fromLabel: text('from_label'),
});

export const collectionItems = sqliteTable(
  'collection_items',
  {
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: MEDIA_KINDS }).notNull(),
    tmdbId: integer('tmdb_id').notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    posterPath: text('poster_path'),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.collectionId, t.kind, t.tmdbId] })],
);

export const BOOK_FORMATS = ['audiobook', 'ebook'] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];
export const BOOK_STATUSES = ['pending', 'approved', 'declined', 'downloading', 'available', 'failed'] as const;

export const books = sqliteTable(
  'books',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workKey: text('work_key').notNull(), // Open Library work, e.g. /works/OL45804W
    format: text('format', { enum: BOOK_FORMATS }).notNull(),
    title: text('title').notNull(),
    author: text('author'),
    year: integer('year'),
    coverId: integer('cover_id'),
    isbn: text('isbn'),
    status: text('status', { enum: BOOK_STATUSES }).notNull(),
    requestedBy: integer('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedByName: text('requested_by_name'),
    decidedByName: text('decided_by_name'),
    decidedAt: integer('decided_at'),
    reason: text('reason'),
    externalId: text('external_id'), // Shelfmark download id
    path: text('path'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('books_work_key_format_unique').on(t.workKey, t.format), index('books_status_idx').on(t.status)],
);

export const absItems = sqliteTable('abs_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  absId: text('abs_id').notNull().unique(),
  libraryId: text('library_id').notNull(),
  mediaType: text('media_type', { enum: ['book', 'podcast'] }).notNull(),
  title: text('title').notNull(),
  author: text('author'),
  asin: text('asin'),
  isbn: text('isbn'),
  addedAt: integer('added_at'),
});

export const API_KEY_ACCESS = ['read', 'full'] as const;

export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prefix: text('prefix').notNull(), // first characters, shown so people can tell keys apart
    keyHash: text('key_hash').notNull().unique(), // scrypt of the key, salted from the instance key; the key itself is never stored
    access: text('access', { enum: API_KEY_ACCESS }).notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at'),
    expiresAt: integer('expires_at'),
  },
  (t) => [index('api_keys_user_idx').on(t.userId)],
);

export const YOUTUBE_MODES = ['new', 'all', 'playlists'] as const;
export const YOUTUBE_VIDEO_STATUSES = ['wanted', 'skipped', 'downloading', 'done', 'failed'] as const;

export const youtubeChannels = sqliteTable('youtube_channels', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull().unique(), // canonical channel or playlist URL
  channelId: text('channel_id'),
  name: text('name').notNull(),
  description: text('description'),
  mode: text('mode', { enum: YOUTUBE_MODES }).notNull(),
  playlists: text('playlists'), // JSON [{ id, title }] followed in "playlists" mode
  /** Nothing downloads on its own: the channel's videos are listed and someone picks which to get. */
  pick: integer('pick', { mode: 'boolean' }).notNull().default(false),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastCheckedAt: integer('last_checked_at'),
  lastError: text('last_error'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at').notNull(),
});

export const youtubeVideos = sqliteTable(
  'youtube_videos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => youtubeChannels.id, { onDelete: 'cascade' }),
    videoId: text('video_id').notNull(),
    title: text('title').notNull(),
    playlistId: text('playlist_id'),
    publishedAt: text('published_at'), // YYYY-MM-DD, known once the video's details are read
    status: text('status', { enum: YOUTUBE_VIDEO_STATUSES }).notNull(),
    path: text('path'),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('youtube_videos_channel_video_unique').on(t.channelId, t.videoId), index('youtube_videos_status_idx').on(t.status)],
);
