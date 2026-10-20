import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { downloads } from '../db/schema.js';
import { insideRoot } from '../lib/paths.js';
import { magnetHash } from './clients.js';
import { placeFile } from './importer.js';
import { sanitizeSegment } from './naming.js';
import { linkDestinations } from './roots.js';
import { pickClient } from './search.js';

/** True for loopback, private, link-local, CGNAT and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

/** Rejects URLs that point at the server itself or the home network, unless the admin allowed it. */
export async function assertSafeUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https links can be downloaded');
  if (url.username || url.password) throw new Error('Links with embedded passwords are not allowed');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error('Links to local or private network addresses are blocked (Settings → Downloading)');
  return url;
}

export interface LinkOptions {
  /** File or folder name to use when it's delivered. The extension is kept. */
  name?: string | null;
  /** Where it goes once finished: a key from linkDestinations() ("downloads", "movie:kids", "books"…). */
  destination?: string | null;
}

/**
 * Starts a download from a link: an http(s) file is fetched here; a magnet link or a .torrent URL
 * is handed to the torrent client. When it finishes it's delivered to the chosen folder.
 */
export async function startLinkDownload(ctx: AppContext, rawUrl: string, opts: LinkOptions, userId: number | null): Promise<number> {
  const destination = opts.destination ?? 'downloads';
  if (!linkDestinations(ctx).some((d) => d.key === destination)) throw new Error('Unknown destination folder');
  const name = opts.name ? sanitizeSegment(opts.name) : '';
  if (opts.name && !name) throw new Error('That name has no usable characters');
  const dest = JSON.stringify({ key: destination, name: name || null });

  if (/^magnet:/i.test(rawUrl) || /\.torrent$/i.test(safePathname(rawUrl))) {
    let link = rawUrl;
    let title = name;
    if (/^magnet:/i.test(rawUrl)) {
      if (!magnetHash(rawUrl)) throw new Error('That magnet link has no torrent hash');
      title ||= sanitizeSegment(new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1)).get('dn') ?? '') || 'Magnet download';
    } else {
      link = (await assertSafeUrl(rawUrl, ctx.settings.get('downloading').allowPrivateDirectUrls)).toString();
      title ||= sanitizeSegment(decodeURIComponent(path.basename(new URL(link).pathname)).replace(/\.torrent$/i, '')) || 'Torrent download';
    }
    const picked = pickClient(ctx, 'torrent');
    if (!picked) throw new Error('No torrent download client is set up');
    const row = ctx.db
      .insert(downloads)
      .values({ clientId: picked.row.id, title, protocol: 'torrent', status: 'queued', sourceUrl: link, category: picked.row.category, destination: dest, addedBy: userId, addedAt: Date.now() })
      .returning()
      .get();
    try {
      const id = await picked.client.add(link, { category: picked.row.category, tag: `mm-${row.id}`, title });
      ctx.db.update(downloads).set({ downloadId: id }).where(eq(downloads.id, row.id)).run();
    } catch (err) {
      ctx.db.update(downloads).set({ status: 'failed', error: (err as Error).message }).where(eq(downloads.id, row.id)).run();
      throw err;
    }
    return row.id;
  }

  const allowPrivate = ctx.settings.get('downloading').allowPrivateDirectUrls;
  let url = await assertSafeUrl(rawUrl, allowPrivate);
  const fileName = sanitizeSegment(decodeURIComponent(path.basename(url.pathname)) || 'download') || 'download';
  const row = ctx.db
    .insert(downloads)
    .values({ title: name || fileName, protocol: 'direct', status: 'downloading', sourceUrl: url.toString(), destination: dest, addedBy: userId, addedAt: Date.now() })
    .returning()
    .get();

  void (async () => {
    try {
      let res: Response | null = null;
      // Follow redirects by hand so every hop is checked against the private-address rule.
      for (let hop = 0; hop < 5; hop++) {
        res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60 * 60 * 1000) });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          url = await assertSafeUrl(new URL(res.headers.get('location')!, url).toString(), allowPrivate);
          continue;
        }
        break;
      }
      if (!res || !res.ok || !res.body) throw new Error(`Server responded with HTTP ${res?.status ?? 'no response'}`);
      const total = Number(res.headers.get('content-length') ?? 0);
      const dir = path.join(ctx.settings.get('media').downloadsPath, 'direct');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${row.id}-${fileName}`);
      let received = 0;
      let lastUpdate = 0;
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (total && Date.now() - lastUpdate > 1000) {
          lastUpdate = Date.now();
          ctx.db.update(downloads).set({ progress: received / total }).where(eq(downloads.id, row.id)).run();
        }
      });
      await pipeline(body, fs.createWriteStream(file, { mode: 0o644 }));
      ctx.db.update(downloads).set({ status: 'completed', progress: 1, size: received, outputPath: file, completedAt: Date.now() }).where(eq(downloads.id, row.id)).run();
      // Nothing is seeding a plain download, so it can be moved rather than linked.
      deliverLink(ctx, row.id, file, 'move');
    } catch (err) {
      ctx.db.update(downloads).set({ status: 'failed', error: (err as Error).message }).where(eq(downloads.id, row.id)).run();
    }
  })();
  return row.id;
}

function safePathname(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    return '';
  }
}

/**
 * Puts a finished link download where it was asked to go, under the chosen name. Torrents use the
 * import mode (hardlink by default, so they keep seeding). Nothing can land outside that folder.
 */
export function deliverLink(ctx: AppContext, downloadId: number, source: string, mode: 'hardlink' | 'copy' | 'move') {
  const dl = ctx.db.select().from(downloads).where(eq(downloads.id, downloadId)).get();
  if (!dl) return;
  const dest = dl.destination ? (JSON.parse(dl.destination) as { key: string; name: string | null }) : { key: 'downloads', name: null };
  if (dest.key === 'downloads') {
    ctx.db.update(downloads).set({ status: 'completed', outputPath: source }).where(eq(downloads.id, dl.id)).run();
    return;
  }
  try {
    const root = linkDestinations(ctx).find((d) => d.key === dest.key)?.path;
    if (!root) throw new Error('The destination folder was removed from settings');
    if (!fs.existsSync(source)) throw new Error(`${source} is missing`);
    const isFile = fs.statSync(source).isFile();
    // Direct downloads were saved as "<id>-<name>"; drop the id again.
    const original = dl.protocol === 'direct' ? path.basename(source).replace(/^\d+-/, '') : path.basename(source);
    const ext = isFile ? path.extname(original) : '';
    const base = dest.name ? (ext && dest.name.toLowerCase().endsWith(ext.toLowerCase()) ? dest.name : `${dest.name}${ext}`) : original;
    const target = path.join(root, base);
    if (!insideRoot(root, target)) throw new Error('Refusing to write outside the destination folder');
    if (fs.existsSync(target)) throw new Error(`${base} already exists in ${root}`);
    if (isFile) placeFile(source, target, mode);
    else placeTree(root, source, target, mode);
    ctx.db.update(downloads).set({ status: 'imported', importedAt: Date.now(), outputPath: target, error: null }).where(eq(downloads.id, dl.id)).run();
  } catch (err) {
    ctx.db.update(downloads).set({ status: 'failed', error: (err as Error).message }).where(eq(downloads.id, dl.id)).run();
  }
}

/** Places every file in a folder under target, keeping the layout. Links inside the download are skipped. */
function placeTree(root: string, from: string, target: string, mode: 'hardlink' | 'copy' | 'move') {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const src = path.join(from, e.name);
    const dst = path.join(target, e.name);
    if (!insideRoot(root, dst)) throw new Error('Refusing to write outside the destination folder');
    if (e.isDirectory()) placeTree(root, src, dst, mode);
    else placeFile(src, dst, mode);
  }
  if (mode === 'move') fs.rmSync(from, { recursive: true, force: true });
}
