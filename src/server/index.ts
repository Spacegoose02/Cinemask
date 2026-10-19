import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, scheduler } = await buildApp(config);
scheduler.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`Received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
