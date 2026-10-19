/**
 * Schema migrations, applied in order at startup. Never edit a released migration;
 * add a new one. Keep src/server/db/schema.ts in step (test/schema.test.ts checks this).
 */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'init',
    sql: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT,
        email TEXT,
        password_hash TEXT,
        role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','manager','admin')),
        is_owner INTEGER NOT NULL DEFAULT 0,
        disabled INTEGER NOT NULL DEFAULT 0,
        oidc_subject TEXT UNIQUE,
        plex_id TEXT UNIQUE,
        failed_logins INTEGER NOT NULL DEFAULT 0,
        locked_until INTEGER,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id);
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_states (
        state TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        target TEXT,
        details TEXT,
        ip TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX audit_created_idx ON audit_log(created_at);
    `,
  },
  {
    id: 2,
    name: 'media_library',
    sql: `
      CREATE TABLE media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('movie','show')),
        tmdb_id INTEGER NOT NULL,
        tvdb_id INTEGER,
        imdb_id TEXT,
        title TEXT NOT NULL,
        year INTEGER,
        overview TEXT,
        poster_path TEXT,
        backdrop_path TEXT,
        release_date TEXT,
        digital_release TEXT,
        physical_release TEXT,
        next_air_date TEXT,
        tmdb_status TEXT,
        runtime INTEGER,
        genres TEXT,
        network TEXT,
        rating REAL,
        trailer_key TEXT,
        metadata_updated_at INTEGER,
        UNIQUE (kind, tmdb_id)
      );
      CREATE TABLE library_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server TEXT NOT NULL CHECK (server IN ('plex','jellyfin')),
        external_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('movie','show')),
        title TEXT NOT NULL,
        year INTEGER,
        tmdb_id INTEGER,
        tvdb_id INTEGER,
        imdb_id TEXT,
        resolution TEXT,
        added_at INTEGER,
        media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
        UNIQUE (server, external_key)
      );
      CREATE INDEX library_items_media_idx ON library_items(media_id);
      CREATE INDEX library_items_tmdb_idx ON library_items(kind, tmdb_id);
      CREATE TABLE library_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        library_item_id INTEGER NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        title TEXT,
        resolution TEXT
      );
      CREATE INDEX library_episodes_item_idx ON library_episodes(library_item_id);
      CREATE TABLE http_cache (
        key TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
