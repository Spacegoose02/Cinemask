import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import path from 'node:path';
import type { SectionValue } from '../settings/definitions.js';
import { BACKUP_NAME } from './names.js';

type Remote = SectionValue<'backup'>['remote'];

function s3Client(r: Remote): S3Client {
  return new S3Client({
    endpoint: r.s3.endpoint || undefined,
    region: r.s3.region,
    forcePathStyle: r.s3.forcePathStyle,
    credentials: { accessKeyId: r.s3.accessKeyId, secretAccessKey: r.s3.secretAccessKey },
  });
}

/** Copies a finished backup to the configured remote target and applies remote retention. */
export async function uploadBackup(r: Remote, file: string): Promise<void> {
  const name = path.basename(file);
  if (r.type === 'path') {
    if (!r.path || !path.isAbsolute(r.path)) throw new Error('Remote backup path must be an absolute path');
    fs.mkdirSync(r.path, { recursive: true });
    fs.copyFileSync(file, path.join(r.path, name));
    const existing = fs.readdirSync(r.path).filter((f) => BACKUP_NAME.test(f)).sort().reverse();
    for (const old of existing.slice(r.retention)) fs.rmSync(path.join(r.path, old));
    return;
  }
  if (r.type === 's3') {
    if (!r.s3.bucket) throw new Error('S3 bucket is not set');
    const client = s3Client(r);
    await client.send(new PutObjectCommand({ Bucket: r.s3.bucket, Key: `${r.s3.prefix}${name}`, Body: fs.readFileSync(file) }));
    const listed = await client.send(new ListObjectsV2Command({ Bucket: r.s3.bucket, Prefix: r.s3.prefix }));
    const keys = (listed.Contents ?? [])
      .map((o) => o.Key!)
      .filter((k) => BACKUP_NAME.test(k.slice(r.s3.prefix.length)))
      .sort()
      .reverse();
    const stale = keys.slice(r.retention);
    if (stale.length) await client.send(new DeleteObjectsCommand({ Bucket: r.s3.bucket, Delete: { Objects: stale.map((Key) => ({ Key })) } }));
  }
}
