import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { createLogger } from './log.js';
import { sampleData } from './sampleData.js';
import { SubscriptionStore } from './store.js';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'subscriptions.json');
/** Artificial latency per request, to show the app's progress indicators in a demo. */
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);

const logger = createLogger();
const store = new SubscriptionStore(DATA_FILE);
const seeded = await store.open(sampleData(new Date()));
logger.info(`Data file ${DATA_FILE} (${store.all().length} subscriptions${seeded ? ', seeded with demo data' : ''})`);

const app = createApp({ store, logger, delayMs: DELAY_MS });
await app.listen(PORT, HOST);

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4')
  .map((a) => `http://${a.address}:${PORT}`);
logger.info(`SubTrack server listening on ${addresses.join(', ')} (WebSocket at /ws)`);

const shutdown = async (signal) => {
  logger.info(`${signal} received, shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
