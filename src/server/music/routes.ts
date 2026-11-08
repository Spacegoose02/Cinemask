import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { hasRole } from '../auth/guard.js';
import { ALBUM_STATUSES, albums, musicArtists } from '../db/schema.js';
import { MBID } from '../integrations/musicbrainz.js';
import { upstream } from '../library/routes.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { notify } from '../notify/service.js';
import { annotateAlbums, getAlbum, musicBrainz, startAlbumDownload } from './service.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const mbid = z.string().regex(MBID, 'Not a MusicBrainz id');

export async function musicRoutes(app: FastifyInstance) {
  const ctx = app.ctx;

  // ---------------- Discovery (MusicBrainz) ----------------
  app.get('/api/music/search', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ q: z.string().trim().min(1).max(200), type: z.enum(['artist', 'album']).default('artist') }), req.query);
    const mb = musicBrainz(ctx);
    if (q.type === 'artist') {
      const artists = await upstream(() => mb.searchArtists(q.q));
      const followed = new Set(ctx.db.select({ m: musicArtists.mbid }).from(musicArtists).all().map((r) => r.m));
      return { artists: artists.map((a) => ({ ...a, followed: followed.has(a.mbid) })) };
    }
    return { albums: annotateAlbums(ctx, await upstream(() => mb.searchAlbums(q.q))) };
  });

  app.get('/api/music/artist/:mbid', { config: { access: 'user' } }, async (req) => {
    const p = parse(z.object({ mbid }), req.params);
    const mb = musicBrainz(ctx);
    const artist = await upstream(() => mb.artist(p.mbid));
    if (!artist) throw notFound('Artist not found');
    const list = await upstream(() => mb.albumsBy(artist));
    const followed = ctx.db.select().from(musicArtists).where(eq(musicArtists.mbid, p.mbid)).get();
    return { artist: { ...artist, followed: Boolean(followed), followId: followed?.id ?? null }, albums: annotateAlbums(ctx, list) };
  });

  // ---------------- Requests ----------------
  app.get('/api/music', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ status: z.enum([...ALBUM_STATUSES, 'all']).default('all'), mine: z.coerce.boolean().default(false) }), req.query);
    const onlyMine = q.mine || !hasRole(req.user!.role, 'manager');
    return ctx.db
      .select()
      .from(albums)
      .where(and(q.status === 'all' ? undefined : eq(albums.status, q.status), onlyMine ? eq(albums.requestedBy, req.user!.id) : undefined))
      .orderBy(desc(albums.createdAt))
      .limit(500)
      .all();
  });

  const approve = (id: number, deciderName: string, deciderId: number) => {
    ctx.db.update(albums).set({ status: 'approved', decidedByName: deciderName, decidedAt: Date.now() }).where(eq(albums.id, id)).run();
    void startAlbumDownload(ctx, id, deciderId).catch((err) => app.log.warn({ err }, 'Album download failed to start'));
  };

  /** Requests an album. Its title, artist and year come from MusicBrainz, not the browser. */
  app.post('/api/music', { config: { access: 'user' } }, async (req) => {
    const body = parse(z.object({ mbid }), req.body);
    const open = ctx.db.select().from(albums).where(eq(albums.mbid, body.mbid)).get();
    if (open && open.status !== 'declined' && open.status !== 'failed') return open;
    const card = await upstream(() => musicBrainz(ctx).album(body.mbid));
    if (!card) throw badRequest('Could not find that album on MusicBrainz');
    const values = {
      title: card.title.slice(0, 500),
      artist: card.artist.slice(0, 300),
      artistMbid: card.artistMbid,
      year: card.year,
      type: card.type,
      status: 'pending' as const,
      requestedBy: req.user!.id,
      requestedByName: req.user!.displayName || req.user!.username,
      decidedByName: null,
      decidedAt: null,
      reason: null,
      error: null,
      createdAt: Date.now(),
    };
    const row = open ? ctx.db.update(albums).set(values).where(eq(albums.id, open.id)).returning().get() : ctx.db.insert(albums).values({ mbid: body.mbid, ...values }).returning().get();
    audit(ctx.db, req, 'album.requested', { target: `${row.artist} – ${row.title}` });
    notify(ctx, { event: 'request.created', title: 'New album request', message: `${values.requestedByName} requested ${row.artist} – ${row.title}`, data: { kind: 'album', mbid: row.mbid, albumId: row.id } });
    if (hasRole(req.user!.role, 'manager')) approve(row.id, req.user!.username, req.user!.id);
    return getAlbum(ctx, row.id);
  });

  const pending = (id: number) => {
    const a = getAlbum(ctx, id);
    if (!a) throw notFound('Request not found');
    if (a.status !== 'pending') throw conflict(`Request is already ${a.status}`);
    return a;
  };

  app.post('/api/music/:id/approve', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const a = pending(id);
    approve(id, req.user!.username, req.user!.id);
    audit(ctx.db, req, 'album.approved', { target: `${a.artist} – ${a.title}` });
    return getAlbum(ctx, id);
  });

  app.post('/api/music/:id/decline', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    const a = pending(id);
    ctx.db.update(albums).set({ status: 'declined', reason: reason ?? null, decidedByName: req.user!.username, decidedAt: Date.now() }).where(eq(albums.id, id)).run();
    audit(ctx.db, req, 'album.declined', { target: `${a.artist} – ${a.title}` });
    return { ok: true };
  });

  app.post('/api/music/:id/retry', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const a = getAlbum(ctx, id);
    if (!a) throw notFound('Request not found');
    if (!['approved', 'failed', 'downloading'].includes(a.status)) throw conflict(`Can't retry a request that is ${a.status}`);
    audit(ctx.db, req, 'album.retried', { target: `${a.artist} – ${a.title}` });
    return startAlbumDownload(ctx, id, req.user!.id);
  });

  app.delete('/api/music/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const a = getAlbum(ctx, id);
    if (!a) throw notFound('Request not found');
    if (!hasRole(req.user!.role, 'manager') && (a.requestedBy !== req.user!.id || a.status !== 'pending')) throw forbidden('You can only cancel your own pending requests');
    ctx.db.delete(albums).where(eq(albums.id, id)).run();
    audit(ctx.db, req, 'album.deleted', { target: `${a.artist} – ${a.title}` });
    return { ok: true };
  });

  app.get('/api/music/counts', { config: { access: 'manager' } }, async () => ({
    pending: ctx.db.$count(albums, eq(albums.status, 'pending')),
  }));

  // ---------------- Followed artists ----------------
  app.get('/api/music/artists', { config: { access: 'user' } }, async () => ctx.db.select({ id: musicArtists.id, mbid: musicArtists.mbid, name: musicArtists.name, addedAt: musicArtists.addedAt, checkedAt: musicArtists.checkedAt }).from(musicArtists).orderBy(musicArtists.name).all());

  /** Follows an artist: their new albums are requested and downloaded as they come out. */
  app.post('/api/music/artists', { config: { access: 'manager' } }, async (req) => {
    const body = parse(z.object({ mbid }), req.body);
    const existing = ctx.db.select().from(musicArtists).where(eq(musicArtists.mbid, body.mbid)).get();
    if (existing) return existing;
    const artist = await upstream(() => musicBrainz(ctx).artist(body.mbid));
    if (!artist) throw badRequest('Could not find that artist on MusicBrainz');
    const row = ctx.db.insert(musicArtists).values({ mbid: artist.mbid, name: artist.name.slice(0, 300), addedBy: req.user!.id, addedAt: Date.now() }).returning().get();
    audit(ctx.db, req, 'artist.followed', { target: artist.name });
    return row;
  });

  app.delete('/api/music/artists/:id', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const a = ctx.db.select().from(musicArtists).where(eq(musicArtists.id, id)).get();
    if (!a) throw notFound('Artist not found');
    ctx.db.delete(musicArtists).where(eq(musicArtists.id, id)).run();
    audit(ctx.db, req, 'artist.unfollowed', { target: a.name });
    return { ok: true };
  });
}
