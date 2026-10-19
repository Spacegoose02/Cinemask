import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit/log.js';
import { SESSION_COOKIE } from '../auth/sessions.js';
import { parse } from '../lib/validate.js';
import type { BackupService } from './service.js';

const nameParam = z.object({ name: z.string().max(200) });
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;

export async function backupRoutes(app: FastifyInstance, opts: { backups: BackupService; nextRun: () => Date | null }) {
  const { backups } = opts;

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD }, (_req, body, done) => done(null, body));

  app.get('/api/backups', { config: { access: 'admin' } }, async () => ({
    backups: backups.list(),
    status: backups.status,
    nextScheduled: opts.nextRun()?.getTime() ?? null,
  }));

  app.post('/api/backups', { config: { access: 'admin' } }, async (req) => {
    const info = await backups.create('manual');
    audit(app.ctx.db, req, 'backup.created', { target: info.name });
    return { backup: info, status: backups.status };
  });

  // Archives hold every account and the instance key, so only the owner can download or restore them.
  app.get('/api/backups/:name/download', { config: { access: 'owner' } }, async (req, reply) => {
    const { name } = parse(nameParam, req.params);
    const file = backups.pathFor(name);
    audit(app.ctx.db, req, 'backup.downloaded', { target: name });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(fs.createReadStream(file));
  });

  app.delete('/api/backups/:name', { config: { access: 'owner' } }, async (req) => {
    const { name } = parse(nameParam, req.params);
    backups.delete(name);
    audit(app.ctx.db, req, 'backup.deleted', { target: name });
    return { ok: true };
  });

  const afterRestore = (req: Parameters<typeof audit>[1], reply: { clearCookie: (n: string, o: object) => unknown }, source: string) => {
    // The restored database has its own sessions and users, so everyone signs in again.
    audit(app.ctx.db, req, 'backup.restored', { target: source, user: null });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, signedOut: true };
  };

  app.post('/api/backups/:name/restore', { config: { access: 'owner' } }, async (req, reply) => {
    const { name } = parse(nameParam, req.params);
    const { passphrase } = parse(z.object({ passphrase: z.string().max(500).optional() }), req.body ?? {});
    await backups.restore(fs.readFileSync(backups.pathFor(name)), passphrase);
    return afterRestore(req, reply, name);
  });

  app.post('/api/backups/upload-restore', { config: { access: 'owner' }, bodyLimit: MAX_UPLOAD }, async (req, reply) => {
    if (!Buffer.isBuffer(req.body)) return reply.code(415).send({ error: 'Send the backup file as application/octet-stream' });
    const passphrase = req.headers['x-backup-passphrase'];
    await backups.restore(req.body, typeof passphrase === 'string' ? passphrase : undefined);
    return afterRestore(req, reply, 'uploaded file');
  });
}
