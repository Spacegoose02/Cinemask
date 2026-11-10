import type { AppContext } from '../context.js';
import { WatchmaskClient } from '../integrations/watchmask.js';

/** The Watchmask client from saved settings, or null while it is switched off or not filled in. */
export function watchmaskClient(ctx: AppContext): WatchmaskClient | null {
  const s = ctx.settings.get('watchmask');
  return s.enabled && s.url && s.token ? new WatchmaskClient(s.url, s.token) : null;
}

/** Same, for callers that need it: says what to do when it isn't set up. */
export function requireWatchmask(ctx: AppContext): WatchmaskClient {
  const c = watchmaskClient(ctx);
  if (!c) throw new Error('Connect Watchmask in Settings → Metadata first');
  return c;
}

/**
 * Reads a Watchmask list link (https://track.example.com/list/68, or /list/<public link name>).
 * Only links on the connected Watchmask's own address count, so a pasted link can never point the
 * saved token at another server.
 */
export function watchmaskListRef(ctx: AppContext, url: URL): string | null {
  const s = ctx.settings.get('watchmask');
  if (!s.url) return null;
  let base: URL;
  try {
    base = new URL(s.url);
  } catch {
    return null;
  }
  if (url.protocol !== base.protocol || url.host.toLowerCase() !== base.host.toLowerCase()) return null;
  const prefix = base.pathname.replace(/\/+$/, '');
  if (prefix && !url.pathname.startsWith(`${prefix}/`)) return null;
  const m = url.pathname.slice(prefix.length).match(/^\/list\/([\w-]{1,100})\/?$/);
  return m ? m[1]! : null;
}
