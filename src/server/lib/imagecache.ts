import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/** Widths the browser may ask for: the poster grid uses 342, mosaic tiles 185. */
export const THUMB_WIDTHS = [185, 342, 500] as const;
export type ThumbWidth = (typeof THUMB_WIDTHS)[number];

export interface CachedImage {
  type: string;
  body: Buffer;
}

/**
 * How long a copy stays fresh. Server covers change rarely, and a changed Plex cover gets a new path anyway.
 * An older copy is still served when its server fails or is switched off, so covers outlive Plex and Jellyfin.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The cache trims itself back under this many bytes when it grows past it. */
const MAX_BYTES = 500 * 1024 * 1024;

/**
 * Disk cache for images proxied from Plex, Jellyfin, BingeBandit and Audiobookshelf. Without it every
 * cover on the Collections page was fetched from the media server at full size on every visit.
 * Entries are named by a hash of the source, so nothing in the key reaches the file system.
 */
export class ImageCache {
  private inflight = new Map<string, Promise<CachedImage | null>>();
  private writes = 0;

  constructor(private dir: string) {}

  /** The cached image for src at width w, fetching (and shrinking) it on a miss. Concurrent misses share one fetch. */
  async get(src: string, w: ThumbWidth | null, fetchImage: () => Promise<CachedImage | null>): Promise<CachedImage | null> {
    const key = createHash('sha256').update(`${src}\n${w ?? 'full'}`).digest('hex');
    const hit = this.read(key);
    if (hit?.fresh) return hit.img;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = (async () => {
        let img: CachedImage | null;
        try {
          img = await fetchImage();
        } catch (err) {
          if (hit) return this.keep(key, hit.img);
          throw err;
        }
        // Gone from its server (or the server is off): the last copy we had beats a blank cover.
        if (!img || !img.type.startsWith('image/')) return hit ? this.keep(key, hit.img) : img;
        const out = w ? await shrink(img, w) : img;
        this.write(key, out);
        return out;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private file(key: string) {
    return path.join(this.dir, key.slice(0, 2), key);
  }

  /** Serves a stale copy and marks it fresh, so a dead server isn't asked again on every view. */
  private keep(key: string, img: CachedImage): CachedImage {
    try {
      const now = new Date();
      fs.utimesSync(this.file(key), now, now);
    } catch {
      // Only costs a retry next time.
    }
    return img;
  }

  private read(key: string): { img: CachedImage; fresh: boolean } | null {
    const file = this.file(key);
    let fd: number | null = null;
    try {
      // One open file for both the age check and the read, so a concurrent rewrite can't slip between them.
      fd = fs.openSync(file, 'r');
      const fresh = Date.now() - fs.fstatSync(fd).mtimeMs <= MAX_AGE_MS;
      const raw = fs.readFileSync(fd);
      // A short header line holds the content type, then the image bytes.
      const nl = raw.indexOf(10);
      if (nl < 1 || nl > 100) return null;
      return { img: { type: raw.subarray(0, nl).toString('utf8'), body: raw.subarray(nl + 1) }, fresh };
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  private write(key: string, img: CachedImage) {
    try {
      const file = this.file(key);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, Buffer.concat([Buffer.from(`${img.type}\n`), img.body]));
      fs.renameSync(tmp, file);
      if (++this.writes % 200 === 0) this.prune();
    } catch {
      // A full or read-only disk only costs the cache, never the image.
    }
  }

  /**
   * Drops the least recently refreshed entries until the cache fits its budget. Age alone never
   * evicts: an old copy may be the only one left of a cover from a server that's been switched off.
   */
  prune() {
    const entries: { file: string; mtime: number; size: number }[] = [];
    try {
      for (const sub of fs.readdirSync(this.dir)) {
        const d = path.join(this.dir, sub);
        for (const name of fs.readdirSync(d)) {
          const file = path.join(d, name);
          const s = fs.statSync(file);
          entries.push({ file, mtime: s.mtimeMs, size: s.size });
        }
      }
    } catch {
      return;
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    let total = 0;
    for (const e of entries) {
      total += e.size;
      if (total > MAX_BYTES) fs.rmSync(e.file, { force: true });
    }
  }
}

/** Resizes to the requested width as WebP; an image sharp can't read is passed through untouched. */
async function shrink(img: CachedImage, w: ThumbWidth): Promise<CachedImage> {
  try {
    const body = await sharp(img.body).resize({ width: w, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return { type: 'image/webp', body };
  } catch {
    return img;
  }
}
