/** Error from an outside service. Messages never include URLs, which may carry API keys. */
export class IntegrationError extends Error {
  constructor(
    public readonly service: string,
    message: string,
    public readonly status?: number,
  ) {
    super(`${service}: ${message}`);
  }
}

/**
 * Why a request never got an answer, in words someone can act on. Node puts the system error on
 * err.cause (ECONNREFUSED, ENOTFOUND, certificate problems…); nothing here includes the URL.
 */
export function connectError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timed out (no answer from that address)';
  const code = e?.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "could not connect: that host name doesn't resolve from the Cinemask container (DNS)";
  if (code === 'ECONNREFUSED') return 'could not connect: the connection was refused (is it running, and is the port right?)';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return "could not connect: that address isn't reachable from the Cinemask container";
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return 'could not connect: the connection was closed (http vs https mix-up, or a proxy in between?)';
  if (/CERT|SELF_SIGNED|SSL|TLS/i.test(code)) return `could not connect: its HTTPS certificate isn't trusted (${code})`;
  return code ? `could not connect (${code})` : 'could not connect';
}

export async function fetchJson<T>(service: string, url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json', ...init.headers } });
  } catch (err) {
    throw new IntegrationError(service, connectError(err));
  }
  if (res.status === 401 || res.status === 403) throw new IntegrationError(service, 'the API key or token was rejected', res.status);
  if (!res.ok) throw new IntegrationError(service, `responded with HTTP ${res.status}`, res.status);
  try {
    return (await res.json()) as T;
  } catch {
    throw new IntegrationError(service, 'returned something that is not JSON');
  }
}

/** Maps a server's reported resolution to one of 2160p, 1080p, 720p, SD. */
export function normalizeResolution(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).toLowerCase();
  if (v === '4k' || v.startsWith('2160') || Number(v) >= 2000) return '2160p';
  if (v.startsWith('1080') || (Number(v) >= 1000 && Number(v) < 2000)) return '1080p';
  if (v.startsWith('720') || (Number(v) >= 700 && Number(v) < 1000)) return '720p';
  return 'SD';
}

export const RESOLUTION_RANK: Record<string, number> = { SD: 1, '720p': 2, '1080p': 3, '2160p': 4 };

export function bestResolution(values: (string | null)[]): string | null {
  return values.reduce<string | null>((best, v) => (v && (!best || RESOLUTION_RANK[v]! > RESOLUTION_RANK[best]!) ? v : best), null);
}
