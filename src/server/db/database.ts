import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from './schema.js';
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations.js';

export type Orm = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  sqlite: Database.Database;
  orm: Orm;
  file: string;
}

export const DB_FILENAME = 'app.db';

export function databasePath(configDir: string): string {
  return path.join(configDir, DB_FILENAME);
}

export function openDatabase(file: string): DatabaseHandle {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  return { sqlite, orm: drizzle(sqlite, { schema }), file };
}

export function schemaVersion(sqlite: Database.Database): number {
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const row = sqlite.prepare('SELECT MAX(id) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

export function pendingMigrations(sqlite: Database.Database) {
  const current = schemaVersion(sqlite);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(`Database schema v${current} is newer than this app (v${LATEST_SCHEMA_VERSION}). Upgrade the app or restore an older backup.`);
  }
  return MIGRATIONS.filter((m) => m.id > current);
}

/** Applies pending migrations, each in its own transaction. */
export function migrate(sqlite: Database.Database): number {
  const pending = pendingMigrations(sqlite);
  for (const m of pending) {
    sqlite.transaction(() => {
      sqlite.exec(m.sql);
      sqlite.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, Date.now());
    })();
  }
  return pending.length;
}
