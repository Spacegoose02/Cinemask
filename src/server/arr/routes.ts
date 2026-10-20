import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import { notify } from '../notify/service.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { hasRole } from '../auth/guard.js';
import { DOWNLOAD_CLIENT_TYPES, downloadClients, downloads, indexers, MEDIA_KINDS, monitored, monitoredEpisodes, qualityProfiles, requests, type DownloadClientType } from '../db/schema.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { availabilityFor, refreshMetadata } from '../library/service.js';
import { CLIENT_PROTOCOL, createClient } from './clients.js';
import { startDirectDownload } from './direct.js';
import { listProwlarrIndexers, testIndexer } from './indexers.js';
import { monitorTitle, upgradeCandidates, wantedTarget } from './monitor.js';
import { defaultProfileId, getProfile, listProfiles } from './profiles.js';
import { parseRelease } from './parser.js';
import { QUALITY_IDS } from './quality.js';
import { autoSearch, grab, rememberedRelease, searchMonitored } from './search.js';
import { openSecret, sealSecret } from './secrets.js';
import { failDownload, liveStats } from './tracker.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const kind = z.enum(MEDIA_KINDS);
const seasonsSchema = z.array(z.number().int().min(0).max(500)).max(200).nullable().optional();

export async function arrRoutes(app: FastifyInstance) {
  const ctx = app.ctx;
  const db = () => ctx.db;

  // ---------------- Requests ----------------
  app.get('/api/requests', { config: { access: 'user' } }, async (req) => {
    const q = parse(z.object({ status: z.enum(['pending', 'approved', 'declined', 'available', 'all']).default('all'), mine: z.coerce.boolean().default(false) }), req.query);
    // Users only ever see their own requests; managers see everyone's.
    const onlyMine = q.mine || !hasRole(req.user!.role, 'manager');
    return db()
      .select()
      .from(requests)
      .where(and(q.status === 'all' ? undefined : eq(requests.status, q.status), onlyMine ? eq(requests.requestedBy, req.user!.id) : undefined))
      .orderBy(desc(requests.createdAt))
      .limit(500)
      .all();
  });

  app.get('/api/requests/count', { config: { access: 'manager' } }, async () => ({ pending: db().select().from(requests).where(eq(requests.status, 'pending')).all().length }));

  const approve = async (requestId: number, profileId: number | undefined, deciderName: string, deciderId: number) => {
    const r = db().select().from(requests).where(eq(requests.id, requestId)).get();
    if (!r) throw notFound('Request not found');
    const profile = profileId ?? defaultProfileId(ctx, r.kind);
    if (!getProfile(ctx, profile)) throw badRequest('Unknown quality profile');
    const row = await monitorTitle(ctx, { kind: r.kind, tmdbId: r.tmdbId, profileId: profile, seasons: r.seasons ? (JSON.parse(r.seasons) as number[]) : null, addedBy: deciderId });
    db().update(requests).set({ status: 'approved', decidedByName: deciderName, decidedAt: Date.now(), monitoredId: row.id }).where(eq(requests.id, requestId)).run();
    void autoSearch(ctx, row).catch((err) => app.log.warn({ err }, 'Search after approval failed'));
    return row;
  };

  app.post('/api/requests', { config: { access: 'user' } }, async (req) => {
    const body = parse(z.object({ kind, tmdbId: z.number().int().positive(), seasons: seasonsSchema }), req.body);
    const meta = await refreshMetadata(ctx, body.kind, body.tmdbId);
    if (!meta) throw badRequest('Could not look up this title. Ask an admin to set a TMDB key.');
    const avail = availabilityFor(ctx, body.kind, [{ tmdbId: body.tmdbId, releaseDate: meta.releaseDate }]).get(body.tmdbId)!;
    if (avail.status === 'on_server' && body.kind === 'movie') throw conflict('This is already on the server');
    const open = db()
      .select()
      .from(requests)
      .where(and(eq(requests.kind, body.kind), eq(requests.tmdbId, body.tmdbId), inArray(requests.status, ['pending', 'approved'])))
      .get();
    if (open) return open;
    const created = db()
      .insert(requests)
      .values({
        kind: body.kind,
        tmdbId: body.tmdbId,
        title: meta.title,
        year: meta.year,
        posterPath: meta.posterPath,
        seasons: body.seasons ? JSON.stringify(body.seasons) : null,
        status: 'pending',
        requestedBy: req.user!.id,
        requestedByName: req.user!.displayName || req.user!.username,
        createdAt: Date.now(),
      })
      .returning()
      .get();
    audit(db(), req, 'request.created', { target: `${meta.title} (${meta.year ?? '?'})` });
    notify(ctx, { event: 'request.created', title: 'New request', message: `${created.requestedByName} requested ${meta.title}${meta.year ? ` (${meta.year})` : ''}`, data: { kind: body.kind, tmdbId: body.tmdbId, requestId: created.id } });
    // Managers and admins don't need anyone's approval.
    if (hasRole(req.user!.role, 'manager')) await approve(created.id, undefined, req.user!.username, req.user!.id);
    return db().select().from(requests).where(eq(requests.id, created.id)).get();
  });

  app.post('/api/requests/:id/approve', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { profileId } = parse(z.object({ profileId: z.number().int().positive().optional() }), req.body ?? {});
    const r = db().select().from(requests).where(eq(requests.id, id)).get();
    if (!r) throw notFound('Request not found');
    if (r.status !== 'pending') throw conflict(`Request is already ${r.status}`);
    await approve(id, profileId, req.user!.username, req.user!.id);
    audit(db(), req, 'request.approved', { target: r.title });
    return db().select().from(requests).where(eq(requests.id, id)).get();
  });

  app.post('/api/requests/:id/decline', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    const r = db().select().from(requests).where(eq(requests.id, id)).get();
    if (!r) throw notFound('Request not found');
    if (r.status !== 'pending') throw conflict(`Request is already ${r.status}`);
    db().update(requests).set({ status: 'declined', reason: reason ?? null, decidedByName: req.user!.username, decidedAt: Date.now() }).where(eq(requests.id, id)).run();
    audit(db(), req, 'request.declined', { target: r.title });
    return { ok: true };
  });

  app.delete('/api/requests/:id', { config: { access: 'user' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const r = db().select().from(requests).where(eq(requests.id, id)).get();
    if (!r) throw notFound('Request not found');
    const isManager = hasRole(req.user!.role, 'manager');
    if (!isManager && (r.requestedBy !== req.user!.id || r.status !== 'pending')) throw forbidden('You can only cancel your own pending requests');
    db().delete(requests).where(eq(requests.id, id)).run();
    audit(db(), req, 'request.deleted', { target: r.title });
    return { ok: true };
  });

  // ---------------- Monitored titles ----------------
  const getMonitored = (id: number) => {
    const r = db().select().from(monitored).where(eq(monitored.id, id)).get();
    if (!r) throw notFound('Not monitored');
    return r;
  };

  const monitoredView = (row: typeof monitored.$inferSelect) => {
    const target = wantedTarget(ctx, row);
    const eps = row.kind === 'show' ? db().select().from(monitoredEpisodes).where(eq(monitoredEpisodes.monitoredId, row.id)).orderBy(asc(monitoredEpisodes.season), asc(monitoredEpisodes.episode)).all() : [];
    return {
      ...row,
      seasons: row.seasons ? (JSON.parse(row.seasons) as number[]) : null,
      profile: getProfile(ctx, row.profileId),
      wanted: target ? (target.kind === 'movie' ? 1 : target.episodes!.length) : 0,
      episodes: eps,
    };
  };

  app.get('/api/monitored', { config: { access: 'manager' } }, async (req) => {
    const q = parse(z.object({ kind: kind.optional() }), req.query);
    return db()
      .select()
      .from(monitored)
      .where(q.kind ? eq(monitored.kind, q.kind) : undefined)
      .orderBy(asc(monitored.title))
      .all()
      .map((r) => ({ ...monitoredView(r), episodes: undefined }));
  });

  app.get('/api/monitored/lookup/:kind/:tmdbId', { config: { access: 'user' } }, async (req) => {
    const p = parse(z.object({ kind, tmdbId: z.coerce.number().int().positive() }), req.params);
    const row = db().select().from(monitored).where(and(eq(monitored.kind, p.kind), eq(monitored.tmdbId, p.tmdbId))).get();
    const request = db().select().from(requests).where(and(eq(requests.kind, p.kind), eq(requests.tmdbId, p.tmdbId), ne(requests.status, 'declined'))).orderBy(desc(requests.createdAt)).get();
    return { monitored: row && hasRole(req.user!.role, 'manager') ? monitoredView(row) : row ? { id: row.id, monitored: row.monitored } : null, request: request ?? null };
  });

  app.post('/api/monitored', { config: { access: 'manager' } }, async (req) => {
    const body = parse(z.object({ kind, tmdbId: z.number().int().positive(), profileId: z.number().int().positive().optional(), seasons: seasonsSchema, search: z.boolean().default(true) }), req.body);
    const profileId = body.profileId ?? defaultProfileId(ctx, body.kind);
    if (!getProfile(ctx, profileId)) throw badRequest('Unknown quality profile');
    const row = await monitorTitle(ctx, { kind: body.kind, tmdbId: body.tmdbId, profileId, seasons: body.seasons, addedBy: req.user!.id });
    audit(db(), req, 'monitored.added', { target: row.title });
    if (body.search) void autoSearch(ctx, row).catch((err) => app.log.warn({ err }, 'Search failed'));
    return monitoredView(row);
  });

  app.patch('/api/monitored/:id', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ profileId: z.number().int().positive().optional(), monitored: z.boolean().optional(), seasons: seasonsSchema }), req.body);
    const before = getMonitored(id);
    if (body.profileId && !getProfile(ctx, body.profileId)) throw badRequest('Unknown quality profile');
    db()
      .update(monitored)
      .set({
        ...(body.profileId ? { profileId: body.profileId } : {}),
        ...(body.monitored !== undefined ? { monitored: body.monitored } : {}),
        ...(body.seasons !== undefined ? { seasons: body.seasons ? JSON.stringify(body.seasons) : null } : {}),
      })
      .where(eq(monitored.id, id))
      .run();
    if (body.seasons !== undefined && before.kind === 'show') {
      for (const e of db().select().from(monitoredEpisodes).where(eq(monitoredEpisodes.monitoredId, id)).all()) {
        db().update(monitoredEpisodes).set({ monitored: !body.seasons || body.seasons.includes(e.season) }).where(eq(monitoredEpisodes.id, e.id)).run();
      }
    }
    const after = getMonitored(id);
    audit(db(), req, 'monitored.updated', { target: after.title, details: body });
    // A new profile can make existing files eligible for an upgrade; the UI asks before searching.
    const upgrades = body.profileId && body.profileId !== before.profileId ? upgradeCandidates(ctx, after) : 0;
    return { ...monitoredView(after), upgradeCandidates: upgrades };
  });

  app.delete('/api/monitored/:id', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const row = getMonitored(id);
    db().delete(monitored).where(eq(monitored.id, id)).run();
    audit(db(), req, 'monitored.removed', { target: row.title });
    return { ok: true };
  });

  app.post('/api/monitored/:id/search', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const f = parse(z.object({ season: z.number().int().min(0).optional(), episode: z.number().int().min(0).optional() }), req.body ?? {});
    const row = getMonitored(id);
    const grabbed = await autoSearch(ctx, { ...row, monitored: true }, f);
    audit(db(), req, 'monitored.searched', { target: row.title, details: { grabbed } });
    return { grabbed };
  });

  /** Manual (interactive) search: every release found, with why each would or wouldn't be grabbed. */
  app.get('/api/monitored/:id/releases', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const f = parse(z.object({ season: z.coerce.number().int().min(0).optional(), episode: z.coerce.number().int().min(0).optional() }), req.query);
    const row = getMonitored(id);
    const { decisions, errors } = await searchMonitored(ctx, row, f);
    return {
      errors,
      releases: decisions.map((d) => ({
        guid: d.release.guid,
        title: d.release.title,
        indexer: d.release.indexer,
        protocol: d.release.protocol,
        size: d.release.size,
        seeders: d.release.seeders,
        publishedAt: d.release.publishedAt,
        quality: d.parsed.quality,
        languages: d.parsed.languages,
        accepted: d.accepted,
        rejections: d.rejections,
        covers: d.covers,
      })),
    };
  });

  app.post('/api/monitored/:id/grab', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { guid } = parse(z.object({ guid: z.string().min(1).max(2000) }), req.body);
    const row = getMonitored(id);
    // Only releases returned by our own indexer search can be grabbed; never an arbitrary URL.
    const hit = rememberedRelease(id, guid);
    if (!hit) throw badRequest('That search result expired. Search again.');
    const { release, covers } = hit;
    const parsed = parseRelease(release.title);
    if (row.kind === 'show' && !covers?.episodes.length) throw badRequest("Can't tell which episodes this release has, so it couldn't be imported");
    try {
      const dlId = await grab(ctx, release, row, { covers, userId: req.user!.id, quality: parsed.quality });
      audit(db(), req, 'release.grabbed', { target: release.title, details: { indexer: release.indexer } });
      return { downloadId: dlId };
    } catch (err) {
      throw new HttpError(502, (err as Error).message, 'upstream');
    }
  });

  // ---------------- Downloads ----------------
  app.get('/api/downloads', { config: { access: 'manager' } }, async (req) => {
    const q = parse(z.object({ history: z.coerce.boolean().default(false) }), req.query);
    const active = ['queued', 'downloading', 'paused', 'completed', 'importing'] as const;
    return db()
      .select()
      .from(downloads)
      .where(q.history ? undefined : inArray(downloads.status, [...active]))
      .orderBy(desc(downloads.addedAt))
      .limit(300)
      .all()
      .map((d) => ({ ...d, sourceUrl: undefined, speed: liveStats.get(d.id)?.speed ?? null, eta: liveStats.get(d.id)?.eta ?? null }));
  });

  app.get('/api/downloads/count', { config: { access: 'manager' } }, async () => ({
    active: db().select().from(downloads).where(inArray(downloads.status, ['queued', 'downloading', 'paused', 'importing'])).all().length,
  }));

  app.delete('/api/downloads/:id', { config: { access: 'manager' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(z.object({ removeFromClient: z.coerce.boolean().default(true), blocklist: z.coerce.boolean().default(false) }), req.query);
    const d = db().select().from(downloads).where(eq(downloads.id, id)).get();
    if (!d) throw notFound();
    if (q.removeFromClient && d.clientId && d.downloadId) {
      const c = db().select().from(downloadClients).where(eq(downloadClients.id, d.clientId)).get();
      if (c) {
        await createClient({ type: c.type as DownloadClientType, name: c.name, url: c.url, username: c.username, password: openSecret(ctx, c.password) })
          .remove(d.downloadId, true)
          .catch(() => undefined);
      }
    }
    if (q.blocklist) await failDownload(ctx, id, 'Removed and blocklisted by a manager', true);
    db().update(downloads).set({ status: 'removed' }).where(eq(downloads.id, id)).run();
    audit(db(), req, 'download.removed', { target: d.title, details: q });
    return { ok: true };
  });

  app.post('/api/downloads/direct', { config: { access: 'manager', rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { url } = parse(z.object({ url: z.url().max(4000) }), req.body);
    try {
      const id = await startDirectDownload(ctx, url, req.user!.id);
      audit(db(), req, 'download.direct', { target: new URL(url).host });
      return { id };
    } catch (err) {
      throw badRequest((err as Error).message);
    }
  });

  // ---------------- Quality profiles ----------------
  const profileBody = z.object({
    name: z.string().trim().min(1).max(60),
    qualities: z.array(z.enum(QUALITY_IDS)).min(1),
    cutoff: z.enum(QUALITY_IDS),
    upgradesAllowed: z.boolean().default(true),
    language: z.string().trim().regex(/^(any|multi|[a-z]{2})$/).default('any'),
  });

  app.get('/api/profiles', { config: { access: 'user' } }, async () => listProfiles(ctx));

  app.post('/api/profiles', { config: { access: 'admin' } }, async (req) => {
    const b = parse(profileBody, req.body);
    if (!b.qualities.includes(b.cutoff)) throw badRequest('The cutoff must be one of the allowed qualities');
    const r = db().insert(qualityProfiles).values({ ...b, qualities: JSON.stringify(b.qualities), createdAt: Date.now() }).returning().get();
    audit(db(), req, 'profile.created', { target: b.name });
    return getProfile(ctx, r.id);
  });

  app.put('/api/profiles/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(profileBody, req.body);
    if (!b.qualities.includes(b.cutoff)) throw badRequest('The cutoff must be one of the allowed qualities');
    if (!getProfile(ctx, id)) throw notFound();
    db().update(qualityProfiles).set({ ...b, qualities: JSON.stringify(b.qualities) }).where(eq(qualityProfiles.id, id)).run();
    audit(db(), req, 'profile.updated', { target: b.name });
    return getProfile(ctx, id);
  });

  app.delete('/api/profiles/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    if (db().select().from(monitored).where(eq(monitored.profileId, id)).get()) throw conflict('Profile is in use by monitored titles');
    db().delete(qualityProfiles).where(eq(qualityProfiles.id, id)).run();
    audit(db(), req, 'profile.deleted', { target: String(id) });
    return { ok: true };
  });

  // ---------------- Indexers ----------------
  const indexerView = (i: typeof indexers.$inferSelect) => ({ ...i, apiKey: undefined, hasApiKey: Boolean(i.apiKey), categories: JSON.parse(i.categories) as number[] });
  const indexerBody = z.object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(['newznab', 'torznab']),
    url: z.url({ protocol: /^https?$/ }).max(1000),
    apiKey: z.string().max(500).nullable().optional(),
    categories: z.array(z.number().int().min(1000).max(9999)).max(50).default([]),
    enabled: z.boolean().default(true),
    priority: z.number().int().min(1).max(50).default(25),
  });

  app.get('/api/indexers', { config: { access: 'admin' } }, async () => db().select().from(indexers).orderBy(asc(indexers.priority), asc(indexers.name)).all().map(indexerView));

  app.post('/api/indexers', { config: { access: 'admin' } }, async (req) => {
    const b = parse(indexerBody, req.body);
    const r = db().insert(indexers).values({ ...b, apiKey: sealSecret(ctx, b.apiKey), categories: JSON.stringify(b.categories) }).returning().get();
    audit(db(), req, 'indexer.created', { target: b.name });
    return indexerView(r);
  });

  app.put('/api/indexers/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(indexerBody, req.body);
    const cur = db().select().from(indexers).where(eq(indexers.id, id)).get();
    if (!cur) throw notFound();
    db()
      .update(indexers)
      .set({ ...b, apiKey: b.apiKey === undefined ? cur.apiKey : sealSecret(ctx, b.apiKey), categories: JSON.stringify(b.categories) })
      .where(eq(indexers.id, id))
      .run();
    audit(db(), req, 'indexer.updated', { target: b.name });
    return indexerView(db().select().from(indexers).where(eq(indexers.id, id)).get()!);
  });

  app.delete('/api/indexers/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    db().delete(indexers).where(eq(indexers.id, id)).run();
    audit(db(), req, 'indexer.deleted', { target: String(id) });
    return { ok: true };
  });

  app.post('/api/indexers/:id/test', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const i = db().select().from(indexers).where(eq(indexers.id, id)).get();
    if (!i) throw notFound();
    try {
      const n = await testIndexer({ id: i.id, name: i.name, type: i.type, url: i.url, apiKey: openSecret(ctx, i.apiKey), categories: JSON.parse(i.categories) as number[] });
      return { ok: true, message: `${i.name} works (${n} recent releases)` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });

  /** Adds or updates one entry per Prowlarr indexer, searched through Prowlarr's proxy. */
  app.post('/api/indexers/prowlarr-sync', { config: { access: 'admin' } }, async (req) => {
    const p = ctx.settings.get('prowlarr');
    if (!p.url || !p.apiKey) throw badRequest('Set the Prowlarr URL and API key first');
    let list;
    try {
      list = await listProwlarrIndexers(p.url, p.apiKey);
    } catch (err) {
      throw new HttpError(502, (err as Error).message, 'upstream');
    }
    let added = 0;
    for (const pi of list) {
      const values = {
        name: `${pi.name} (Prowlarr)`,
        type: pi.protocol === 'torrent' ? ('torznab' as const) : ('newznab' as const),
        url: `${p.url.replace(/\/+$/, '')}/${pi.id}/api`,
        apiKey: sealSecret(ctx, p.apiKey),
        enabled: pi.enable,
        source: 'prowlarr' as const,
        prowlarrId: pi.id,
      };
      const existing = db().select().from(indexers).where(eq(indexers.prowlarrId, pi.id)).get();
      if (existing) db().update(indexers).set(values).where(eq(indexers.id, existing.id)).run();
      else {
        db().insert(indexers).values({ ...values, categories: '[]' }).run();
        added++;
      }
    }
    // Indexers removed from Prowlarr are removed here too.
    const ids = list.map((x) => x.id);
    for (const old of db().select().from(indexers).where(eq(indexers.source, 'prowlarr')).all()) {
      if (old.prowlarrId !== null && !ids.includes(old.prowlarrId)) db().delete(indexers).where(eq(indexers.id, old.id)).run();
    }
    audit(db(), req, 'indexer.prowlarr_synced', { details: { total: list.length, added } });
    return { total: list.length, added };
  });

  // ---------------- Download clients ----------------
  const clientView = (c: typeof downloadClients.$inferSelect) => ({ ...c, password: undefined, hasPassword: Boolean(c.password) });
  const clientBody = z.object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(DOWNLOAD_CLIENT_TYPES),
    url: z.url({ protocol: /^https?$/ }).max(1000),
    username: z.string().max(200).nullable().optional(),
    password: z.string().max(500).nullable().optional(),
    category: z.string().trim().min(1).max(100).regex(/^[\w.-]+$/).default('cinemask'),
    enabled: z.boolean().default(true),
    priority: z.number().int().min(1).max(50).default(1),
  });

  app.get('/api/download-clients', { config: { access: 'admin' } }, async () => db().select().from(downloadClients).orderBy(asc(downloadClients.priority)).all().map(clientView));

  app.post('/api/download-clients', { config: { access: 'admin' } }, async (req) => {
    const b = parse(clientBody, req.body);
    const r = db()
      .insert(downloadClients)
      .values({ ...b, username: b.username ?? null, password: sealSecret(ctx, b.password), protocol: CLIENT_PROTOCOL[b.type] })
      .returning()
      .get();
    audit(db(), req, 'download_client.created', { target: b.name });
    return clientView(r);
  });

  app.put('/api/download-clients/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(clientBody, req.body);
    const cur = db().select().from(downloadClients).where(eq(downloadClients.id, id)).get();
    if (!cur) throw notFound();
    db()
      .update(downloadClients)
      .set({ ...b, username: b.username ?? null, password: b.password === undefined ? cur.password : sealSecret(ctx, b.password), protocol: CLIENT_PROTOCOL[b.type] })
      .where(eq(downloadClients.id, id))
      .run();
    audit(db(), req, 'download_client.updated', { target: b.name });
    return clientView(db().select().from(downloadClients).where(eq(downloadClients.id, id)).get()!);
  });

  app.delete('/api/download-clients/:id', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    db().delete(downloadClients).where(eq(downloadClients.id, id)).run();
    audit(db(), req, 'download_client.deleted', { target: String(id) });
    return { ok: true };
  });

  app.post('/api/download-clients/:id/test', { config: { access: 'admin' } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const c = db().select().from(downloadClients).where(eq(downloadClients.id, id)).get();
    if (!c) throw notFound();
    try {
      const message = await createClient({ type: c.type as DownloadClientType, name: c.name, url: c.url, username: c.username, password: openSecret(ctx, c.password) }).test();
      return { ok: true, message };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  });
}
