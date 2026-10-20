import { createHash } from 'node:crypto';
import type { DownloadClientType } from '../db/schema.js';
import { connectError, IntegrationError } from '../integrations/http.js';

export interface ClientItem {
  id: string;
  name: string;
  /** 0..1 */
  progress: number;
  status: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed';
  size: number;
  /** Folder or file holding the finished download, as the client sees it. */
  outputPath: string | null;
  tags: string[];
  error?: string;
  /** Download speed in bytes per second, when the client reports it. */
  speed?: number;
  /** Seconds left, when the client reports it. */
  eta?: number;
}

/** Clients use huge numbers or negatives for "unknown"; keep only sensible ETAs. */
const etaOf = (n: unknown) => (typeof n === 'number' && n >= 0 && n < 100 * 24 * 3600 ? n : undefined);

export interface AddOptions {
  category: string;
  /** Unique per download, so the item can be found again even when the client doesn't return an id. */
  tag: string;
  title: string;
}

export interface DownloadClient {
  test(): Promise<string>;
  /** Returns the client's id for the item when it is known straight away. */
  add(url: string, opts: AddOptions): Promise<string | null>;
  /** Items in the category, plus any of `ids` (the client's own ids) wherever they ended up. */
  list(category: string, ids?: string[]): Promise<ClientItem[]>;
  remove(id: string, deleteData: boolean): Promise<void>;
}

export interface ClientConfig {
  type: DownloadClientType;
  name: string;
  url: string;
  username: string | null;
  password: string | null;
}

const base = (url: string) => url.replace(/\/+$/, '');

/** "1:02:03" or "1:02:03:04" (with days) → seconds. */
const hms = (t: string) => t.split(':').reduce((acc, n, i, all) => acc + Number(n) * [86400, 3600, 60, 1].slice(4 - all.length)[i]!, 0);

async function request(service: string, url: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    // A named client: some proxies in front of download clients turn away fetch's default agent.
    res = await fetch(url, { ...init, headers: { 'user-agent': 'Cinemask', ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new IntegrationError(service, connectError(err));
  }
  return res;
}

function ensureOk(service: string, res: Response) {
  if (res.status === 401 || res.status === 403) throw new IntegrationError(service, 'login was rejected', res.status);
  if (!res.ok) throw new IntegrationError(service, `responded with HTTP ${res.status}`, res.status);
}

/**
 * Fetches a release's .torrent or .nzb here and hands the client the file, as Sonarr and Radarr do.
 * Passing the link would make the client fetch it itself, which fails silently when the client
 * can't reach the indexer (a VPN container, or a host name only Cinemask resolves). A link that
 * redirects to a magnet comes back as that magnet.
 */
export async function fetchRelease(service: string, url: string): Promise<{ magnet: string } | { file: Buffer }> {
  if (/^magnet:/i.test(url)) return { magnet: url };
  let next = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await request(service, next, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      if (/^magnet:/i.test(location)) return { magnet: location };
      next = new URL(location, next).toString();
      continue;
    }
    if (!res.ok) throw new IntegrationError(service, `the indexer answered HTTP ${res.status} when fetching the release`, res.status);
    const file = Buffer.from(await res.arrayBuffer());
    if (file.length > 20 * 1024 * 1024) throw new IntegrationError(service, 'the release file is too big to be a .torrent or .nzb');
    return { file };
  }
  throw new IntegrationError(service, 'too many redirects fetching the release');
}

/** The info hash of a .torrent file (SHA-1 of its bencoded "info" dictionary), or null if it can't be read. */
export function torrentHash(file: Buffer): string | null {
  // Walks the bencoding just far enough to find where the top-level "info" value starts and ends.
  const skip = (i: number): number => {
    const c = file[i];
    if (c === 0x69) return file.indexOf(0x65, i) + 1; // i…e
    if (c === 0x6c || c === 0x64) {
      i++;
      while (file[i] !== 0x65) {
        if (i >= file.length) throw new Error('truncated');
        i = skip(i);
      }
      return i + 1;
    }
    const colon = file.indexOf(0x3a, i);
    if (colon < 0) throw new Error('bad string');
    return colon + 1 + Number(file.subarray(i, colon).toString('latin1'));
  };
  try {
    if (file[0] !== 0x64) return null;
    let i = 1;
    while (i < file.length && file[i] !== 0x65) {
      const keyEnd = skip(i);
      const key = file.subarray(file.indexOf(0x3a, i) + 1, keyEnd).toString('latin1');
      const valueEnd = skip(keyEnd);
      if (key === 'info') return createHash('sha1').update(file.subarray(keyEnd, valueEnd)).digest('hex');
      i = valueEnd;
    }
  } catch {
    // not a torrent file
  }
  return null;
}

export function magnetHash(url: string): string | null {
  const m = /xt=urn:btih:([a-f0-9]{40}|[a-z2-7]{32})/i.exec(url);
  return m ? m[1]!.toLowerCase() : null;
}

// ---------- qBittorrent (Web API v2) ----------
class QBittorrent implements DownloadClient {
  private cookie: string | null = null;
  constructor(private readonly c: ClientConfig) {}

  private async login() {
    // No Referer or Origin: behind a reverse proxy (https://torrent.example.com) qBittorrent's
    // cross-site check compares them with the Host it sees, which can differ, and rejects the
    // sign-in. Sent without either, the check passes, as it does for Sonarr and Radarr.
    const res = await request(this.c.name, `${base(this.c.url)}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: this.c.username ?? '', password: this.c.password ?? '' }),
    });
    const text = (await res.text()).trim();
    if (res.status === 403 && /banned/i.test(text)) throw new IntegrationError(this.c.name, 'too many failed sign-ins, so qBittorrent has blocked Cinemask for now (restart qBittorrent or wait, then check the username and password)', 403);
    if (res.status === 401 || res.status === 403) {
      // An HTML page is a proxy or firewall in front of qBittorrent (Cloudflare, Authelia…), not qBittorrent itself.
      if (/<html/i.test(text)) throw new IntegrationError(this.c.name, `the sign-in was blocked before it reached qBittorrent (HTTP ${res.status} from a proxy in front of it). Use qBittorrent's local address, such as http://192.168.1.10:8080, or let Cinemask through the proxy`, res.status);
      throw new IntegrationError(this.c.name, `qBittorrent refused the sign-in (HTTP ${res.status}). If it's behind a reverse proxy, turn on "Enable reverse proxy support" in its Web UI settings, or use its local address`, res.status);
    }
    ensureOk(this.c.name, res);
    // qBittorrent 5.2+ answers a good sign-in with 204 and no body; older versions say "Ok." and a bad one "Fails.".
    if (res.status !== 204 && text !== 'Ok.') throw new IntegrationError(this.c.name, 'login was rejected: check the username and password');
    this.cookie = res.headers.get('set-cookie')?.split(';')[0] ?? null;
  }

  private async call(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    if (!this.cookie) await this.login();
    const res = await request(this.c.name, `${base(this.c.url)}/api/v2${path}`, { ...init, headers: { ...init.headers, Cookie: this.cookie ?? '' } });
    if (res.status === 403 && retry) {
      this.cookie = null;
      return this.call(path, init, false);
    }
    ensureOk(this.c.name, res);
    return res;
  }

  async test() {
    const v = await (await this.call('/app/version')).text();
    return `Connected to qBittorrent ${v}`;
  }

  async add(url: string, o: AddOptions) {
    const got = await fetchRelease(this.c.name, url);
    let res: Response;
    if ('magnet' in got) {
      const body = new URLSearchParams({ urls: got.magnet, category: o.category, tags: o.tag });
      res = await this.call('/torrents/add', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    } else {
      const form = new FormData();
      form.append('torrents', new Blob([new Uint8Array(got.file)], { type: 'application/x-bittorrent' }), `${o.tag}.torrent`);
      form.append('category', o.category);
      form.append('tags', o.tag);
      res = await this.call('/torrents/add', { method: 'POST', body: form });
    }
    // qBittorrent answers 200 "Fails." when it couldn't add the torrent (older versions) or 415 (newer).
    if ((await res.text()).trim() === 'Fails.') throw new IntegrationError(this.c.name, "couldn't add the torrent (it may already be in qBittorrent, or the file isn't a valid torrent)");
    return 'magnet' in got ? magnetHash(got.magnet) : torrentHash(got.file);
  }

  async list(category: string) {
    const items = (await (await this.call(`/torrents/info?category=${encodeURIComponent(category)}`)).json()) as {
      hash: string;
      name: string;
      progress: number;
      state: string;
      size: number;
      content_path?: string;
      save_path: string;
      tags: string;
      dlspeed?: number;
      eta?: number;
    }[];
    return items.map((t): ClientItem => {
      const done = t.progress >= 1 || ['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP', 'checkingUP'].includes(t.state);
      const status: ClientItem['status'] = t.state === 'error' || t.state === 'missingFiles' ? 'failed' : done ? 'completed' : t.state.startsWith('paused') || t.state.startsWith('stopped') ? 'paused' : t.state.startsWith('queued') ? 'queued' : 'downloading';
      return { id: t.hash, name: t.name, progress: t.progress, status, size: t.size, outputPath: t.content_path ?? `${t.save_path}/${t.name}`, tags: t.tags.split(',').map((x) => x.trim()).filter(Boolean), speed: t.dlspeed, eta: etaOf(t.eta) };
    });
  }

  async remove(id: string, deleteData: boolean) {
    await this.call('/torrents/delete', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ hashes: id, deleteFiles: String(deleteData) }) });
  }
}

// ---------- Transmission (RPC) ----------
class Transmission implements DownloadClient {
  private session = '';
  constructor(private readonly c: ClientConfig) {}

  private async rpc<T>(method: string, args: Record<string, unknown> = {}, retry = true): Promise<T> {
    const url = /\/rpc$/.test(base(this.c.url)) ? base(this.c.url) : `${base(this.c.url)}/transmission/rpc`;
    const auth: Record<string, string> = this.c.username ? { Authorization: `Basic ${Buffer.from(`${this.c.username}:${this.c.password ?? ''}`).toString('base64')}` } : {};
    const res = await request(this.c.name, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Transmission-Session-Id': this.session, ...auth },
      body: JSON.stringify({ method, arguments: args }),
    });
    if (res.status === 409 && retry) {
      this.session = res.headers.get('x-transmission-session-id') ?? '';
      return this.rpc(method, args, false);
    }
    ensureOk(this.c.name, res);
    const body = (await res.json()) as { result: string; arguments: T };
    if (body.result !== 'success') throw new IntegrationError(this.c.name, body.result);
    return body.arguments;
  }

  async test() {
    const s = await this.rpc<{ version: string }>('session-get', { fields: ['version'] });
    return `Connected to Transmission ${s.version}`;
  }

  async add(url: string, o: AddOptions) {
    const got = await fetchRelease(this.c.name, url);
    const source = 'magnet' in got ? { filename: got.magnet } : { metainfo: got.file.toString('base64') };
    const r = await this.rpc<{ 'torrent-added'?: { hashString: string }; 'torrent-duplicate'?: { hashString: string } }>('torrent-add', { ...source, labels: [o.category, o.tag] });
    return (r['torrent-added'] ?? r['torrent-duplicate'])?.hashString ?? null;
  }

  async list(category: string) {
    const r = await this.rpc<{ torrents: { hashString: string; name: string; percentDone: number; status: number; totalSize: number; downloadDir: string; labels?: string[]; error: number; errorString: string; rateDownload?: number; eta?: number }[] }>(
      'torrent-get',
      { fields: ['hashString', 'name', 'percentDone', 'status', 'totalSize', 'downloadDir', 'labels', 'error', 'errorString', 'rateDownload', 'eta'] },
    );
    return r.torrents
      .filter((t) => (t.labels ?? []).includes(category))
      .map((t): ClientItem => ({
        id: t.hashString,
        name: t.name,
        progress: t.percentDone,
        // 0 stopped, 1-2 checking, 3 queued, 4 downloading, 5 queued seed, 6 seeding
        status: t.error > 1 ? 'failed' : t.percentDone >= 1 ? 'completed' : t.status === 0 ? 'paused' : t.status === 3 ? 'queued' : 'downloading',
        size: t.totalSize,
        outputPath: `${t.downloadDir}/${t.name}`,
        tags: t.labels ?? [],
        error: t.error ? t.errorString : undefined,
        speed: t.rateDownload,
        eta: etaOf(t.eta),
      }));
  }

  async remove(id: string, deleteData: boolean) {
    await this.rpc('torrent-remove', { ids: [id], 'delete-local-data': deleteData });
  }
}

// ---------- Deluge (Web JSON-RPC) ----------
class Deluge implements DownloadClient {
  private cookie = '';
  private seq = 0;
  constructor(private readonly c: ClientConfig) {}

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const res = await request(this.c.name, `${base(this.c.url)}/json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: this.cookie },
      body: JSON.stringify({ method, params, id: ++this.seq }),
    });
    ensureOk(this.c.name, res);
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const body = (await res.json()) as { result: T; error: { message: string } | null };
    if (body.error) throw new IntegrationError(this.c.name, body.error.message);
    return body.result;
  }

  private async ensureLogin() {
    if (this.cookie) return;
    const ok = await this.rpc<boolean>('auth.login', [this.c.password ?? '']);
    if (!ok) throw new IntegrationError(this.c.name, 'login was rejected');
    await this.rpc<boolean>('web.connected').then(async (connected) => {
      if (connected) return;
      const hosts = await this.rpc<[string][]>('web.get_hosts');
      if (hosts[0]) await this.rpc('web.connect', [hosts[0][0]]);
    });
  }

  async test() {
    await this.ensureLogin();
    const v = await this.rpc<string>('daemon.get_version').catch(() => 'unknown');
    return `Connected to Deluge ${v}`;
  }

  async add(url: string, o: AddOptions) {
    await this.ensureLogin();
    const id = url.startsWith('magnet:') ? await this.rpc<string>('core.add_torrent_magnet', [url, {}]) : await this.rpc<string>('core.add_torrent_url', [url, {}]);
    if (id) {
      // The Label plugin is optional; without it the download is still tracked by its id.
      await this.rpc('label.add', [o.category]).catch(() => undefined);
      await this.rpc('label.set_torrent', [id, o.category]).catch(() => undefined);
    }
    return id ?? magnetHash(url);
  }

  async list(category: string) {
    await this.ensureLogin();
    const r = await this.rpc<{ torrents: Record<string, { name: string; progress: number; state: string; total_size: number; save_path: string; label?: string; download_payload_rate?: number; eta?: number }> }>('web.update_ui', [
      ['name', 'progress', 'state', 'total_size', 'save_path', 'label', 'download_payload_rate', 'eta'],
      {},
    ]);
    return Object.entries(r.torrents ?? {})
      .filter(([, t]) => !t.label || t.label === category)
      .map(([hash, t]): ClientItem => ({
        id: hash,
        name: t.name,
        progress: t.progress / 100,
        status: t.state === 'Error' ? 'failed' : t.progress >= 100 || t.state === 'Seeding' ? 'completed' : t.state === 'Paused' ? 'paused' : t.state === 'Queued' ? 'queued' : 'downloading',
        size: t.total_size,
        outputPath: `${t.save_path}/${t.name}`,
        tags: t.label ? [t.label] : [],
        speed: t.download_payload_rate,
        eta: t.eta ? etaOf(t.eta) : undefined,
      }));
  }

  async remove(id: string, deleteData: boolean) {
    await this.ensureLogin();
    await this.rpc('core.remove_torrent', [id, deleteData]);
  }
}

// ---------- rTorrent (XML-RPC, e.g. via ruTorrent's /RPC2) ----------
function xmlValue(v: string | number): string {
  return typeof v === 'number' ? `<value><i8>${v}</i8></value>` : `<value><string>${v.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string></value>`;
}

class RTorrent implements DownloadClient {
  constructor(private readonly c: ClientConfig) {}

  private async call(method: string, params: (string | number)[]): Promise<string> {
    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map((p) => `<param>${xmlValue(p)}</param>`).join('')}</params></methodCall>`;
    const auth: Record<string, string> = this.c.username ? { Authorization: `Basic ${Buffer.from(`${this.c.username}:${this.c.password ?? ''}`).toString('base64')}` } : {};
    const res = await request(this.c.name, base(this.c.url), { method: 'POST', headers: { 'content-type': 'text/xml', ...auth }, body });
    ensureOk(this.c.name, res);
    const text = await res.text();
    if (text.includes('<fault>')) throw new IntegrationError(this.c.name, 'returned an error');
    return text;
  }

  async test() {
    const r = await this.call('system.client_version', []);
    return `Connected to rTorrent ${/<string>([^<]+)<\/string>/.exec(r)?.[1] ?? ''}`.trim();
  }

  async add(url: string, o: AddOptions) {
    await this.call('load.start', ['', url, `d.custom1.set=${o.category}`, `d.custom2.set=${o.tag}`]);
    return magnetHash(url)?.toUpperCase() ?? null;
  }

  async list(category: string) {
    const r = await this.call('d.multicall2', ['', 'main', 'd.hash=', 'd.name=', 'd.completed_bytes=', 'd.size_bytes=', 'd.complete=', 'd.state=', 'd.base_path=', 'd.custom1=', 'd.custom2=', 'd.message=', 'd.down.rate=']);
    const rows = [...r.matchAll(/<value><array><data>([\s\S]*?)<\/data><\/array><\/value>/g)].map((m) =>
      [...m[1]!.matchAll(/<value>(?:<(?:string|i8|i4|int)>)?([^<]*)(?:<\/(?:string|i8|i4|int)>)?<\/value>/g)].map((v) => v[1]!),
    );
    return rows
      .filter((x) => x[7] === category)
      .map((x): ClientItem => {
        const done = x[4] === '1';
        return {
          id: x[0]!,
          name: x[1]!,
          progress: Number(x[3]) ? Number(x[2]) / Number(x[3]) : 0,
          status: x[9] ? 'failed' : done ? 'completed' : x[5] === '0' ? 'paused' : 'downloading',
          size: Number(x[3]),
          outputPath: x[6] || null,
          tags: [x[7]!, x[8]!].filter(Boolean),
          error: x[9] || undefined,
          speed: Number(x[10]) || 0,
          eta: Number(x[10]) ? etaOf(Math.round((Number(x[3]) - Number(x[2])) / Number(x[10]))) : undefined,
        };
      });
  }

  async remove(id: string, deleteData: boolean) {
    // rTorrent can't delete data itself; the importer leaves files in place and the user's client settings decide.
    void deleteData;
    await this.call('d.erase', [id]);
  }
}

// ---------- Flood ----------
class Flood implements DownloadClient {
  private cookie = '';
  constructor(private readonly c: ClientConfig) {}

  private async call(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    if (!this.cookie) {
      const res = await request(this.c.name, `${base(this.c.url)}/api/auth/authenticate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: this.c.username ?? '', password: this.c.password ?? '' }),
      });
      ensureOk(this.c.name, res);
      this.cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    }
    const res = await request(this.c.name, `${base(this.c.url)}/api${path}`, { ...init, headers: { 'content-type': 'application/json', ...init.headers, Cookie: this.cookie } });
    if (res.status === 401 && retry) {
      this.cookie = '';
      return this.call(path, init, false);
    }
    ensureOk(this.c.name, res);
    return res;
  }

  async test() {
    await this.call('/client/connection-test');
    return 'Connected to Flood';
  }

  async add(url: string, o: AddOptions) {
    await this.call('/torrents/add-urls', { method: 'POST', body: JSON.stringify({ urls: [url], tags: [o.category, o.tag], start: true }) });
    return magnetHash(url)?.toUpperCase() ?? null;
  }

  async list(category: string) {
    const r = (await (await this.call('/torrents')).json()) as { torrents: Record<string, { hash: string; name: string; percentComplete: number; status: string[]; sizeBytes: number; directory: string; tags: string[]; downRate?: number; eta?: number }> };
    return Object.values(r.torrents ?? {})
      .filter((t) => t.tags.includes(category))
      .map((t): ClientItem => ({
        id: t.hash,
        name: t.name,
        progress: t.percentComplete / 100,
        status: t.status.includes('error') ? 'failed' : t.percentComplete >= 100 || t.status.includes('complete') ? 'completed' : t.status.includes('stopped') ? 'paused' : 'downloading',
        size: t.sizeBytes,
        outputPath: `${t.directory}/${t.name}`,
        tags: t.tags,
        speed: t.downRate,
        eta: etaOf(t.eta),
      }));
  }

  async remove(id: string, deleteData: boolean) {
    await this.call('/torrents/delete', { method: 'POST', body: JSON.stringify({ hashes: [id], deleteData }) });
  }
}

// ---------- uTorrent (WebUI) ----------
class UTorrent implements DownloadClient {
  private token = '';
  private cookie = '';
  constructor(private readonly c: ClientConfig) {}

  private auth() {
    return { Authorization: `Basic ${Buffer.from(`${this.c.username ?? ''}:${this.c.password ?? ''}`).toString('base64')}` };
  }

  private async call(query: string): Promise<Response> {
    if (!this.token) {
      const res = await request(this.c.name, `${base(this.c.url)}/gui/token.html`, { headers: this.auth() });
      ensureOk(this.c.name, res);
      this.token = /<div[^>]*id=['"]token['"][^>]*>([^<]+)</.exec(await res.text())?.[1] ?? '';
      this.cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
    }
    const res = await request(this.c.name, `${base(this.c.url)}/gui/?token=${encodeURIComponent(this.token)}&${query}`, { headers: { ...this.auth(), Cookie: this.cookie } });
    ensureOk(this.c.name, res);
    return res;
  }

  async test() {
    await this.call('list=1');
    return 'Connected to uTorrent';
  }

  async add(url: string, o: AddOptions) {
    await this.call(`action=add-url&s=${encodeURIComponent(url)}`);
    const hash = magnetHash(url)?.toUpperCase() ?? null;
    if (hash) await this.call(`action=setprops&hash=${hash}&s=label&v=${encodeURIComponent(o.category)}`);
    return hash;
  }

  async list(category: string) {
    const r = (await (await this.call('list=1')).json()) as { torrents: (string | number)[][] };
    return (r.torrents ?? [])
      .filter((t) => t[11] === category || !t[11])
      .map((t): ClientItem => {
        const status = Number(t[1]);
        const progress = Number(t[4]) / 1000;
        return {
          id: String(t[0]),
          name: String(t[2]),
          progress,
          status: status & 16 ? 'failed' : progress >= 1 ? 'completed' : status & 32 ? 'paused' : status & 1 ? 'downloading' : 'queued',
          size: Number(t[3]),
          outputPath: t[26] ? String(t[26]) : null,
          tags: t[11] ? [String(t[11])] : [],
          speed: Number(t[9]) || 0,
          eta: etaOf(Number(t[10])),
        };
      });
  }

  async remove(id: string, deleteData: boolean) {
    await this.call(`action=${deleteData ? 'removedata' : 'remove'}&hash=${id}`);
  }
}

// ---------- SABnzbd ----------
class Sabnzbd implements DownloadClient {
  constructor(private readonly c: ClientConfig) {}

  private async api<T>(params: Record<string, string>): Promise<T> {
    // The API key is stored in the password field.
    const qs = new URLSearchParams({ ...params, apikey: this.c.password ?? '', output: 'json' });
    const res = await request(this.c.name, `${base(this.c.url)}/api?${qs.toString()}`);
    ensureOk(this.c.name, res);
    const body = (await res.json()) as T & { status?: boolean; error?: string };
    if (body.error) throw new IntegrationError(this.c.name, body.error);
    return body;
  }

  async test() {
    const r = await this.api<{ version: string }>({ mode: 'version' });
    await this.api({ mode: 'queue', limit: '1' });
    return `Connected to SABnzbd ${r.version}`;
  }

  async add(url: string, o: AddOptions) {
    // Jobs are followed by the nzo_id this returns, so the name stays the release title. (A "{{tag}}" in
    // the name, as before, is read by SABnzbd as the archive password.)
    const got = await fetchRelease(this.c.name, url);
    if ('magnet' in got) throw new IntegrationError(this.c.name, 'that release is a torrent, not an NZB');
    // Uploaded rather than passed as a link, so SABnzbd needn't reach the indexer itself.
    const form = new FormData();
    form.append('name', new Blob([new Uint8Array(got.file)], { type: 'application/x-nzb' }), `${o.title}.nzb`);
    const qs = new URLSearchParams({ mode: 'addfile', cat: o.category, nzbname: o.title, apikey: this.c.password ?? '', output: 'json' });
    const res = await request(this.c.name, `${base(this.c.url)}/api?${qs.toString()}`, { method: 'POST', body: form });
    ensureOk(this.c.name, res);
    const r = (await res.json()) as { nzo_ids?: string[]; error?: string; status?: boolean };
    if (r.error || r.status === false) throw new IntegrationError(this.c.name, r.error ?? 'refused the NZB');
    return r.nzo_ids?.[0] ?? null;
  }

  async list(category: string, ids: string[] = []) {
    type Queue = { queue: { slots: { nzo_id: string; filename: string; percentage: string; status: string; mb: string; cat: string; timeleft?: string }[] } };
    type History = { history: { slots: { nzo_id: string; name: string; status: string; storage: string; bytes: number; category: string; fail_message: string }[] } };
    // Asking by id as well finds jobs whose category SABnzbd changed (an unknown category becomes the default one)
    // and jobs that fell past the history page.
    const byId = ids.length ? { nzo_ids: ids.join(',') } : null;
    const [q, h, qIds, hIds] = await Promise.all([
      this.api<Queue>({ mode: 'queue', cat: category }),
      this.api<History>({ mode: 'history', category, limit: '100' }),
      byId ? this.api<Queue>({ mode: 'queue', ...byId }) : null,
      byId ? this.api<History>({ mode: 'history', ...byId }) : null,
    ]);
    const tagOf = (n: string) => /\{\{(mm-\d+)\}\}/.exec(n)?.[1];
    const seen = new Set<string>();
    const queue = [...q.queue.slots, ...(qIds?.queue.slots ?? [])].filter((s) => !seen.has(s.nzo_id) && seen.add(s.nzo_id));
    const history = [...h.history.slots, ...(hIds?.history.slots ?? [])].filter((s) => !seen.has(s.nzo_id) && seen.add(s.nzo_id));
    return [
      ...queue.map((s): ClientItem => ({
        id: s.nzo_id,
        name: s.filename,
        progress: Number(s.percentage) / 100,
        status: s.status === 'Paused' ? 'paused' : s.status === 'Queued' ? 'queued' : 'downloading',
        size: Number(s.mb) * 1024 * 1024,
        outputPath: null,
        tags: [s.cat, tagOf(s.filename)].filter((x): x is string => Boolean(x)),
        eta: s.status === 'Downloading' && s.timeleft ? etaOf(hms(s.timeleft)) : undefined,
      })),
      ...history.map((s): ClientItem => ({
        id: s.nzo_id,
        name: s.name,
        // Anything else in the history (Verifying, Repairing, Extracting, Moving, Running) is downloaded and being unpacked.
        progress: s.status === 'Failed' ? 0 : 1,
        status: s.status === 'Completed' ? 'completed' : s.status === 'Failed' ? 'failed' : 'downloading',
        size: s.bytes,
        outputPath: s.storage || null,
        tags: [s.category, tagOf(s.name)].filter((x): x is string => Boolean(x)),
        error: s.fail_message || undefined,
      })),
    ];
  }

  async remove(id: string, deleteData: boolean) {
    await this.api({ mode: 'queue', name: 'delete', value: id, del_files: deleteData ? '1' : '0' });
    await this.api({ mode: 'history', name: 'delete', value: id, del_files: deleteData ? '1' : '0' });
  }
}

// ---------- NZBGet (JSON-RPC) ----------
class Nzbget implements DownloadClient {
  constructor(private readonly c: ClientConfig) {}

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const auth = { Authorization: `Basic ${Buffer.from(`${this.c.username ?? ''}:${this.c.password ?? ''}`).toString('base64')}` };
    const res = await request(this.c.name, `${base(this.c.url)}/jsonrpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ method, params }) });
    ensureOk(this.c.name, res);
    const body = (await res.json()) as { result: T; error?: { message: string } | null };
    if (body.error) throw new IntegrationError(this.c.name, body.error.message);
    return body.result;
  }

  async test() {
    return `Connected to NZBGet ${await this.rpc<string>('version')}`;
  }

  async add(url: string, o: AddOptions) {
    const id = await this.rpc<number>('append', [`${o.title}.nzb`, url, o.category, 0, false, false, o.tag, 0, 'SCORE', [{ Name: 'mmTag', Value: o.tag }]]);
    if (id <= 0) throw new IntegrationError(this.c.name, 'refused the download');
    return String(id);
  }

  async list(category: string) {
    type Group = { NZBID: number; NZBName: string; Category: string; FileSizeMB: number; RemainingSizeMB: number; Status: string; DestDir: string; DupeKey?: string };
    type Hist = { NZBID: number; Name: string; Category: string; Status: string; DestDir: string; FinalDir: string; FileSizeMB: number; DupeKey?: string };
    const groups = await this.rpc<Group[]>('listgroups', [0]);
    const history = await this.rpc<Hist[]>('history', [false]);
    return [
      ...groups
        .filter((g) => g.Category === category)
        .map((g): ClientItem => ({
          id: String(g.NZBID),
          name: g.NZBName,
          progress: g.FileSizeMB ? 1 - g.RemainingSizeMB / g.FileSizeMB : 0,
          status: g.Status.startsWith('PAUSED') ? 'paused' : g.Status === 'QUEUED' ? 'queued' : 'downloading',
          size: g.FileSizeMB * 1024 * 1024,
          outputPath: g.DestDir || null,
          tags: [g.Category, g.DupeKey ?? ''].filter(Boolean),
        })),
      ...history
        .filter((h) => h.Category === category)
        .map((h): ClientItem => ({
          id: String(h.NZBID),
          name: h.Name,
          progress: h.Status.startsWith('SUCCESS') ? 1 : 0,
          status: h.Status.startsWith('SUCCESS') ? 'completed' : 'failed',
          size: h.FileSizeMB * 1024 * 1024,
          outputPath: h.FinalDir || h.DestDir || null,
          tags: [h.Category, h.DupeKey ?? ''].filter(Boolean),
          error: h.Status.startsWith('SUCCESS') ? undefined : h.Status,
        })),
    ];
  }

  async remove(id: string, deleteData: boolean) {
    await this.rpc('editqueue', [deleteData ? 'GroupFinalDelete' : 'GroupDelete', '', [Number(id)]]);
  }
}

export const CLIENT_PROTOCOL: Record<DownloadClientType, 'torrent' | 'usenet'> = {
  qbittorrent: 'torrent',
  transmission: 'torrent',
  deluge: 'torrent',
  rtorrent: 'torrent',
  flood: 'torrent',
  utorrent: 'torrent',
  sabnzbd: 'usenet',
  nzbget: 'usenet',
};

export function createClient(c: ClientConfig): DownloadClient {
  switch (c.type) {
    case 'qbittorrent':
      return new QBittorrent(c);
    case 'transmission':
      return new Transmission(c);
    case 'deluge':
      return new Deluge(c);
    case 'rtorrent':
      return new RTorrent(c);
    case 'flood':
      return new Flood(c);
    case 'utorrent':
      return new UTorrent(c);
    case 'sabnzbd':
      return new Sabnzbd(c);
    case 'nzbget':
      return new Nzbget(c);
  }
}
