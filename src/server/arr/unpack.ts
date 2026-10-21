import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { insideRoot } from '../lib/paths.js';
import { findArchives, findVideos, UNPACKED, unpackedDir } from './importer.js';
import { listRoots } from './roots.js';

/** The unar binary (in the Docker image); UNAR_PATH points elsewhere, as tests do. */
const unarBinary = () => process.env.UNAR_PATH || 'unar';

function unar(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Never through a shell. Without a terminal, a password-protected archive fails instead of prompting.
    const child = execFile(unarBinary(), ['-q', '-f', '-D', '-o', dest, archive], { timeout: 60 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('unar is not installed, so archives cannot be unpacked'));
      const why = String(stderr).trim().split('\n').pop() || err.message;
      reject(new Error(/password/i.test(why) ? 'it is password-protected' : why.slice(0, 300)));
    });
    child.stdin?.end();
  });
}

/**
 * Unpacks a finished download that holds archives but no videos (a usenet client with unpacking off,
 * or a torrent of RARs). The files go into a folder of their own inside the download, which the
 * importer reads and removes after the import. Returns whether anything was unpacked.
 */
export async function unpackDownload(ctx: AppContext, location: string): Promise<boolean> {
  if (!ctx.settings.get('media').unpackArchives) return false;
  if (findVideos(location).length) return false;
  // Never in a library folder: only downloads are unpacked.
  if (listRoots(ctx).some((r) => insideRoot(r.path, location))) return false;
  const archives = findArchives(location);
  if (!archives.length) return false;
  const dest = unpackedDir(location);
  fs.mkdirSync(dest, { recursive: true });
  for (const archive of archives) {
    try {
      await unar(archive, dest);
    } catch (err) {
      throw new Error(`Couldn't unpack ${path.basename(archive)}: ${(err as Error).message}. Unpack it in the download client, or delete it and search again.`, { cause: err });
    }
  }
  return true;
}

/** Removes what unpackDownload wrote, once the videos are in the library. */
export function removeUnpacked(location: string) {
  const dir = unpackedDir(location);
  if (path.basename(dir).endsWith(UNPACKED)) fs.rmSync(dir, { recursive: true, force: true });
}
