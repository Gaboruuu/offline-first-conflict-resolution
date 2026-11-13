import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_STRATEGIES, getStrategy, isStrategyName } from '../src/index';

test('the registry lists every baseline strategy once, in paper order', () => {
  assert.deepEqual(
    ALL_STRATEGIES.map((s) => s.name),
    ['lww', 'vv', 'automerge', 'yjs'],
  );
});

test('getStrategy finds a strategy by name and rejects unknown names', () => {
  for (const s of ALL_STRATEGIES) assert.equal(getStrategy(s.name), s);
  assert.throws(() => getStrategy('crdt'), /unknown strategy crdt; expected one of lww, vv, automerge, yjs/);
  assert.equal(isStrategyName('vv'), true);
  assert.equal(isStrategyName('hybrid'), false, 'S4 is registered in a later phase');
});
