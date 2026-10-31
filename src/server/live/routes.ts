import type { FastifyInstance } from 'fastify';
import type { Socket } from 'node:net';
import { hasRole } from '../auth/guard.js';
import { topicForRoute, type LiveEvent } from './bus.js';

/** How often a comment line is sent so proxies don't close an idle stream. */
const HEARTBEAT_MS = 25_000;
/**
 * Streams are closed after this long and the browser reconnects on its own. The reconnect goes
 * through the access guard again, so a signed-out, disabled or demoted user stops hearing events.
 */
const MAX_STREAM_MS = 5 * 60_000;

/**
 * Live updates over Server-Sent Events. Called on the root instance (not registered as a plugin)
 * so the onResponse hook sees every route.
 */
export function registerLive(app: FastifyInstance, opts: { maxStreamMs?: number } = {}) {
  const bus = app.ctx.live;
  const sockets = new Set<Socket>();

  // A successful write tells other tabs that whatever it touched has changed.
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    if (reply.statusCode >= 400) return;
    const access = req.routeOptions.config?.access;
    const url = req.routeOptions.url;
    if (!access || access === 'public' || !url) return;
    const topic = topicForRoute(url);
    if (topic) bus.publish({ topic, access });
  });

  // Streams never finish on their own, so drop their connections before the server waits for
  // its connections to finish.
  app.addHook('preClose', async () => {
    for (const socket of sockets) socket.destroy();
  });

  app.get('/api/events', { config: { access: 'user', apiKey: false } }, (req, reply) => {
    const user = req.user!;
    const canHear = (e: LiveEvent) => (e.access === 'owner' ? user.isOwner : hasRole(user.role, e.access));

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      // Stop nginx and friends from buffering the stream.
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\nevent: ready\ndata: {}\n\n');
    const socket = req.raw.socket;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));

    const unsubscribe = bus.subscribe((e) => {
      if (canHear(e)) res.write(`data: ${JSON.stringify({ topic: e.topic })}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const expiry = setTimeout(() => res.end(), opts.maxStreamMs ?? MAX_STREAM_MS);
    heartbeat.unref();
    expiry.unref();

    res.on('close', () => {
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(expiry);
    });
  });
}
