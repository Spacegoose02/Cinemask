import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { downloads } from '../db/schema.js';
import { sanitizeSegment } from './naming.js';

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

/** Downloads a file from a direct link into <downloads>/direct, following redirects safely. */
export async function startDirectDownload(ctx: AppContext, rawUrl: string, userId: number | null): Promise<number> {
  const allowPrivate = ctx.settings.get('downloading').allowPrivateDirectUrls;
  let url = await assertSafeUrl(rawUrl, allowPrivate);
  const name = sanitizeSegment(decodeURIComponent(path.basename(url.pathname)) || 'download') || 'download';
  const row = ctx.db
    .insert(downloads)
    .values({ title: name, protocol: 'direct', status: 'downloading', sourceUrl: url.toString(), addedBy: userId, addedAt: Date.now() })
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
      const dest = path.join(dir, `${row.id}-${name}`);
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
      await pipeline(body, fs.createWriteStream(dest, { mode: 0o644 }));
      ctx.db.update(downloads).set({ status: 'completed', progress: 1, size: received, outputPath: dest, completedAt: Date.now() }).where(eq(downloads.id, row.id)).run();
    } catch (err) {
      ctx.db.update(downloads).set({ status: 'failed', error: (err as Error).message }).where(eq(downloads.id, row.id)).run();
    }
  })();
  return row.id;
}
