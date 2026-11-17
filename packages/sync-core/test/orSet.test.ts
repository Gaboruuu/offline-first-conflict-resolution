import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as orSet from '../src/crdt/orSet';
import { checkLaws } from './crdtLaws';

test('concurrent adds and removes of different tags all apply', () => {
  let base = orSet.add(orSet.EMPTY, 'essential', 'server').state;
  base = orSet.add(base, 'mobile', 'server').state;
  const c1 = orSet.remove(orSet.add(base, 'work', 'c1').state, 'essential').state;
  const c2 = orSet.add(base, 'family', 'c2').state;
  assert.deepEqual(orSet.elements(orSet.merge(c1, c2)), ['family', 'mobile', 'work']);
});

test('an add concurrent with a remove of the same tag wins', () => {
  const base = orSet.add(orSet.EMPTY, 'x', 'server').state;
  const removed = orSet.remove(base, 'x').state;
  const readded = orSet.add(base, 'x', 'c2').state;
  assert.equal(orSet.has(orSet.merge(removed, readded), 'x'), true);
  assert.equal(orSet.has(orSet.merge(removed, base), 'x'), false, 'a remove beats the add it observed');
});

test('the remove delta carries only the removed dots and no element tombstone', () => {
  const s = orSet.add(orSet.add(orSet.EMPTY, 'x', 'c1').state, 'y', 'c1').state;
  const { state, delta } = orSet.remove(s, 'x');
  assert.deepEqual(delta, { e: {}, ctx: { v: { c1: 1 } } });
  assert.deepEqual(state.e, { y: [['c1', 2]] });
});

test('OR-Set: merge is commutative, associative and idempotent', () => {
  const tags = ['a', 'b', 'c'];
  checkLaws<orSet.OrSet>({
    empty: orSet.EMPTY,
    merge: orSet.merge,
    op: (state, replica, pick) =>
      pick % 3 === 0 ? orSet.remove(state, tags[(pick >> 2) % 3]!) : orSet.add(state, tags[(pick >> 2) % 3]!, replica),
  });
});
