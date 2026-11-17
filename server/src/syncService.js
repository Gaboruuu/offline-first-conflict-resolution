import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { fromBase64, getStrategy, stableStringify, toBase64 } from '../../packages/sync-core/src/index.ts';

export const SERVER_REPLICA_ID = 'server';

const REPLICA_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Rejections the HTTP layer turns into error responses. */
export class SyncError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = undefined;
  }
}

/** The real clock and UUIDs; tests and the simulator inject their own. */
export const systemEnv = { now: () => Date.now(), newId: () => randomUUID() };

/**
 * The server replica of one strategy (Shared design: star topology, the server is itself a replica).
 * Every request is one round of the generic session loop: receive the client's message, if any, then
 * answer with the server's next message for that client. The state is persisted after every request
 * that changed it, so a restart resumes exactly where the last request left off.
 */
export function createSyncService({ store, strategyName = 'lww', env = systemEnv }) {
  const strategy = getStrategy(strategyName);
  let replica = loadReplica();
  let persisted = replica.save();
  if (store.loadState(strategy.name) === null) store.saveState(strategy.name, persisted);

  function loadReplica() {
    const saved = store.loadState(strategy.name);
    return saved ? strategy.load(saved, env) : strategy.create(SERVER_REPLICA_ID, env);
  }

  const visible = () => stableStringify({ docs: replica.read(), conflicts: replica.conflicts() });

  function persist() {
    const bytes = replica.save();
    if (bytes.length === persisted.length && bytes.every((b, i) => b === persisted[i])) return;
    store.saveState(strategy.name, bytes);
    persisted = bytes;
  }

  function parseRequest(body) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new SyncError(400, 'BAD_REQUEST', 'Body must be { strategy, replicaId, message }');
    }
    const { strategy: requested, replicaId, message } = body;
    if (typeof replicaId !== 'string' || !REPLICA_ID.test(replicaId) || replicaId === SERVER_REPLICA_ID) {
      throw new SyncError(400, 'BAD_REPLICA_ID', 'replicaId must be 1-128 characters [A-Za-z0-9._:-] and not "server"');
    }
    if (requested !== strategy.name) {
      throw new SyncError(409, 'WRONG_STRATEGY', `This server runs strategy "${strategy.name}", not "${requested}"`);
    }
    if (message !== null && message !== undefined && typeof message !== 'string') {
      throw new SyncError(400, 'BAD_MESSAGE', 'message must be a base64 string or null');
    }
    let bytes = null;
    if (typeof message === 'string') {
      try {
        bytes = fromBase64(message);
      } catch {
        throw new SyncError(400, 'BAD_MESSAGE', 'message is not valid base64');
      }
    }
    return { replicaId, bytes };
  }

  return {
    strategy: strategy.name,

    /**
     * One round: `{ strategy, replicaId, message }` → `{ reply: { message, strategy }, changed, log }`.
     * `changed` is true when the visible data (records or conflicts) changed, which is what the
     * WebSocket announces to the other clients.
     */
    sync(body) {
      const { replicaId, bytes } = parseRequest(body);
      const before = bytes ? visible() : null;
      const started = performance.now();
      let out;
      try {
        if (bytes) replica.receive(replicaId, bytes);
        out = replica.syncMessage(replicaId);
      } catch (error) {
        // A message the strategy cannot decode may have left the replica half-updated: start again from disk.
        replica = loadReplica();
        persisted = replica.save();
        throw new SyncError(400, 'BAD_MESSAGE', `The ${strategy.name} replica rejected the message: ${error.message}`);
      }
      const cpuMs = performance.now() - started;
      persist();
      const log = {
        strategy: strategy.name,
        peer: replicaId,
        bytesIn: bytes ? bytes.length : 0,
        bytesOut: out ? out.length : 0,
        rounds: (bytes ? 1 : 0) + (out ? 1 : 0),
        cpuMs,
      };
      store.logSync(log);
      return {
        reply: { message: out ? toBase64(out) : null, strategy: strategy.name },
        changed: bytes !== null && visible() !== before,
        log,
      };
    },

    state() {
      return { strategy: strategy.name, docs: replica.read(), conflicts: replica.conflicts() };
    },

    /** Wipes the replica and its sync log (experiments only; guarded by ALLOW_RESET in the HTTP layer). */
    reset() {
      store.reset(strategy.name);
      replica = strategy.create(SERVER_REPLICA_ID, env);
      persisted = replica.save();
      store.saveState(strategy.name, persisted);
    },
  };
}
