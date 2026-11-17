import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_STRATEGIES, getStrategy, deepEqual } from '../../packages/sync-core/src/index';
import { happenedBefore, concurrent } from '../src/causality';
import { T0, World } from '../src/world';
import { ID_A, ID_B, NETFLIX } from './fixtures';

const CLIENTS = [
  { id: 'c1', skewMs: 0 },
  { id: 'c2', skewMs: -5_000 },
];

test('clients read a skewed clock', () => {
  const w = new World(getStrategy('lww'), CLIENTS);
  let clock = 0;
  w.schedule(1_000, {
    type: 'call',
    run: () => {
      clock = w.t;
    },
  });
  w.run();
  assert.equal(clock, 1_000);
  assert.equal(T0 > 0, true);
});

for (const strategy of ALL_STRATEGIES) {
  test(`${strategy.name}: offline edits propagate through the server and every replica converges`, () => {
    const w = new World(strategy, CLIENTS);
    w.schedule(0, { type: 'op', node: 'c1', op: { kind: 'create', id: ID_A, fields: NETFLIX } });
    w.schedule(10, { type: 'syncTick', client: 'c1' });
    w.schedule(20, { type: 'syncTick', client: 'c2' });
    w.schedule(30, { type: 'goOffline', client: 'c1' });
    w.schedule(30, { type: 'goOffline', client: 'c2' });
    w.schedule(40, { type: 'op', node: 'c1', op: { kind: 'setField', id: ID_A, field: 'name', value: 'one' } });
    w.schedule(50, { type: 'op', node: 'c2', op: { kind: 'setField', id: ID_A, field: 'notes', value: 'two' } });
    // Offline: the tick does nothing.
    w.schedule(60, { type: 'syncTick', client: 'c1' });
    w.schedule(70, { type: 'op', node: 'c2', op: { kind: 'create', id: ID_B, fields: NETFLIX } });
    const end = w.finish();
    assert.equal(end.quiescent, true);

    const [create, e1, e2, createB] = w.log;
    assert.ok(create && e1 && e2 && createB);
    assert.equal(w.log.every((r) => r.status === 'applied'), true);
    // c2 synced after the create, before going offline.
    assert.equal(happenedBefore(create, e2), true);
    assert.equal(concurrent(e1, e2), true);
    assert.equal(happenedBefore(e2, createB), true);

    const views = w.views();
    for (const v of views) {
      assert.ok(deepEqual(v.docs, views[0]!.docs), `${v.replicaId} differs`);
      assert.ok(deepEqual(v.conflicts, views[0]!.conflicts));
    }
    assert.deepEqual(w.seenOf('server'), { c1: 2, c2: 2 });
    assert.deepEqual(w.seenOf('c1'), w.seenOf('c2'));
    // Ticks while offline record no session.
    assert.equal(w.sessions.filter((s) => s.phase === 'run').length, 2);
    assert.ok(w.sessions.some((s) => s.phase === 'final' && s.bytesUp > 0));
    assert.ok(w.stateBytes().every((s) => s.bytes > 0));
  });
}

test('the shadow state follows the causal history, not the strategy', () => {
  const w = new World(getStrategy('lww'), CLIENTS);
  w.applyOp('c1', { kind: 'create', id: ID_A, fields: NETFLIX });
  assert.equal(w.shadow('c1').length, 1);
  assert.equal(w.shadow('c2').length, 0);
  w.sync('c1');
  w.sync('c2');
  assert.deepEqual(w.shadow('c2'), w.shadow('c1'));
  // A generated op sees the shadow.
  const rec = w.applyOp('c2', (docs) => ({ kind: 'setField', id: docs[0]!.id, field: 'name', value: 'x' }));
  assert.equal(rec.status, 'applied');
  assert.equal(w.shadow('c2')[0]!.name, 'x');
  assert.equal(w.shadow('c1')[0]!.name, 'Netflix');
});

test('an op the replica cannot apply is logged as rejected and not integrated', () => {
  const w = new World(getStrategy('lww'), CLIENTS);
  const rec = w.applyOp('c1', { kind: 'delete', id: ID_A });
  assert.equal(rec.status, 'rejected');
  assert.equal(rec.seq, 0);
  assert.match(rec.reason ?? '', /does not exist/);
  assert.deepEqual(w.seenOf('c1'), {});
});

test('periodic sync ticks reschedule themselves until the end time', () => {
  const w = new World(getStrategy('vv'), CLIENTS);
  w.schedule(0, { type: 'syncTick', client: 'c1', intervalMs: 100, until: 1_000 });
  w.run();
  assert.equal(w.sessions.length, 11);
  assert.throws(() => w.schedule(5, { type: 'goOnline', client: 'c1' }));
});
