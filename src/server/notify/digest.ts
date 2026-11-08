import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { libraryItems, movieNights, users, type MediaKind } from '../db/schema.js';
import { calendar } from '../calendar/service.js';
import { forViewer } from '../kids/ratings.js';
import { prefsOf, sendHtmlEmail } from './personal.js';

const WEEK = 7 * 24 * 60 * 60 * 1000;
/** Longest list per section, so a big first sync doesn't send a phone book. */
const MAX = 15;

export interface Digest {
  added: { kind: MediaKind; tmdbId: number; title: string; year: number | null }[];
  upcoming: { date: string; kind: MediaKind; tmdbId: number; title: string; detail: string }[];
  nights: { title: string; startsAt: number }[];
}

const sxe = (e: { season: number; episode: number }) => `S${String(e.season).padStart(2, '0')}E${String(e.episode).padStart(2, '0')}`;
const episodeLabel = (eps: { season: number; episode: number; title: string | null }[]) => (eps.length === 1 ? `${sxe(eps[0]!)}${eps[0]!.title ? ` · ${eps[0]!.title}` : ''}` : `${sxe(eps[0]!)} and ${eps.length - 1} more`);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** What's new on the servers in the last week and what comes out in the next, for one person (kids profiles see only their titles). */
export async function buildDigest(ctx: AppContext, userId: number, now = Date.now()): Promise<Digest> {
  const seen = new Set<string>();
  const added = ctx.db
    .select({ kind: libraryItems.kind, tmdbId: libraryItems.tmdbId, title: libraryItems.title, year: libraryItems.year, addedAt: libraryItems.addedAt })
    .from(libraryItems)
    .where(gte(libraryItems.addedAt, now - WEEK))
    .all()
    .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0))
    .filter((i): i is typeof i & { tmdbId: number } => {
      if (i.tmdbId === null || seen.has(`${i.kind}:${i.tmdbId}`)) return false;
      seen.add(`${i.kind}:${i.tmdbId}`);
      return true;
    })
    .map(({ kind, tmdbId, title, year }) => ({ kind, tmdbId, title, year }));
  const cal = calendar(ctx, day(now + 24 * 60 * 60 * 1000), day(now + WEEK));
  const upcoming = cal.map((c) => ({
    date: c.date,
    kind: c.kind,
    tmdbId: c.tmdbId,
    title: c.title,
    detail: c.episodes?.length ? episodeLabel(c.episodes) : c.releaseType === 'cinema' ? 'in cinemas' : c.releaseType === 'physical' ? 'on disc' : 'movie',
  }));
  const nights = ctx.db
    .select({ title: movieNights.title, startsAt: movieNights.startsAt })
    .from(movieNights)
    .where(and(gte(movieNights.startsAt, now), lte(movieNights.startsAt, now + WEEK)))
    .orderBy(asc(movieNights.startsAt))
    .all();
  return {
    added: (await forViewer(ctx, userId, added)).slice(0, MAX),
    upcoming: (await forViewer(ctx, userId, upcoming)).slice(0, MAX),
    nights,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The email itself, as plain text and simple HTML. Null when there's nothing to say. */
export function renderDigest(ctx: AppContext, d: Digest): { subject: string; text: string; html: string } | null {
  if (!d.added.length && !d.upcoming.length && !d.nights.length) return null;
  const base = ctx.settings.get('general').baseUrl.replace(/\/+$/, '');
  const link = (kind: MediaKind, id: number) => (base ? `${base}/${kind === 'movie' ? 'movie' : 'tv'}/${id}` : null);
  const when = (ms: number) => new Date(ms).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' });
  const sections: { heading: string; rows: { text: string; href: string | null }[] }[] = [];
  if (d.added.length) sections.push({ heading: 'New this week', rows: d.added.map((a) => ({ text: `${a.title}${a.year ? ` (${a.year})` : ''}`, href: link(a.kind, a.tmdbId) })) });
  if (d.upcoming.length) sections.push({ heading: 'Coming up', rows: d.upcoming.map((u) => ({ text: `${u.date}: ${u.title}, ${u.detail}`, href: link(u.kind, u.tmdbId) })) });
  if (d.nights.length) sections.push({ heading: 'Movie nights', rows: d.nights.map((n) => ({ text: `${n.title}, ${when(n.startsAt)}`, href: base ? `${base}/movie-nights` : null })) });
  const footer = 'You get this because you turned on the weekly email in Cinemask → Account → Notifications.';
  const text = [...sections.map((s) => `${s.heading}\n${s.rows.map((r) => `- ${r.text}`).join('\n')}`), footer].join('\n\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">${sections
    .map((s) => `<h2 style="font-size:16px;margin:20px 0 6px">${esc(s.heading)}</h2><ul style="padding-left:18px;margin:0">${s.rows.map((r) => `<li>${r.href ? `<a href="${esc(r.href)}">${esc(r.text)}</a>` : esc(r.text)}</li>`).join('')}</ul>`)
    .join('')}<p style="color:#777;font-size:12px;margin-top:24px">${esc(footer)}</p></div>`;
  return { subject: d.added.length ? `This week on Cinemask: ${d.added.length} new` : 'This week on Cinemask', text, html };
}

/** Sends one person their digest. Returns false when there was nothing to send. */
export async function sendDigestTo(ctx: AppContext, user: { id: number; email: string }, now = Date.now()): Promise<boolean> {
  const mail = renderDigest(ctx, await buildDigest(ctx, user.id, now));
  if (!mail) return false;
  await sendHtmlEmail(ctx, user.email, mail);
  return true;
}

/** The weekly run: everyone who asked for the digest and has an address. Called hourly; sends only at the chosen day and hour. */
export async function weeklyDigest(ctx: AppContext, now = new Date()): Promise<number> {
  const s = ctx.settings.get('email');
  if (!s.enabled || !s.digestEnabled || now.getDay() !== s.digestDay || now.getHours() !== s.digestHour) return 0;
  let sent = 0;
  for (const u of ctx.db.select().from(users).where(eq(users.disabled, false)).all()) {
    if (!u.email || !prefsOf(u.notifyPrefs).digest) continue;
    try {
      if (await sendDigestTo(ctx, { id: u.id, email: u.email }, now.getTime())) sent++;
    } catch {
      // One bad address doesn't stop the rest.
    }
  }
  return sent;
}
