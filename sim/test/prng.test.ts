import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prng, hashString, mulberry32 } from '../src/prng';

test('mulberry32 is deterministic and in [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 1000; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test('forked streams are independent of each other and of the parent', () => {
  const p = new Prng(7);
  const c1 = p.fork('c1');
  const c2 = p.fork('c2');
  assert.notEqual(c1.float(), c2.float());
  // Drawing from one stream does not shift another.
  const again = new Prng(7).fork('c2');
  new Prng(7).fork('c1').float();
  assert.equal(new Prng(7).fork('c2').float(), again.float());
  assert.equal(hashString('c1'), hashString('c1'));
});

test('int covers the inclusive range', () => {
  const p = new Prng(1);
  const seen = new Set<number>();
  for (let i = 0; i < 2000; i++) seen.add(p.int(3, 6));
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6]);
  assert.throws(() => p.int(2, 1));
});

test('exponential has roughly the requested mean', () => {
  const p = new Prng(3);
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) sum += p.exponential(500);
  assert.ok(Math.abs(sum / n - 500) < 15, `mean ${sum / n}`);
  assert.throws(() => p.exponential(0));
});

test('normal has roughly mean 0 and sd 1', () => {
  const p = new Prng(4);
  const xs = Array.from({ length: 20000 }, () => p.normal());
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean) < 0.03 && Math.abs(sd - 1) < 0.03, `${mean} ${sd}`);
});

test('pick follows the weights and ignores property order', () => {
  const p = new Prng(5);
  const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 10000; i++) counts[p.pick({ a: 1, b: 3, c: 0 })]++;
  assert.equal(counts.c, 0);
  assert.ok(Math.abs(counts.b / 10000 - 0.75) < 0.02, JSON.stringify(counts));
  const x = new Prng(9).pick({ a: 1, b: 1, c: 1 });
  const y = new Prng(9).pick({ c: 1, b: 1, a: 1 });
  assert.equal(x, y);
  assert.throws(() => p.pick({ a: 0 }));
});

test('uuid is a deterministic version-4 UUID', () => {
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const a = new Prng(11);
  const b = new Prng(11);
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const id = a.uuid();
    assert.match(id, re);
    assert.equal(id, b.uuid());
    ids.add(id);
  }
  assert.equal(ids.size, 500);
});
