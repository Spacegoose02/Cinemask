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

export async function fetchJson<T>(service: string, url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json', ...init.headers } });
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : 'could not connect';
    throw new IntegrationError(service, reason);
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
