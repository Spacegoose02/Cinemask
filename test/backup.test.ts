import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, makeApp, OWNER, setupOwner } from './helpers.js';

let t: Awaited<ReturnType<typeof makeApp>>;
let owner: Client;
beforeEach(async () => {
  t = await makeApp();
  owner = await setupOwner(t.app);
});
afterEach(async () => t.close());

describe('backups', () => {
  it('creates a backup and restores it', async () => {
    const created = await owner.req('POST', '/api/backups');
    expect(created.statusCode).toBe(200);
    const name = created.json().backup.name as string;
    expect(fs.existsSync(path.join(t.dir, 'backups', name))).toBe(true);

    await createUser(owner, 'added-later', 'user');
    const restored = await owner.req('POST', `/api/backups/${name}/restore`, {});
    expect(restored.statusCode).toBe(200);

    // Everyone is signed out; the user added after the backup is gone.
    const fresh = new Client(t.app);
    await fresh.login(OWNER.username, OWNER.password);
    const users = (await fresh.req('GET', '/api/users')).json() as { username: string }[];
    expect(users.map((u) => u.username)).toEqual(['owner']);
    // A pre-restore snapshot was taken.
    expect(fs.readdirSync(path.join(t.dir, 'backups')).some((f) => f.includes('pre-restore'))).toBe(true);
  });

  it('encrypts archives when a passphrase is set and needs it to restore an upload', async () => {
    await owner.req('PUT', '/api/settings/backup', { passphrase: 'family-backup-pass' });
    const name = (await owner.req('POST', '/api/backups')).json().backup.name as string;
    expect(name.endsWith('.enc')).toBe(true);
    const data = fs.readFileSync(path.join(t.dir, 'backups', name));
    expect(data.subarray(0, 5).toString()).toBe('MMBK1');

    const upload = (pass?: string) =>
      owner.req('POST', '/api/backups/upload-restore', data, {
        headers: { 'content-type': 'application/octet-stream', ...(pass ? { 'x-backup-passphrase': pass } : {}) },
      });
    await owner.req('PUT', '/api/settings/backup', { passphrase: null });
    expect((await upload('wrong-pass')).statusCode).toBe(400);
    expect((await upload('family-backup-pass')).statusCode).toBe(200);
  });

  it('rejects files that are not backups', async () => {
    const res = await owner.req('POST', '/api/backups/upload-restore', Buffer.from('not a backup'), {
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(res.statusCode).toBe(400);
    // The live database still works after a failed restore.
    expect((await owner.req('GET', '/api/users')).statusCode).toBe(200);
  });

  it('refuses to serve anything outside the backups folder', async () => {
    for (const name of ['..%2Fapp.db', '..%2Fsecret.key', 'app.db']) {
      expect((await owner.req('GET', `/api/backups/${name}/download`)).statusCode).toBe(404);
    }
  });

  it('applies retention to routine backups', async () => {
    await owner.req('PUT', '/api/settings/backup', { retention: 2 });
    for (let i = 0; i < 3; i++) {
      await t.backups.create('manual');
      await new Promise((r) => setTimeout(r, 1100));
    }
    expect(t.backups.list().filter((b) => b.reason === 'manual')).toHaveLength(2);
  });
});
