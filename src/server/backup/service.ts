import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import type { AppContext } from '../context.js';
import { databasePath, migrate, openDatabase, schemaVersion } from '../db/database.js';
import { LATEST_SCHEMA_VERSION } from '../db/migrations.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { decryptWithPassphrase, encryptWithPassphrase, isPassphraseEncrypted, randomToken, secretKeyPath } from '../security/crypto.js';
import { BACKUP_NAME, backupFileName, type BackupReason } from './names.js';
import { uploadBackup } from './remote.js';

const ARCHIVE_FILES = ['manifest.json', 'app.db', 'secret.key'];
const FORMAT = 1;

interface Manifest {
  format: number;
  version: string;
  schemaVersion: number;
  createdAt: string;
  reason: BackupReason;
}

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: number;
  encrypted: boolean;
  reason: string;
}

export interface BackupStatus {
  lastBackupAt: number | null;
  lastError: string | null;
  lastRemoteAt: number | null;
  lastRemoteError: string | null;
}

export function backupsDir(configDir: string): string {
  return path.join(configDir, 'backups');
}

function tempDir(configDir: string): string {
  const dir = path.join(configDir, 'tmp', randomToken(8));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Snapshot of DB + instance key without needing the full app (used before migrations at boot). */
export async function writeBackupArchive(
  configDir: string,
  sqlite: Database.Database,
  opts: { reason: BackupReason; version: string; passphrase?: string },
): Promise<string> {
  const dir = backupsDir(configDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = backupFileName(opts.reason, Boolean(opts.passphrase));
  const dest = path.join(dir, name);
  if (fs.existsSync(dest)) throw conflict('A backup was created a moment ago, try again shortly');

  const work = tempDir(configDir);
  try {
    // VACUUM INTO gives a consistent copy even while the app keeps writing (WAL mode).
    sqlite.prepare('VACUUM INTO ?').run(path.join(work, 'app.db'));
    fs.copyFileSync(secretKeyPath(configDir), path.join(work, 'secret.key'));
    const manifest: Manifest = {
      format: FORMAT,
      version: opts.version,
      schemaVersion: schemaVersion(sqlite),
      createdAt: new Date().toISOString(),
      reason: opts.reason,
    };
    fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const archive = path.join(work, 'archive.tar.gz');
    await tar.create({ gzip: true, file: archive, cwd: work, portable: true }, ARCHIVE_FILES);
    let data: Buffer = fs.readFileSync(archive);
    if (opts.passphrase) data = encryptWithPassphrase(opts.passphrase, data);
    fs.writeFileSync(dest, data, { mode: 0o600 });
    return dest;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export class BackupService {
  status: BackupStatus = { lastBackupAt: null, lastError: null, lastRemoteAt: null, lastRemoteError: null };
  private running = false;

  constructor(private readonly ctx: AppContext) {}

  get dir() {
    return backupsDir(this.ctx.config.configDir);
  }

  list(): BackupInfo[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((f) => BACKUP_NAME.test(f))
      .sort()
      .reverse()
      .map((name) => {
        const st = fs.statSync(path.join(this.dir, name));
        return { name, size: st.size, createdAt: st.mtimeMs, encrypted: name.endsWith('.enc'), reason: name.split('-').slice(3).join('-').split('.')[0]! };
      });
  }

  /** Resolves a backup name to its path, refusing anything that isn't a backup file in the backups folder. */
  pathFor(name: string): string {
    if (!BACKUP_NAME.test(name)) throw notFound('Backup not found');
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) throw notFound('Backup not found');
    return file;
  }

  async create(reason: BackupReason, opts: { upload?: boolean } = {}): Promise<BackupInfo> {
    if (this.running) throw conflict('A backup or restore is already running');
    this.running = true;
    try {
      const s = this.ctx.settings.get('backup');
      const file = await writeBackupArchive(this.ctx.config.configDir, this.ctx.dbHandle.sqlite, {
        reason,
        version: this.ctx.config.version,
        passphrase: s.passphrase || undefined,
      });
      this.status.lastBackupAt = Date.now();
      this.status.lastError = null;
      this.prune(s.retention);
      if (opts.upload !== false && s.remote.type !== 'none') {
        try {
          await uploadBackup(s.remote, file);
          this.status.lastRemoteAt = Date.now();
          this.status.lastRemoteError = null;
        } catch (err) {
          this.status.lastRemoteError = (err as Error).message;
        }
      }
      return this.list().find((b) => b.name === path.basename(file))!;
    } catch (err) {
      this.status.lastError = (err as Error).message;
      throw err;
    } finally {
      this.running = false;
    }
  }

  private prune(retention: number) {
    // Retention applies to routine backups; safety snapshots (pre-upgrade/pre-restore) keep their own 5.
    const all = this.list();
    const routine = all.filter((b) => b.reason === 'manual' || b.reason === 'scheduled');
    const safety = all.filter((b) => b.reason.startsWith('pre-'));
    for (const b of [...routine.slice(retention), ...safety.slice(5)]) fs.rmSync(path.join(this.dir, b.name));
  }

  delete(name: string): void {
    fs.rmSync(this.pathFor(name));
  }

  /**
   * Replaces the live database and instance key with the contents of a backup archive.
   * Takes a pre-restore snapshot first, and migrates the restored database up to the current schema.
   */
  async restore(data: Buffer, passphrase?: string): Promise<void> {
    if (this.running) throw conflict('A backup or restore is already running');
    const configDir = this.ctx.config.configDir;
    const work = tempDir(configDir);
    try {
      if (isPassphraseEncrypted(data)) {
        const pass = passphrase || this.ctx.settings.get('backup').passphrase;
        if (!pass) throw badRequest('This backup is encrypted. Enter its passphrase.');
        try {
          data = decryptWithPassphrase(pass, data);
        } catch {
          throw badRequest('Wrong passphrase, or the backup file is damaged');
        }
      }
      const archive = path.join(work, 'archive.tar.gz');
      fs.writeFileSync(archive, data);
      try {
        await tar.extract({
          file: archive,
          cwd: work,
          strict: true,
          // Only accept the three known plain files: no paths, links or anything else.
          filter: (p, entry) => ARCHIVE_FILES.includes(p) && (!('type' in entry) || entry.type === 'File'),
        });
      } catch {
        throw badRequest('This is not a valid backup file');
      }
      for (const f of ARCHIVE_FILES) if (!fs.existsSync(path.join(work, f))) throw badRequest(`Backup is missing ${f}`);

      const manifest = JSON.parse(fs.readFileSync(path.join(work, 'manifest.json'), 'utf8')) as Manifest;
      if (manifest.format !== FORMAT) throw badRequest('Unsupported backup format');
      if (manifest.schemaVersion > LATEST_SCHEMA_VERSION) throw badRequest('This backup is from a newer version of the app. Upgrade first.');

      const check = new Database(path.join(work, 'app.db'), { readonly: true });
      try {
        const result = check.pragma('integrity_check', { simple: true });
        if (result !== 'ok') throw badRequest('The database inside this backup is damaged');
      } finally {
        check.close();
      }
      const key = Buffer.from(fs.readFileSync(path.join(work, 'secret.key'), 'utf8').trim(), 'base64');
      if (key.length !== 32) throw badRequest('Backup has an invalid instance key');

      await this.create('pre-restore', { upload: false });
      this.running = true;

      const dbFile = databasePath(configDir);
      const keyFile = secretKeyPath(configDir);
      const previousKey = this.ctx.secretKey;
      const parked = `${dbFile}.before-restore`;
      // Closing the last connection checkpoints the WAL into the main file.
      this.ctx.dbHandle.sqlite.close();
      fs.renameSync(dbFile, parked);
      for (const suffix of ['-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
      try {
        fs.copyFileSync(path.join(work, 'app.db'), dbFile);
        fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 });
        const handle = openDatabase(dbFile);
        migrate(handle.sqlite);
        this.ctx.secretKey = key;
        this.ctx.dbHandle = handle;
        fs.rmSync(parked);
      } catch (err) {
        // Put the previous database and key back so the app keeps working.
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
        fs.renameSync(parked, dbFile);
        fs.writeFileSync(keyFile, previousKey.toString('base64'), { mode: 0o600 });
        this.ctx.dbHandle = openDatabase(dbFile);
        throw err;
      }
    } finally {
      this.running = false;
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
}
