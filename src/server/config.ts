import path from 'node:path';

export interface AppConfig {
  /** Directory holding the database, secret key and local backups. Mounted as /config in Docker. */
  configDir: string;
  host: string;
  port: number;
  /** Trust X-Forwarded-* headers. Enable only when running behind a reverse proxy you control. */
  trustProxy: boolean;
  /** Directory of the built web UI, served as static files. Unset in development. */
  webDir?: string;
  logLevel: string;
  version: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    configDir: path.resolve(env.CONFIG_DIR ?? './config'),
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 7979),
    trustProxy: env.TRUST_PROXY === 'true',
    webDir: env.WEB_DIR,
    logLevel: env.LOG_LEVEL ?? 'info',
    version: env.APP_VERSION ?? '0.1.0',
  };
}
