import type { AppConfig } from './config.js';
import type { DatabaseHandle, Orm } from './db/database.js';
import type { LiveBus } from './live/bus.js';
import type { SettingsStore } from './settings/store.js';

/** Shared services, decorated onto the Fastify instance as `app.ctx`. */
export interface AppContext {
  config: AppConfig;
  /** Current database handle. Replaced in place when a backup is restored, so always read it fresh. */
  dbHandle: DatabaseHandle;
  readonly db: Orm;
  secretKey: Buffer;
  settings: SettingsStore;
  /** "Something changed" signals for open browser tabs (Server-Sent Events at /api/events). */
  live: LiveBus;
  /** Called after Cinemask changes media files (imports, moves, deletes); syncs the library shortly after. */
  onMediaChanged?: () => void;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
