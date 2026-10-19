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
  {
    id: 3,
    name: 'requests_and_downloads',
    sql: `
      CREATE TABLE quality_profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        qualities TEXT NOT NULL,
        cutoff TEXT NOT NULL,
        upgrades_allowed INTEGER NOT NULL DEFAULT 1,
        language TEXT NOT NULL DEFAULT 'any',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE monitored (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('movie','show')),
        tmdb_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        year INTEGER,
        profile_id INTEGER NOT NULL REFERENCES quality_profiles(id),
        monitored INTEGER NOT NULL DEFAULT 1,
        seasons TEXT,
        path TEXT,
        file_path TEXT,
        file_quality TEXT,
        added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        added_at INTEGER NOT NULL,
        last_search_at INTEGER,
        UNIQUE (kind, tmdb_id)
      );
      CREATE TABLE monitored_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitored_id INTEGER NOT NULL REFERENCES monitored(id) ON DELETE CASCADE,
        season INTEGER NOT NULL,
        episode INTEGER NOT NULL,
        title TEXT,
        air_date TEXT,
        monitored INTEGER NOT NULL DEFAULT 1,
        file_path TEXT,
        file_quality TEXT,
        UNIQUE (monitored_id, season, episode)
      );
      CREATE TABLE requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('movie','show')),
        tmdb_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        year INTEGER,
        poster_path TEXT,
        seasons TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','declined','available')),
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        requested_by_name TEXT,
        decided_by_name TEXT,
        decided_at INTEGER,
        reason TEXT,
        monitored_id INTEGER REFERENCES monitored(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX requests_status_idx ON requests(status);
      CREATE TABLE indexers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('newznab','torznab')),
        url TEXT NOT NULL,
        api_key TEXT,
        categories TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 25,
        source TEXT NOT NULL DEFAULT 'manual',
        prowlarr_id INTEGER UNIQUE
      );
      CREATE TABLE download_clients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (protocol IN ('torrent','usenet')),
        url TEXT NOT NULL,
        username TEXT,
        password TEXT,
        category TEXT NOT NULL DEFAULT 'media-manager',
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_id INTEGER REFERENCES download_clients(id) ON DELETE SET NULL,
        download_id TEXT,
        monitored_id INTEGER REFERENCES monitored(id) ON DELETE SET NULL,
        episodes TEXT,
        title TEXT NOT NULL,
        quality TEXT,
        size INTEGER,
        protocol TEXT NOT NULL,
        indexer TEXT,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        output_path TEXT,
        source_url TEXT,
        added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        added_at INTEGER NOT NULL,
        completed_at INTEGER,
        imported_at INTEGER
      );
      CREATE INDEX downloads_status_idx ON downloads(status);
      CREATE TABLE blocklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        monitored_id INTEGER REFERENCES monitored(id) ON DELETE CASCADE,
        release_title TEXT NOT NULL,
        indexer TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    id: 4,
    name: 'lists, collections, home layout and posters',
    sql: `
      CREATE TABLE lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('mdblist','tmdb_list','tmdb_discover','csv')),
        config TEXT NOT NULL DEFAULT '{}',
        kind TEXT CHECK (kind IN ('movie','show')),
        auto_add INTEGER NOT NULL DEFAULT 0,
        profile_id INTEGER REFERENCES quality_profiles(id) ON DELETE SET NULL,
        search_on_add INTEGER NOT NULL DEFAULT 1,
        sync_hours INTEGER NOT NULL DEFAULT 12,
        last_sync_at INTEGER,
        last_error TEXT,
        item_count INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE list_items (
        list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('movie','show')),
        tmdb_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        year INTEGER,
        poster_path TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY (list_id, kind, tmdb_id)
      );
      CREATE TABLE collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        poster TEXT,
        source TEXT NOT NULL CHECK (source IN ('manual','tmdb','list','plex','jellyfin')),
        source_id TEXT,
        sync_plex INTEGER NOT NULL DEFAULT 0,
        sync_jellyfin INTEGER NOT NULL DEFAULT 0,
        plex_key TEXT,
        jellyfin_id TEXT,
        last_push_at INTEGER,
        last_error TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE collection_items (
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('movie','show')),
        tmdb_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        year INTEGER,
        poster_path TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY (collection_id, kind, tmdb_id)
      );
      ALTER TABLE users ADD COLUMN home_layout TEXT;
      ALTER TABLE media ADD COLUMN poster_override TEXT;
    `,
  },
  {
    id: 5,
    name: 'books, audiobooks and Audiobookshelf',
    sql: `
      CREATE TABLE books (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        work_key TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('audiobook','ebook')),
        title TEXT NOT NULL,
        author TEXT,
        year INTEGER,
        cover_id INTEGER,
        isbn TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','declined','downloading','available','failed')),
        requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        requested_by_name TEXT,
        decided_by_name TEXT,
        decided_at INTEGER,
        reason TEXT,
        external_id TEXT,
        path TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (work_key, format)
      );
      CREATE INDEX books_status_idx ON books(status);
      CREATE TABLE abs_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        abs_id TEXT NOT NULL UNIQUE,
        library_id TEXT NOT NULL,
        media_type TEXT NOT NULL CHECK (media_type IN ('book','podcast')),
        title TEXT NOT NULL,
        author TEXT,
        asin TEXT,
        isbn TEXT,
        added_at INTEGER
      );
      ALTER TABLE downloads ADD COLUMN book_id INTEGER REFERENCES books(id) ON DELETE SET NULL;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.id;
