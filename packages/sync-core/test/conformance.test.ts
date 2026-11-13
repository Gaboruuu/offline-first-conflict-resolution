/**
 * Conformance suite: the four contract properties of the Shared design, checked for every registered
 * strategy on random op sequences over three clients and a server (fast-check, fixed seed).
 *
 * - Quiescence: after a session, both sides have nothing to send until a new apply.
 * - Convergence: after every client completed two sessions with the server, with no new ops, all replicas
 *   return deep-equal read() and conflicts().
 * - Idempotence: receiving the same message twice changes nothing.
 * - Persistence: load(save()) behaves identically: the same run with replicas reloaded at random points
 *   ends in the same state, and a reloaded quiet replica does not resend acknowledged data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { decodeSyncMessage } from '@automerge/automerge';
import {
  ALL_STRATEGIES,
  syncSession,
  type Env,
  type Op,
  type Replica,
  type ScalarFieldName,
  type SubscriptionDoc,
  type SyncStrategy,
} from '../src/index';
import { NETFLIX } from './fixtures';

const SEED = 20261113;
const RUNS = 200;
const CLIENTS = ['c1', 'c2', 'c3'] as const;

/** One step of a run. `who` is a client index; `pick` selects a record, a tag, a value, ... */
type Step =
  | { t: 'op'; who: number; kind: number; pick: number }
  | { t: 'sync'; who: number }
  | { t: 'dup'; who: number }
  | { t: 'reload'; who: number }
  | { t: 'resolve'; who: number; pick: number }
  | { t: 'tick'; who: number; ms: number };

const who = fc.nat(CLIENTS.length - 1);
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ t: fc.constant('op' as const), who, kind: fc.nat(9), pick: fc.nat(1000) }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant('sync' as const), who }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('dup' as const), who }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('reload' as const), who }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('resolve' as const), who, pick: fc.nat(10) }) },
  // Clocks move independently and may go backwards, which is what clock skew does to LWW.
  { weight: 2, arbitrary: fc.record({ t: fc.constant('tick' as const), who, ms: fc.integer({ min: -50, max: 200 }) }) },
);

const FIELDS: ScalarFieldName[] = ['name', 'amountCents', 'notes', 'isActive', 'nextPaymentDate'];

function fieldValue(field: ScalarFieldName, pick: number): string | number | boolean {
  switch (field) {
    case 'amountCents':
      return 1000 + (pick % 7) * 100;
    case 'isActive':
      return pick % 2 === 0;
    case 'nextPaymentDate':
      return `2026-12-0${(pick % 9) + 1}`;
    default:
      return `${field}-${pick % 5}`;
  }
}

/** Turns a random step into a valid op for the replica's current state (the oracle only ever sees valid ops). */
function makeOp(replica: Replica, created: number, kind: number, pick: number): Op {
  const docs: SubscriptionDoc[] = replica.read();
  if (kind === 0 || docs.length === 0) {
    return { kind: 'create', id: `${replica.replicaId}-r${created}`, fields: { ...NETFLIX, name: `S${pick % 10}` } };
  }
  const id = docs[pick % docs.length]!.id;
  switch (kind) {
    case 1:
    case 2: {
      const field = FIELDS[pick % FIELDS.length]!;
      return { kind: 'setField', id, field, value: fieldValue(field, pick >> 3) };
    }
    case 3:
      return { kind: 'addTag', id, tag: `t${pick % 4}` };
    case 4:
      return { kind: 'removeTag', id, tag: `t${pick % 4}` };
    case 5:
      return {
        kind: 'addPayment',
        id,
        payment: { id: `${replica.replicaId}-p${pick}`, date: `2026-11-${10 + (pick % 9)}`, amountCents: 4999 },
      };
    case 6:
    case 7:
      return { kind: 'increment', id, by: pick % 3 === 0 ? -1 : 1 };
    default:
      return { kind: 'delete', id };
  }
}

interface World {
  server: Replica;
  clients: Replica[];
  envs: Env[];
}

function snapshot(r: Replica) {
  return { read: r.read(), conflicts: r.conflicts() };
}

function assertQuiet(a: Replica, b: Replica, context: string) {
  assert.equal(a.syncMessage(b.replicaId), null, `${context}: ${a.replicaId} still has something for ${b.replicaId}`);
  assert.equal(b.syncMessage(a.replicaId), null, `${context}: ${b.replicaId} still has something for ${a.replicaId}`);
}

/**
 * Runs the steps. With `reloads = false` the `reload` steps are skipped, which gives the reference run for
 * the persistence property. Returns the final state of every replica after the convergence phase.
 */
function run(strategy: SyncStrategy, steps: Step[], reloads: boolean) {
  const clocks = [1_000_000, 1_000_000, 1_000_000];
  const envOf = (i: number): Env => ({ now: () => clocks[i]!, newId: () => `id-${i}` });
  const w: World = {
    server: strategy.create('server', { now: () => 1_000_000, newId: () => 'id-s' }),
    clients: CLIENTS.map((c, i) => strategy.create(c, envOf(i))),
    envs: CLIENTS.map((_, i) => envOf(i)),
  };
  const created = [0, 0, 0];

  steps.forEach((s, n) => {
    const client = w.clients[s.who]!;
    const at = `step ${n} (${s.t} ${client.replicaId})`;
    switch (s.t) {
      case 'tick':
        clocks[s.who] = Math.max(0, clocks[s.who]! + s.ms);
        return;
      case 'op':
        client.apply(makeOp(client, created[s.who]!++, s.kind, s.pick));
        return;
      case 'sync':
        syncSession(client, w.server);
        assertQuiet(client, w.server, at);
        return;
      case 'dup': {
        const m = client.syncMessage('server');
        if (!m) return;
        w.server.receive(client.replicaId, m);
        const once = snapshot(w.server);
        w.server.receive(client.replicaId, m);
        assert.deepEqual(snapshot(w.server), once, `${at}: idempotence`);
        return;
      }
      case 'reload': {
        if (!reloads) return;
        const before = snapshot(client);
        w.clients[s.who] = strategy.load(client.save(), w.envs[s.who]!);
        assert.deepEqual(snapshot(w.clients[s.who]!), before, `${at}: load(save()) changes the state`);
        return;
      }
      case 'resolve': {
        const conflicts = client.conflicts();
        const c = conflicts[s.pick % Math.max(1, conflicts.length)];
        if (c) client.resolve(c.id, s.pick % c.candidates.length);
        return;
      }
    }
  });

  // Convergence phase: every client completes a session with the server, twice.
  for (let round = 0; round < 2; round++) {
    for (const c of w.clients) {
      syncSession(c, w.server);
      assertQuiet(c, w.server, `final round ${round}`);
    }
  }
  return w;
}

/**
 * Runs a session and counts the messages that carry data. For S1, S2 and Yjs every message counts: their
 * saved state keeps the acknowledgements exactly. Automerge's saved sync state keeps only the shared heads,
 * so after a load it always re-announces its heads; only messages that carry changes count.
 */
function dataMessagesAfterLoad(strategy: SyncStrategy, a: Replica, b: Replica): number {
  let count = 0;
  for (let round = 0; round < 20; round++) {
    const m1 = a.syncMessage(b.replicaId);
    if (m1) {
      if (strategy.name !== 'automerge' || decodeSyncMessage(m1).changes.length > 0) count++;
      b.receive(a.replicaId, m1);
    }
    const m2 = b.syncMessage(a.replicaId);
    if (m2) {
      if (strategy.name !== 'automerge' || decodeSyncMessage(m2).changes.length > 0) count++;
      a.receive(b.replicaId, m2);
    }
    if (!m1 && !m2) return count;
  }
  throw new Error('sync session did not quiesce');
}

for (const strategy of ALL_STRATEGIES) {
  test(`${strategy.name}: quiescence, convergence, idempotence and persistence`, () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 80 }), (steps) => {
        const w = run(strategy, steps, true);
        const expected = snapshot(w.server);
        for (const c of w.clients) assert.deepEqual(snapshot(c), expected, `${c.replicaId} did not converge`);

        // Persistence: the same run without reloads ends in the same state.
        const reference = run(strategy, steps, false);
        assert.deepEqual(snapshot(reference.server), expected, 'reloading replicas changed the outcome');

        // Persistence: a reloaded quiet replica does not resend acknowledged data.
        for (const [i, c] of w.clients.entries()) {
          const reloaded = strategy.load(c.save(), w.envs[i]!);
          const server = strategy.load(w.server.save(), { now: () => 1_000_000, newId: () => 'id-s' });
          const resent = dataMessagesAfterLoad(strategy, reloaded, server);
          assert.deepEqual(snapshot(reloaded), expected);
          assert.equal(resent, 0, `${c.replicaId} resent data after load`);
        }
      }),
      { numRuns: RUNS, seed: SEED },
    );
  });
}
