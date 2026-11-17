import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventQueue } from '../src/queue';
import { Prng } from '../src/prng';

test('events come out by time, ties in insertion order', () => {
  const q = new EventQueue<string>();
  const p = new Prng(1);
  const items: { t: number; v: string }[] = [];
  for (let i = 0; i < 300; i++) {
    const t = p.int(0, 20);
    items.push({ t, v: `e${i}` });
    q.push(t, `e${i}`);
  }
  const expected = [...items].sort((a, b) => a.t - b.t).map((x) => x.v); // Array.sort is stable
  const got: string[] = [];
  for (let e = q.pop(); e; e = q.pop()) got.push(e.event);
  assert.deepEqual(got, expected);
  assert.equal(q.peekTime(), undefined);
  assert.throws(() => q.push(Number.NaN, 'x'));
});
