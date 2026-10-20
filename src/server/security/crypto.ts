import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = 'secret.key';

/**
 * Loads the instance secret from <configDir>/secret.key, creating it on first run.
 * It encrypts stored API keys and passwords for integrations, so it is part of every backup.
 */
export function loadOrCreateSecretKey(configDir: string): Buffer {
  const file = path.join(configDir, KEY_FILE);
  if (fs.existsSync(file)) {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (key.length !== 32) throw new Error(`${file} is not a valid 32-byte key`);
    return key;
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600 });
  return key;
}

/**
 * scrypt with a salt derived from the instance key, so the same value always gives the same hash
 * (needed to look a key up) and a copy of the database alone can't check guesses. Callers cache
 * results, since scrypt is deliberately slow.
 */
export function keyedSlowHash(key: Buffer, purpose: string, value: string): string {
  const salt = crypto.createHmac('sha256', key).update(`salt:${purpose}`).digest();
  return crypto.scryptSync(value, salt, 32, { N: 2 ** 12, r: 8, p: 1 }).toString('hex');
}

export function secretKeyPath(configDir: string): string {
  return path.join(configDir, KEY_FILE);
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, all base64url. */
export function encryptString(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptString(key: Buffer, payload: string): string {
  const [version, iv, tag, ct] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unrecognised encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

const BACKUP_MAGIC = Buffer.from('MMBK1');

/** Encrypts a whole buffer with a passphrase (scrypt + AES-256-GCM). Used for backup archives. */
export function encryptWithPassphrase(passphrase: string, data: Buffer): Buffer {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, salt, iv, cipher.getAuthTag(), ct]);
}

export function isPassphraseEncrypted(data: Buffer): boolean {
  return data.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC);
}

export function decryptWithPassphrase(passphrase: string, data: Buffer): Buffer {
  if (!isPassphraseEncrypted(data)) throw new Error('Not an encrypted backup');
  let o = BACKUP_MAGIC.length;
  const salt = data.subarray(o, (o += 16));
  const iv = data.subarray(o, (o += 12));
  const tag = data.subarray(o, (o += 16));
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(o)), decipher.final()]);
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
