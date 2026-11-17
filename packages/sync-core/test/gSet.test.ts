import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as gSet from '../src/crdt/gSet';
import { checkLaws } from './crdtLaws';

interface P {
  date: string;
  amountCents: number;
}

test('concurrent adds are all kept and an add of a known id changes nothing', () => {
  const a = gSet.add<P>(gSet.EMPTY, 'p1', { date: '2026-11-01', amountCents: 100 }).state;
  const b = gSet.add<P>(gSet.EMPTY, 'p2', { date: '2026-11-02', amountCents: 200 }).state;
  const all = gSet.merge(a, b);
  assert.deepEqual(gSet.values(all), [
    { date: '2026-11-01', amountCents: 100 },
    { date: '2026-11-02', amountCents: 200 },
  ]);
  assert.deepEqual(gSet.merge(all, a), all);
  assert.equal(gSet.has(all, 'p2'), true);
});

test('G-Set: merge is commutative, associative and idempotent', () => {
  checkLaws<gSet.GSet<P>>({
    empty: gSet.EMPTY,
    merge: gSet.merge,
    // Few ids, so the same id is added on several replicas (with different values, the worst case).
    op: (state, replica, pick) => gSet.add(state, `p${pick % 6}`, { date: '2026-11-01', amountCents: replica.length * pick }),
  });
});
