import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { vv, type VersionVector } from '../src/index';

const replicas = fc.constantFrom('server', 'c1', 'c2', 'c3');
const arbVv: fc.Arbitrary<VersionVector> = fc
  .dictionary(replicas, fc.integer({ min: 1, max: 5 }), { maxKeys: 4 })
  .map((d) => ({ ...d }) as VersionVector);

test('increment, get and covers', () => {
  let v = vv.EMPTY_VV;
  v = vv.increment(v, 'c1');
  v = vv.increment(v, 'c1');
  v = vv.increment(v, 'c2');
  assert.deepEqual(v, { c1: 2, c2: 1 });
  assert.equal(vv.get(v, 'c3'), 0);
  assert.equal(vv.get(v, 'toString'), 0, 'no prototype keys');
  assert.ok(vv.covers(v, { replica: 'c1', counter: 2 }));
  assert.ok(!vv.covers(v, { replica: 'c1', counter: 3 }));
  assert.deepEqual(vv.EMPTY_VV, {}, 'increment does not modify its input');
});

test('compare and dominates', () => {
  assert.equal(vv.compare({ a: 1 }, { a: 1 }), 'equal');
  assert.equal(vv.compare({}, {}), 'equal');
  assert.equal(vv.compare({ a: 1 }, { a: 2 }), 'before');
  assert.equal(vv.compare({ a: 1, b: 1 }, { a: 1 }), 'after');
  assert.equal(vv.compare({ a: 2 }, { a: 1, b: 1 }), 'concurrent');
  assert.ok(vv.dominates({ a: 2, b: 1 }, { a: 1 }));
  assert.ok(vv.dominates({ a: 1 }, { a: 1 }));
  assert.ok(!vv.dominates({ a: 1 }, { b: 1 }));
});

test('property: merge is commutative, associative and idempotent', () => {
  fc.assert(
    fc.property(arbVv, arbVv, arbVv, (a, b, c) => {
      assert.deepEqual(vv.merge(a, b), vv.merge(b, a));
      assert.deepEqual(vv.merge(vv.merge(a, b), c), vv.merge(a, vv.merge(b, c)));
      assert.deepEqual(vv.merge(a, a), a);
    }),
    { seed: 10, numRuns: 500 },
  );
});

test('property: merge is the least upper bound', () => {
  fc.assert(
    fc.property(arbVv, arbVv, (a, b) => {
      const m = vv.merge(a, b);
      assert.ok(vv.dominates(m, a) && vv.dominates(m, b));
      assert.equal(vv.compare(m, a) === 'equal', vv.dominates(a, b));
    }),
    { seed: 11, numRuns: 500 },
  );
});

test('property: compare is antisymmetric and agrees with increment', () => {
  const flip = { before: 'after', after: 'before', equal: 'equal', concurrent: 'concurrent' } as const;
  fc.assert(
    fc.property(arbVv, arbVv, replicas, (a, b, r) => {
      assert.equal(vv.compare(b, a), flip[vv.compare(a, b)]);
      assert.equal(vv.compare(a, vv.increment(a, r)), 'before');
    }),
    { seed: 12, numRuns: 500 },
  );
});
