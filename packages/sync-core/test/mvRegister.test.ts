import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as causal from '../src/crdt/causal';
import * as mv from '../src/crdt/mvRegister';
import { checkLaws } from './crdtLaws';

const values = (r: mv.MvRegister<number>) => mv.candidates(r.versions).map((x) => x.v);

test('concurrent writes become siblings; a later write that saw them replaces both', () => {
  const base = mv.write<number>(mv.EMPTY, 4999, 'server', [1, 0, 'server']).state;
  const a = mv.write(base, 16000, 'c1', [10, 0, 'c1']).state;
  const b = mv.write(base, 14500, 'c2', [12, 0, 'c2']).state;
  const both = mv.merge(a, b);
  assert.deepEqual(values(both), [16000, 14500]);
  assert.equal(mv.winner(both.versions)!.v, 14500, 'the provisional value has the greatest stamp');
  const resolved = mv.write(both, 16000, 'c2', [20, 0, 'c2']).state;
  assert.deepEqual(values(resolved), [16000]);
  assert.deepEqual(values(mv.merge(a, resolved)), [16000], 'the resolution dominates the old sibling');
});

test('siblings with equal values are one candidate but keep both dots', () => {
  const base = mv.write<number>(mv.EMPTY, 1, 'server', [1, 0, 'server']).state;
  const both = mv.merge(mv.write(base, 2, 'c1', [5, 0, 'c1']).state, mv.write(base, 2, 'c2', [6, 0, 'c2']).state);
  assert.equal(both.versions.length, 2);
  assert.deepEqual(values(both), [2]);
});

test('causal contexts are canonical: contiguous dots compact into the vector', () => {
  const c = causal.add(causal.EMPTY_CTX, ['c1', 2], ['c1', 1], ['c2', 3]);
  assert.deepEqual(c, { v: { c1: 2 }, c: [['c2', 3]] });
  assert.deepEqual(causal.merge(c, causal.fromDots([['c2', 1], ['c2', 2]])), { v: { c1: 2, c2: 3 } });
  assert.deepEqual(causal.next(c, 'c2'), ['c2', 4]);
  assert.equal(causal.covers(c, causal.fromDots([['c1', 1]])), true);
  assert.equal(causal.covers(c, causal.fromDots([['c2', 1]])), false);
});

test('MV register: merge is commutative, associative and idempotent', () => {
  checkLaws<mv.MvRegister<number>>({
    empty: mv.EMPTY,
    merge: mv.merge,
    op: (state, replica, pick, step) => mv.write(state, pick % 4, replica, [pick % 7, step, replica]),
  });
});
