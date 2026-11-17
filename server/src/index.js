import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.js';
import { createLogger } from './log.js';
import { sampleData } from './sampleData.js';
import { SubscriptionStore } from './store.js';
import { createSyncService } from './syncService.js';
import { SyncStore } from './syncStore.js';
import { isStrategyName } from '../../packages/sync-core/src/index.ts';

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const DATA_FILE = process.env.DATA_FILE ?? join(DATA_DIR, 'subscriptions.json');
/** SQLite database of the sync endpoint: replica state and per-request sync metrics. */
const DB_FILE = process.env.DB_FILE ?? join(DATA_DIR, 'subtrack.db');
/** Conflict-resolution strategy of the server replica: lww (default), vv, automerge or yjs. */
const STRATEGY = process.env.STRATEGY ?? 'lww';
/** POST /admin/reset is refused unless ALLOW_RESET=1 (the experiments use it). */
const ALLOW_RESET = process.env.ALLOW_RESET === '1';
/** Artificial latency per request, to show the app's progress indicators in a demo. */
const DELAY_MS = Number(process.env.DELAY_MS ?? 0);

const logger = createLogger();
const store = new SubscriptionStore(DATA_FILE);
const seeded = await store.open(sampleData(new Date()));
logger.info(`Data file ${DATA_FILE} (${store.all().length} subscriptions${seeded ? ', seeded with demo data' : ''})`);

if (!isStrategyName(STRATEGY)) {
  logger.error(`Unknown STRATEGY "${STRATEGY}"; expected lww, vv, automerge or yjs`);
  process.exit(1);
}
const syncStore = new SyncStore(DB_FILE);
const sync = createSyncService({ store: syncStore, strategyName: STRATEGY });
logger.info(`Sync strategy ${STRATEGY}, database ${DB_FILE} (${sync.state().docs.length} records)${ALLOW_RESET ? ', reset allowed' : ''}`);

const app = createApp({ store, logger, delayMs: DELAY_MS, sync, allowReset: ALLOW_RESET });
await app.listen(PORT, HOST);

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4')
  .map((a) => `http://${a.address}:${PORT}`);
logger.info(`SubTrack server listening on ${addresses.join(', ')} (WebSocket at /ws)`);

const shutdown = async (signal) => {
  logger.info(`${signal} received, shutting down`);
  await app.close();
  syncStore.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
