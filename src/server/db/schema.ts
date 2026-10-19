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
