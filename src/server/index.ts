import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, scheduler } = await buildApp(config);
scheduler.start();

// A failed promise nobody waited for (a background search, a webhook, a media server refresh) is
// logged rather than ending the process, which would take the whole app down for everyone.
process.on('unhandledRejection', (err) => {
  app.log.error({ err }, 'Unhandled promise rejection in background work');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info(`Received ${signal}, shutting down`);
    void app.close().then(() => process.exit(0));
  });
}

await app.listen({ host: config.host, port: config.port });
