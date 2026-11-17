import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as pn from '../src/crdt/pnCounter';
import { checkLaws } from './crdtLaws';

test('concurrent increments all count', () => {
  let a = pn.increment(pn.EMPTY, 'c1', 1).state;
  const b = pn.increment(a, 'c2', 1).state;
  const c = pn.increment(a, 'c3', 1).state;
  a = pn.increment(a, 'c1', 1).state;
  const all = pn.merge(pn.merge(a, b), c);
  assert.equal(pn.value(all), 4);
  assert.equal(pn.value(pn.increment(all, 'c2', -1).state), 3);
});

test('the delta of an increment holds only the writer entry', () => {
  const s = pn.merge(pn.increment(pn.EMPTY, 'c1', 1).state, pn.increment(pn.EMPTY, 'c2', 1).state);
  assert.deepEqual(pn.increment(s, 'c2', 1).delta, { p: { c2: 2 }, n: {} });
  assert.deepEqual(pn.increment(s, 'c2', -1).delta, { p: {}, n: { c2: 1 } });
  assert.throws(() => pn.increment(s, 'c1', 0), RangeError);
});

test('PN-Counter: merge is commutative, associative and idempotent', () => {
  checkLaws<pn.PnCounter>({
    empty: pn.EMPTY,
    merge: pn.merge,
    op: (state, replica, pick) => pn.increment(state, replica, pick % 2 === 0 ? 1 : -1),
  });
});
