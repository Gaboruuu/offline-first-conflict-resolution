import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { hlc, type Hlc } from '../src/index';

const H = (wall: number, counter: number, replica = 'c1'): Hlc => ({ wall, counter, replica });

test('send follows Kulkarni et al.: the counter resets when physical time moves ahead', () => {
  assert.deepEqual(hlc.send(H(100, 3), 200), H(200, 0));
  assert.deepEqual(hlc.send(H(100, 3), 100), H(100, 4));
  assert.deepEqual(hlc.send(H(100, 3), 50), H(100, 4), 'clock went backwards');
  assert.deepEqual(hlc.send(H(100, 3), 250.9), H(250, 0), 'fractional ms are floored');
});

test('receive covers the four cases of the algorithm', () => {
  const local = H(100, 2, 'c1');
  assert.deepEqual(hlc.receive(local, H(100, 5, 'c2'), 90), H(100, 6, 'c1'), 'l = l\' = l_m');
  assert.deepEqual(hlc.receive(local, H(80, 9, 'c2'), 90), H(100, 3, 'c1'), 'l = l\'');
  assert.deepEqual(hlc.receive(local, H(120, 4, 'c2'), 90), H(120, 5, 'c1'), 'l = l_m');
  assert.deepEqual(hlc.receive(local, H(120, 4, 'c2'), 150), H(150, 0, 'c1'), 'physical time is ahead');
});

test('invalid physical times are rejected', () => {
  assert.throws(() => hlc.send(H(0, 0), NaN), RangeError);
  assert.throws(() => hlc.send(H(0, 0), -1), RangeError);
});

test('compareHlc is (wall, counter, replica)', () => {
  assert.ok(hlc.compareHlc(H(1, 9), H(2, 0)) < 0);
  assert.ok(hlc.compareHlc(H(2, 1), H(2, 0)) > 0);
  assert.ok(hlc.compareHlc(H(2, 1, 'c1'), H(2, 1, 'c2')) < 0);
  assert.equal(hlc.compareHlc(H(2, 1), H(2, 1)), 0);
  assert.deepEqual(hlc.maxHlc(H(2, 1, 'c1'), H(2, 1, 'c2')), H(2, 1, 'c2'));
});

test('string form', () => {
  const h = H(1763060400000, 3, 'a-b-c');
  assert.equal(hlc.hlcToString(h), '001763060400000-0000000003-a-b-c');
  assert.deepEqual(hlc.hlcFromString(hlc.hlcToString(h)), h);
  assert.throws(() => hlc.hlcFromString('17-3-c1'), SyntaxError);
  assert.throws(() => hlc.hlcToString(H(-1, 0)), RangeError);
});

const now = fc.integer({ min: 0, max: 2_000_000_000_000 });
const replica = fc.constantFrom('server', 'c1', 'c2', 'c10');
const arbHlc = fc.record({ wall: now, counter: fc.integer({ min: 0, max: 1000 }), replica }).map((h): Hlc => ({ ...h }));

test('property: send is strictly monotonic even when now goes backwards', () => {
  fc.assert(
    fc.property(fc.array(now, { minLength: 1, maxLength: 50 }), (times) => {
      let clock = hlc.initialHlc('c1');
      for (const t of times) {
        const next = hlc.send(clock, t);
        assert.ok(hlc.compareHlc(next, clock) > 0);
        assert.ok(next.wall >= t);
        clock = next;
      }
      assert.equal(clock.wall, Math.max(...times), 'l is the largest physical time seen');
    }),
    { seed: 20, numRuns: 500 },
  );
});

test('property: receive is greater than both inputs', () => {
  fc.assert(
    fc.property(arbHlc, arbHlc, now, (local, remote, t) => {
      const r = hlc.receive(local, remote, t);
      assert.ok(hlc.compareHlc(r, local) > 0);
      assert.ok(r.wall > remote.wall || (r.wall === remote.wall && r.counter > remote.counter));
      assert.equal(r.wall, Math.max(local.wall, remote.wall, t));
      assert.equal(r.replica, local.replica);
    }),
    { seed: 21, numRuns: 1000 },
  );
});

test('property: a message chain across skewed replicas never goes backwards', () => {
  const step = fc.record({ to: fc.integer({ min: 0, max: 2 }), skew: fc.integer({ min: -3_600_000, max: 3_600_000 }) });
  fc.assert(
    fc.property(fc.array(step, { minLength: 1, maxLength: 40 }), (steps) => {
      const clocks = ['c0', 'c1', 'c2'].map(hlc.initialHlc);
      let last = clocks[0]!;
      let t = 10_000_000;
      for (const { to, skew } of steps) {
        t += 1000;
        const sent = hlc.send(last, t);
        const got = hlc.receive(clocks[to]!, sent, t + skew);
        assert.ok(hlc.compareHlc(got, sent) > 0);
        clocks[to] = got;
        last = got;
      }
    }),
    { seed: 22, numRuns: 300 },
  );
});

test('property: string order equals compareHlc order', () => {
  fc.assert(
    fc.property(arbHlc, arbHlc, (a, b) => {
      const s = hlc.hlcToString(a);
      const t = hlc.hlcToString(b);
      assert.equal(Math.sign(s < t ? -1 : s > t ? 1 : 0), Math.sign(hlc.compareHlc(a, b)));
      assert.deepEqual(hlc.hlcFromString(s), a);
    }),
    { seed: 23, numRuns: 1000 },
  );
});
