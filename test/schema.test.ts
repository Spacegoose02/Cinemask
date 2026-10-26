import Database from 'better-sqlite3';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/server/db/database.js';
import { MIGRATIONS } from '../src/server/db/migrations.js';
import * as schema from '../src/server/db/schema.js';
import { roleFromGroups } from '../src/server/auth/oidc.js';
import { SETTINGS } from '../src/server/settings/definitions.js';
import { makeApp } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => (t = await makeApp()));
afterAll(async () => t.close());

describe('schema', () => {
  it('drizzle table definitions match the migrated database', () => {
    const tables = Object.values(schema).filter((v): v is SQLiteTable => typeof v === 'object' && v !== null && 'getSQL' in v);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const cfg = getTableConfig(table);
      const cols = (t.app.ctx.dbHandle.sqlite.prepare(`PRAGMA table_info(${cfg.name})`).all() as { name: string }[]).map((c) => c.name);
      expect(cols.sort(), cfg.name).toEqual(cfg.columns.map((c) => c.name).sort());
    }
  });
});

describe('migration 18 (BingeBandit)', () => {
  it('keeps library items, their episodes and match fixes while allowing the new server', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((m) => m.id < 18)) {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.id, m.name, 0);
    }
    db.exec("INSERT INTO library_items (id, server, external_key, kind, title, view_count, library) VALUES (7, 'plex', '20', 'show', 'Bluey', 2, 'TV')");
    db.exec("INSERT INTO library_episodes (library_item_id, season, episode, title) VALUES (7, 1, 1, 'Pilot')");
    db.exec("INSERT INTO match_overrides VALUES ('plex', '20', 82728, 1)");
    expect(migrate(db)).toBe(MIGRATIONS.length - 17);
    expect(db.prepare('SELECT id, title, view_count, library FROM library_items').all()).toEqual([{ id: 7, title: 'Bluey', view_count: 2, library: 'TV' }]);
    expect(db.prepare('SELECT library_item_id, title FROM library_episodes').all()).toEqual([{ library_item_id: 7, title: 'Pilot' }]);
    expect(db.prepare('SELECT tmdb_id FROM match_overrides').all()).toEqual([{ tmdb_id: 82728 }]);
    db.exec("INSERT INTO library_items (server, external_key, kind, title) VALUES ('bingebandit', '1', 'movie', 'Paddington')");
    db.exec("INSERT INTO match_overrides VALUES ('bingebandit', '1', 116149, 1)");
    // Episodes still follow their show when it goes.
    db.exec('DELETE FROM library_items WHERE id = 7');
    expect(db.prepare('SELECT count(*) AS n FROM library_episodes').get()).toEqual({ n: 0 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});

describe('OIDC group mapping', () => {
  const base = SETTINGS.auth.schema.parse({}).oidc;
  it('leaves roles alone when no groups are configured', () => {
    expect(roleFromGroups(base, ['anything'])).toBeNull();
  });
  it('maps admin and manager groups', () => {
    const s = { ...base, adminGroups: ['media-admins'], managerGroups: ['media-managers'] };
    expect(roleFromGroups(s, ['media-admins'])).toBe('admin');
    expect(roleFromGroups(s, ['media-managers'])).toBe('manager');
    expect(roleFromGroups(s, ['family'])).toBe('user');
  });
  it('denies users outside the allowed groups', () => {
    const s = { ...base, userGroups: ['family'] };
    expect(roleFromGroups(s, ['strangers'])).toBeUndefined();
    expect(roleFromGroups(s, ['family'])).toBeNull();
  });
});
