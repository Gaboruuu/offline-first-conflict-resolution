import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_STRATEGIES, deepEqual } from '../../packages/sync-core/src/index';
import { parseConfig, type RandomConfig } from '../src/config';
import { Prng } from '../src/prng';
import { prepareRun, skewFor } from '../src/workload';
import { ID_A, NETFLIX } from './fixtures';

const RANDOM = {
  kind: 'random',
  seed: 7,
  strategy: 'lww',
  clients: 3,
  initialRecords: 5,
  durationMs: 4 * 3_600_000,
  opsPerClientPerHour: 30,
  offline: { meanOnlineMs: 20 * 60_000, meanOfflineMs: 15 * 60_000 },
  skewMs: [0, -30_000, 120_000],
  syncIntervalMs: 60_000,
};

test('parseConfig fills defaults and rejects bad input', () => {
  const c = parseConfig(RANDOM) as RandomConfig;
  assert.equal(c.kind, 'random');
  assert.equal(c.name, 'random');
  assert.ok((c.opMix.setField ?? 0) > 0);
  assert.throws(() => parseConfig({ ...RANDOM, strategy: 'nope' }), /unknown strategy/);
  assert.throws(() => parseConfig({ ...RANDOM, clients: 0 }), /clients/);
  assert.throws(() => parseConfig({ ...RANDOM, opMix: { teleport: 1 } }), /unknown op kind/);
  assert.throws(() => parseConfig({ kind: 'scripted', clients: ['c1'], steps: [{ t: 5, client: 'c9', do: 'sync' }] }), /unknown client/);
  assert.throws(
    () => parseConfig({ kind: 'scripted', clients: ['c1'], steps: [{ t: 5, client: 'c1', do: 'sync' }, { t: 1, client: 'c1', do: 'sync' }] }),
    /time order/,
  );
});

test('skew distributions are seeded', () => {
  const c = parseConfig({ ...RANDOM, clients: 50, skewMs: { distribution: 'uniform', scale: 1000 } }) as RandomConfig;
  const a = skewFor(c, new Prng(1));
  assert.deepEqual(a, skewFor(c, new Prng(1)));
  assert.ok(a.every((s) => Math.abs(s) <= 1000));
  assert.ok(new Set(a).size > 10);
  assert.deepEqual(skewFor(parseConfig(RANDOM) as RandomConfig, new Prng(1)), [0, -30_000, 120_000]);
});

test('a scripted run executes its steps in order', () => {
  const config = parseConfig({
    kind: 'scripted',
    strategy: 'vv',
    clients: ['c1', 'c2'],
    initial: [{ kind: 'create', id: ID_A, fields: NETFLIX }],
    steps: [
      { t: 10, client: 'c1', do: 'offline' },
      { t: 20, client: 'c1', do: 'op', op: { kind: 'setField', id: ID_A, field: 'amountCents', value: 5999 } },
      { t: 30, client: 'c2', do: 'op', op: { kind: 'setField', id: ID_A, field: 'amountCents', value: 3999 } },
      { t: 40, client: 'c2', do: 'sync' },
      { t: 50, client: 'c1', do: 'online' },
    ],
  });
  const { world, endTime } = prepareRun(config);
  assert.equal(endTime, 50);
  world.finish();
  assert.equal(world.log.length, 3);
  assert.equal(world.log[0]!.setup, true);
  const views = world.views();
  // vv surfaces the concurrent amount change.
  assert.equal(views[0]!.conflicts.length, 1);
  assert.ok(views.every((v) => deepEqual(v.conflicts, views[0]!.conflicts)));
});

test('the random workload generates the same intents for every strategy', () => {
  const runs = ALL_STRATEGIES.map((s) => {
    const { world, endTime } = prepareRun(parseConfig({ ...RANDOM, strategy: s.name }));
    world.run(endTime);
    world.finish();
    return world;
  });
  const intents = runs.map((w) => w.log.map((r) => ({ origin: r.origin, t: r.t, op: r.op })));
  const sessions = runs.map((w) => w.sessions.filter((s) => s.phase === 'run').map((s) => [s.t, s.client]));
  assert.ok(intents[0]!.length > 100, `only ${intents[0]!.length} ops`);
  for (let i = 1; i < runs.length; i++) {
    assert.deepEqual(intents[i], intents[0], `${ALL_STRATEGIES[i]!.name} got other intents`);
    assert.deepEqual(sessions[i], sessions[0]);
  }
  // Clients really go offline and the op mix is used.
  assert.ok(runs[0]!.log.some((r) => r.op.kind === 'addPayment'));
  assert.ok(runs[0]!.log.some((r) => r.op.kind === 'delete'));
  assert.ok(runs[0]!.sessions.filter((s) => s.phase === 'run').length < (3 * 4 * 60));
  // Every strategy converges at the end.
  for (const w of runs) {
    const v = w.views();
    assert.ok(v.every((x) => deepEqual(x.docs, v[0]!.docs) && deepEqual(x.conflicts, v[0]!.conflicts)), w.strategy.name);
  }
});
