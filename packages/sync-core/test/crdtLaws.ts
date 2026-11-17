/**
 * Shared property check for the CRDT building blocks: random histories over three replicas (local ops, state
 * merges and delta merges) produce a pool of reachable states; merge must be commutative, associative and
 * idempotent on that pool, and merging the delta of an op into the state before it must give the state after it.
 */
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { deepEqual } from '../src/index';

export const SEED = 20261117;
export const REPLICAS = ['c1', 'c2', 'server'] as const;

export interface Laws<S> {
  empty: S;
  merge(a: S, b: S): S;
  /** A local op chosen by `pick` on `replica`; returns the new state and its delta. */
  op(state: S, replica: string, pick: number, step: number): { state: S; delta: S };
}

type Action = { t: 'op'; who: number; pick: number } | { t: 'state' | 'delta'; who: number; from: number };

const action: fc.Arbitrary<Action> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('op' as const), who: fc.nat(2), pick: fc.nat(1000) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('state' as const), who: fc.nat(2), from: fc.nat(2) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('delta' as const), who: fc.nat(2), from: fc.nat(100) }) },
);

function history<S>(laws: Laws<S>, actions: Action[]): S[] {
  const states: S[] = REPLICAS.map(() => laws.empty);
  const deltas: S[] = [];
  const pool: S[] = [laws.empty];
  actions.forEach((a, step) => {
    const i = a.who;
    if (a.t === 'op') {
      const before = states[i]!;
      const { state, delta } = laws.op(before, REPLICAS[i]!, a.pick, step);
      assert.ok(deepEqual(laws.merge(before, delta), state), 'merging the delta gives the new state');
      states[i] = state;
      deltas.push(delta);
      pool.push(delta);
    } else if (a.t === 'state') {
      states[i] = laws.merge(states[i]!, states[a.from]!);
    } else if (deltas.length > 0) {
      states[i] = laws.merge(states[i]!, deltas[a.from % deltas.length]!);
    }
    pool.push(states[i]!);
  });
  // Full exchange: every replica ends with the same state.
  const all = states.reduce((x, y) => laws.merge(x, y));
  for (const s of states) assert.ok(deepEqual(laws.merge(s, all), all), 'merge is an upper bound');
  return pool;
}

export function checkLaws<S>(laws: Laws<S>): void {
  fc.assert(
    fc.property(fc.array(action, { maxLength: 40 }), fc.nat(), fc.nat(), fc.nat(), (actions, x, y, z) => {
      const pool = history(laws, actions);
      const a = pool[x % pool.length]!;
      const b = pool[y % pool.length]!;
      const c = pool[z % pool.length]!;
      assert.ok(deepEqual(laws.merge(a, b), laws.merge(b, a)), 'commutative');
      assert.ok(deepEqual(laws.merge(laws.merge(a, b), c), laws.merge(a, laws.merge(b, c))), 'associative');
      assert.ok(deepEqual(laws.merge(a, a), a), 'idempotent');
    }),
    { seed: SEED, numRuns: 300 },
  );
}
