import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';

import { ALL_STRATEGIES, fromBase64, toBase64 } from '../../packages/sync-core/src/index.ts';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/log.js';
import { createSyncService } from '../src/syncService.js';
import { SyncStore } from '../src/syncStore.js';

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const NETFLIX = {
  name: 'Netflix',
  amountCents: 4999,
  currency: 'RON',
  billingCycle: 'MONTHLY',
  nextPaymentDate: '2026-12-01',
  category: 'Streaming',
  isActive: true,
  notes: '',
};

/** A clock set by hand and deterministic ids, as in the sync-core tests. */
function manualEnv(prefix, start = 1_000) {
  let t = start;
  let ids = 0;
  return { env: { now: () => t, newId: () => `${prefix}-${++ids}` }, tick: (ms = 1) => (t += ms) };
}

/** Starts the server on a random port with the given database file. */
async function startServer({ strategy, dbFile, allowReset = false }) {
  const syncStore = new SyncStore(dbFile);
  const sync = createSyncService({ store: syncStore, strategyName: strategy, env: manualEnv('server').env });
  const legacy = { all: () => [] };
  const app = createApp({ store: legacy, logger: createLogger({ silent: true }), sync, allowReset });
  const { port } = await app.listen(0, '127.0.0.1');
  return {
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await app.close();
      syncStore.close();
    },
  };
}

const post = (base, path, body) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * The client side of the protocol: send the next message (or null) and apply the answer, until the
 * client has nothing to send and the server answers null. Returns the number of requests.
 */
async function syncOverHttp(base, strategy, replica) {
  for (let requests = 1; requests <= 50; requests++) {
    const out = replica.syncMessage('server');
    const response = await post(base, '/sync', {
      strategy,
      replicaId: replica.replicaId,
      message: out ? toBase64(out) : null,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const reply = await response.json();
    assert.equal(reply.strategy, strategy);
    if (reply.message) replica.receive('server', fromBase64(reply.message));
    if (!out && !reply.message) return requests;
  }
  throw new Error('HTTP sync did not quiesce');
}

const getState = async (base) => (await fetch(`${base}/state`)).json();

describe('POST /sync', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'subtrack-sync-http-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const strategy of ALL_STRATEGIES) {
    describe(strategy.name, () => {
      it('two clients converge through the server, also after concurrent edits', async () => {
        const server = await startServer({ strategy: strategy.name, dbFile: join(dir, `${strategy.name}-a.db`) });
        try {
          const c1 = strategy.create('c1', manualEnv('c1').env);
          const c2 = strategy.create('c2', manualEnv('c2').env);
          c1.apply({ kind: 'create', id: ID_A, fields: NETFLIX });
          c2.apply({ kind: 'create', id: ID_B, fields: { ...NETFLIX, name: 'Spotify', amountCents: 2499 } });
          await syncOverHttp(server.base, strategy.name, c1);
          await syncOverHttp(server.base, strategy.name, c2);
          await syncOverHttp(server.base, strategy.name, c1);
          assert.deepEqual(c1.read().map((d) => d.id), [ID_A, ID_B]);

          // Offline edits on both clients: different fields of A, and the same field of B.
          c1.apply({ kind: 'setField', id: ID_A, field: 'amountCents', value: 5999 });
          c2.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'family plan' });
          c1.apply({ kind: 'setField', id: ID_B, field: 'name', value: 'Spotify Duo' });
          c2.apply({ kind: 'setField', id: ID_B, field: 'name', value: 'Spotify Family' });
          c2.apply({ kind: 'addTag', id: ID_A, tag: 'video' });
          for (let i = 0; i < 2; i++) {
            await syncOverHttp(server.base, strategy.name, c1);
            await syncOverHttp(server.base, strategy.name, c2);
          }

          const state = await getState(server.base);
          assert.equal(state.strategy, strategy.name);
          assert.deepEqual(c1.read(), c2.read());
          assert.deepEqual(c1.conflicts(), c2.conflicts());
          assert.deepEqual(state.docs, c1.read());
          assert.deepEqual(state.conflicts, c1.conflicts());
          const a = state.docs.find((d) => d.id === ID_A);
          assert.deepEqual(a.tags, ['video']);
          if (strategy.name !== 'lww') {
            // Only LWW loses a whole-record edit; the others merge edits of different fields.
            assert.equal(a.amountCents, 5999);
            assert.equal(a.notes, 'family plan');
          }
          // Already in sync: one request, nothing to send either way.
          assert.equal(await syncOverHttp(server.base, strategy.name, c1), 1);
        } finally {
          await server.stop();
        }
      });

      it('keeps the server replica across a restart', async () => {
        const dbFile = join(dir, `${strategy.name}-b.db`);
        const c1 = strategy.create('c1', manualEnv('c1').env);
        c1.apply({ kind: 'create', id: ID_A, fields: NETFLIX });

        const first = await startServer({ strategy: strategy.name, dbFile });
        await syncOverHttp(first.base, strategy.name, c1);
        const before = await getState(first.base);
        await first.stop();

        const second = await startServer({ strategy: strategy.name, dbFile });
        try {
          assert.deepEqual(await getState(second.base), before);
          assert.equal(before.docs.length, 1);
          // A new client gets the record from the restarted server; the old one has nothing new to exchange.
          const c2 = strategy.create('c2', manualEnv('c2').env);
          await syncOverHttp(second.base, strategy.name, c2);
          assert.deepEqual(c2.read(), c1.read());
          // The old client has nothing new to exchange. Automerge re-announces its heads once after the
          // server reloaded its sync state (one extra request, no changes); after that it is quiet too.
          const docs = c1.read();
          assert.ok((await syncOverHttp(second.base, strategy.name, c1)) <= 2);
          assert.deepEqual(c1.read(), docs);
          assert.equal(await syncOverHttp(second.base, strategy.name, c1), 1);
        } finally {
          await second.stop();
        }
      });
    });
  }

  describe('protocol', () => {
    let server;
    before(async () => {
      server = await startServer({ strategy: 'lww', dbFile: join(dir, 'protocol.db'), allowReset: true });
    });
    after(async () => {
      await server.stop();
    });

    it('answers 409 to a client that runs another strategy', async () => {
      const response = await post(server.base, '/sync', { strategy: 'automerge', replicaId: 'c1', message: null });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'WRONG_STRATEGY');
    });

    it('rejects bad replica ids and messages with 400', async () => {
      for (const body of [
        { strategy: 'lww', replicaId: 'server', message: null },
        { strategy: 'lww', replicaId: '', message: null },
        { strategy: 'lww', replicaId: 'c1', message: 42 },
        { strategy: 'lww', replicaId: 'c1', message: 'not base64!' },
        { strategy: 'lww', replicaId: 'c1', message: toBase64(new TextEncoder().encode('{"garbage":true}')) },
      ]) {
        const response = await post(server.base, '/sync', body);
        assert.equal(response.status, 400, JSON.stringify(body));
      }
      // The server replica is still usable afterwards.
      assert.equal((await post(server.base, '/sync', { strategy: 'lww', replicaId: 'c1', message: null })).status, 200);
    });

    it('announces changes on the WebSocket, with the client as origin', async () => {
      const socket = new WebSocket(`${server.base.replace('http', 'ws')}/ws`);
      const messages = [];
      socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
      await new Promise((resolve, reject) => socket.on('open', resolve).on('error', reject));
      try {
        const c1 = ALL_STRATEGIES[0].create('c1', manualEnv('c1').env);
        c1.apply({ kind: 'create', id: ID_A, fields: NETFLIX });
        await syncOverHttp(server.base, 'lww', c1);
        await syncOverHttp(server.base, 'lww', c1); // nothing new: no second announcement
        for (let i = 0; i < 100 && messages.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(messages, [{ type: 'changed', origin: 'c1' }]);
      } finally {
        socket.terminate();
      }
    });

    it('resets the server replica only when allowed', async () => {
      assert.equal((await getState(server.base)).docs.length, 1);
      assert.equal((await post(server.base, '/admin/reset', {})).status, 204);
      assert.deepEqual(await getState(server.base), { strategy: 'lww', docs: [], conflicts: [] });

      const locked = await startServer({ strategy: 'lww', dbFile: join(dir, 'locked.db') });
      try {
        assert.equal((await post(locked.base, '/admin/reset', {})).status, 403);
      } finally {
        await locked.stop();
      }
    });
  });
});
