import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hlc } from '../src/index';
import * as lww from '../src/crdt/lwwRegister';
import { checkLaws } from './crdtLaws';

test('the write with the greater HLC stamp wins, whatever the merge order', () => {
  const a = lww.write('old', lww.toStamp({ wall: 100, counter: 0, replica: 'c2' }));
  const b = lww.write('new', lww.toStamp({ wall: 100, counter: 1, replica: 'c1' }));
  assert.equal(lww.value(lww.merge(a, b)), 'new');
  assert.equal(lww.value(lww.merge(b, a)), 'new');
});

test('a write after receiving a stamp from a faster clock wins although its wall clock is behind', () => {
  const fast = hlc.send(hlc.initialHlc('c1'), 10_000);
  const slow = hlc.send(hlc.receive(hlc.initialHlc('c2'), fast, 5_000), 5_001);
  const merged = lww.merge(lww.write('c1', lww.toStamp(fast)), lww.write('c2', lww.toStamp(slow)));
  assert.equal(lww.value(merged), 'c2');
});

test('stamps keep the HLC order', () => {
  const s = lww.toStamp({ wall: 5, counter: 2, replica: 'c1' });
  assert.deepEqual(lww.fromStamp(s), { wall: 5, counter: 2, replica: 'c1' });
  assert.ok(lww.compareStamp(s, [5, 2, 'c2']) < 0);
  assert.ok(lww.compareStamp(s, [4, 9, 'c9']) > 0);
});

test('LWW register: merge is commutative, associative and idempotent', () => {
  checkLaws<lww.LwwRegister<number>>({
    empty: lww.write(0, [0, 0, '']),
    merge: lww.merge,
    op(state, replica, pick, step) {
      const s: lww.Stamp = [pick % 5, step, replica];
      const next = lww.write(pick, s);
      return { state: lww.merge(state, next), delta: next };
    },
  });
});
