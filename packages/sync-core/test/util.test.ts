import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { compareTuple, deepEqual, sortedBy } from '../src/index';

test('compareTuple orders lexicographically', () => {
  assert.ok(compareTuple([1, 'b'], [2, 'a']) < 0);
  assert.ok(compareTuple([2, 'b'], [2, 'a']) > 0);
  assert.equal(compareTuple([2, 'a'], [2, 'a']), 0);
  assert.ok(compareTuple([2], [2, 'a']) < 0);
  assert.ok(compareTuple(['Z'], ['a']) < 0, 'code-unit order, not locale order');
  assert.throws(() => compareTuple([1], ['1']), /cannot compare/);
});

test('sortedBy is stable, accepts tuple keys and does not modify its input', () => {
  const items = [
    { id: 'c', t: 2 },
    { id: 'a', t: 1 },
    { id: 'b', t: 2 },
    { id: 'd', t: 1 },
  ];
  assert.deepEqual(sortedBy(items, (x) => x.t).map((x) => x.id), ['a', 'd', 'c', 'b']);
  assert.deepEqual(sortedBy(items, (x) => [x.t, x.id]).map((x) => x.id), ['a', 'd', 'b', 'c']);
  assert.equal(items[0]!.id, 'c');
});

test('deepEqual', () => {
  assert.ok(deepEqual({ a: [1, { b: 2 }], c: 'x' }, { c: 'x', a: [1, { b: 2 }] }));
  assert.ok(deepEqual(NaN, NaN));
  assert.ok(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2])));
  assert.ok(!deepEqual(new Uint8Array([1, 2]), [1, 2]));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!deepEqual([1, 2], { 0: 1, 1: 2 }));
  assert.ok(!deepEqual(null, {}));
  assert.ok(!deepEqual([1], [1, 2]));
});

test('property: deepEqual agrees with node:assert on JSON values', () => {
  fc.assert(
    fc.property(fc.jsonValue(), fc.jsonValue(), (a, b) => {
      let expected = true;
      try {
        assert.deepStrictEqual(a, b);
      } catch {
        expected = false;
      }
      assert.equal(deepEqual(a, b), expected);
      assert.ok(deepEqual(a, structuredClone(a)));
    }),
    { seed: 4, numRuns: 500 },
  );
});
