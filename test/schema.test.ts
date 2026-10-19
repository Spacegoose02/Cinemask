import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
