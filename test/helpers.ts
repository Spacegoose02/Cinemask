import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp, type BuiltApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';

export const OWNER = { username: 'owner', password: 'correct-horse-battery' };

export async function makeApp(): Promise<BuiltApp & { dir: string; close: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-test-'));
  const built = await buildApp({ ...loadConfig({}), configDir: dir }, { logger: false });
  return {
    ...built,
    dir,
    close: async () => {
      await built.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A browser-like client: keeps the session cookie and sends the CSRF headers the UI sends. */
export class Client {
  cookie = '';
  csrf = '';

  constructor(private readonly app: FastifyInstance) {}

  async req(method: InjectOptions['method'], url: string, body?: unknown, extra: Partial<InjectOptions> = {}) {
    const res = await this.app.inject({
      method,
      url,
      payload: body as InjectOptions['payload'],
      ...extra,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        'x-requested-with': 'fetch',
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...(extra.headers ?? {}),
      },
    });
    const set = res.cookies.find((c) => c.name === 'mm_session');
    if (set) this.cookie = set.value ? `mm_session=${set.value}` : '';
    return res;
  }

  async refreshCsrf() {
    const res = await this.req('GET', '/api/auth/me');
    this.csrf = res.statusCode === 200 ? (res.json() as { csrfToken: string }).csrfToken : '';
    return res;
  }

  async login(username: string, password: string) {
    this.csrf = '';
    const res = await this.req('POST', '/api/auth/login', { username, password });
    await this.refreshCsrf();
    return res;
  }
}

export async function setupOwner(app: FastifyInstance): Promise<Client> {
  const c = new Client(app);
  const res = await c.req('POST', '/api/setup', OWNER);
  if (res.statusCode !== 200) throw new Error(res.body);
  await c.refreshCsrf();
  return c;
}

export async function createUser(owner: Client, username: string, role: 'user' | 'manager' | 'admin') {
  const password = `pw-${[...username].reverse().join("")}-long-password-1`;
  const res = await owner.req('POST', '/api/users', { username, password, role });
  if (res.statusCode !== 200) throw new Error(res.body);
  return { password, id: (res.json() as { id: number }).id };
}
