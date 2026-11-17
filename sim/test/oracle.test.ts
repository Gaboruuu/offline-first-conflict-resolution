import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDoc, type Conflict, type Op, type SubscriptionDoc } from '../../packages/sync-core/src/index';
import { parseConfig } from '../src/config';
import { judge, opClass, OUTCOMES } from '../src/oracle';
import { prepareRun } from '../src/workload';
import type { OpRecord, ReplicaView } from '../src/world';
import { ID_A, ID_B, NETFLIX } from './fixtures';

/** A hand-built log entry: op number `seq` of `origin`, which had seen `seen` before it. */
function rec(origin: string, seq: number, op: Op, seen: Record<string, number> = {}, extra: Partial<OpRecord> = {}): OpRecord {
  return { id: `${origin}:${seq}`, origin, seq, t: seq, op, seen, status: 'applied', setup: false, ...extra };
}

const CREATE_A = rec('server', 1, { kind: 'create', id: ID_A, fields: NETFLIX }, {}, { setup: true });
const AFTER_SETUP = { server: 1 };

function doc(patch: Partial<SubscriptionDoc> = {}, id = ID_A): SubscriptionDoc {
  return { ...emptyDoc(id, NETFLIX), ...patch };
}

function view(docs: SubscriptionDoc[], conflicts: Conflict[] = []): ReplicaView {
  return { replicaId: 'server', docs, conflicts };
}

function run(log: OpRecord[], docs: SubscriptionDoc[], conflicts: Conflict[] = [], views?: ReplicaView[]) {
  const final = view(docs, conflicts);
  return judge({ log, final, views: views ?? [final, { ...final, replicaId: 'c1' }] });
}

const setName = (v: string): Op => ({ kind: 'setField', id: ID_A, field: 'name', value: v });

test('preserved: the value is visible; setup ops are not judged', () => {
  const a = rec('c1', 1, setName('one'), AFTER_SETUP);
  const r = run([CREATE_A, a], [doc({ name: 'one' })]);
  assert.equal(r.outcomes.get(a.id), 'preserved');
  assert.equal(r.outcomes.has(CREATE_A.id), false);
  assert.equal(r.metrics.ops, 1);
  assert.equal(r.metrics.lossRate, 0);
  assert.equal(r.metrics.concurrentLossRate, null);
  assert.equal(r.metrics.converged, true);
});

test('superseded: a causally later write to the same field replaced it', () => {
  const a = rec('c1', 1, setName('one'), AFTER_SETUP);
  const b = rec('c2', 1, setName('two'), { server: 1, c1: 1 });
  const r = run([CREATE_A, a, b], [doc({ name: 'two' })]);
  assert.equal(r.outcomes.get(a.id), 'superseded');
  assert.equal(r.outcomes.get(b.id), 'preserved');
  assert.equal(r.metrics.causalViolations, 0);
});

test('lost: a concurrent write won and nothing surfaces the loser', () => {
  const a = rec('c1', 1, setName('one'), AFTER_SETUP);
  const b = rec('c2', 1, setName('two'), AFTER_SETUP);
  const r = run([CREATE_A, a, b], [doc({ name: 'two' })]);
  assert.equal(r.outcomes.get(a.id), 'lost');
  assert.equal(r.outcomes.get(b.id), 'preserved');
  assert.equal(r.metrics.lossRate, 0.5);
  assert.equal(r.metrics.concurrentOps, 2);
  assert.equal(r.metrics.concurrentLossRate, 0.5);
  assert.equal(r.byClass.SIMPLE.lost, 1);
});

test('lost: a concurrent edit of another field loses the whole record (LWW)', () => {
  const a = rec('c1', 1, setName('one'), AFTER_SETUP);
  const b = rec('c2', 1, { kind: 'setField', id: ID_A, field: 'amountCents', value: 100 }, AFTER_SETUP);
  const r = run([CREATE_A, a, b], [doc({ amountCents: 100 })]);
  assert.equal(r.outcomes.get(a.id), 'lost');
  assert.equal(r.byClass.CRITICAL.preserved, 1);
});

test('surfaced: the losing value is a conflict candidate', () => {
  const a = rec('c1', 1, setName('one'), AFTER_SETUP);
  const b = rec('c2', 1, setName('two'), AFTER_SETUP);
  const conflict: Conflict = {
    id: `${ID_A}/name`,
    recordId: ID_A,
    field: 'name',
    candidates: [
      { value: 'one', replicaId: 'c1' },
      { value: 'two', replicaId: 'c2' },
    ],
  };
  const r = run([CREATE_A, a, b], [doc({ name: 'two' })], [conflict]);
  assert.equal(r.outcomes.get(a.id), 'surfaced');
  assert.equal(r.outcomes.get(b.id), 'preserved');
  assert.equal(r.metrics.surfacedRate, 0.5);
  assert.equal(r.metrics.lost, 0);
});

test('ambiguous: concurrent edit and delete, both sides', () => {
  const edit = rec('c1', 1, setName('one'), AFTER_SETUP);
  const del = rec('c2', 1, { kind: 'delete', id: ID_A }, AFTER_SETUP);
  for (const docs of [[], [doc({ name: 'one' })]]) {
    const r = run([CREATE_A, edit, del], docs);
    assert.equal(r.outcomes.get(edit.id), 'ambiguous');
    assert.equal(r.outcomes.get(del.id), 'ambiguous');
    assert.equal(r.metrics.ambiguous, 2);
    assert.equal(r.metrics.lost, 0);
  }
});

test('ambiguous: concurrent add and remove of the same tag; other tags are judged', () => {
  const setup = rec('server', 2, { kind: 'addTag', id: ID_A, tag: 'x' }, { server: 1 }, { setup: true });
  const seen = { server: 2 };
  const remove = rec('c1', 1, { kind: 'removeTag', id: ID_A, tag: 'x' }, seen);
  const add = rec('c2', 1, { kind: 'addTag', id: ID_A, tag: 'x' }, seen);
  const other = rec('c2', 2, { kind: 'addTag', id: ID_A, tag: 'y' }, { ...seen, c2: 1 });
  const r = run([CREATE_A, setup, remove, add, other], [doc({ tags: ['x'] })]);
  assert.equal(r.outcomes.get(remove.id), 'ambiguous');
  assert.equal(r.outcomes.get(add.id), 'ambiguous');
  assert.equal(r.outcomes.get(other.id), 'lost');
  assert.equal(opClass(other.op), 'SET');
});

test('delete, create and payments', () => {
  const create = rec('c1', 1, { kind: 'create', id: ID_B, fields: NETFLIX });
  const pay = rec('c1', 2, { kind: 'addPayment', id: ID_B, payment: { id: 'p1', date: '2026-12-01', amountCents: 10 } }, { c1: 1 });
  const del = rec('c2', 1, { kind: 'delete', id: ID_B }, { c1: 2 });
  const r = run([create, pay, del], []);
  assert.equal(r.outcomes.get(create.id), 'superseded');
  assert.equal(r.outcomes.get(pay.id), 'superseded');
  assert.equal(r.outcomes.get(del.id), 'preserved');
  assert.equal(r.byClass.RECORD.ops, 2);
  // The same payment visible, delete not applied: the delete is lost.
  const r2 = run([create, pay, del], [doc({ payments: [{ id: 'p1', date: '2026-12-01', amountCents: 10 }] }, ID_B)]);
  assert.equal(r2.outcomes.get(pay.id), 'preserved');
  assert.equal(r2.outcomes.get(del.id), 'lost');
});

test('counter: lost = |expected - actual|, attributed to concurrent ops first', () => {
  const inc = (origin: string, seq: number, seen: Record<string, number>) =>
    rec(origin, seq, { kind: 'increment', id: ID_A, by: 1 }, seen);
  const first = inc('c1', 1, AFTER_SETUP);
  const a = inc('c1', 2, { server: 1, c1: 1 });
  const b = inc('c2', 1, { server: 1, c1: 1 });
  const c = inc('c3', 1, { server: 1, c1: 1 });
  const log = [CREATE_A, first, a, b, c];
  const r = run(log, [doc({ sharedWith: 2 })]);
  assert.equal(r.metrics.lost, 2);
  assert.equal(r.outcomes.get(first.id), 'preserved');
  assert.equal(r.byClass.COUNTER.lost, 2);
  // A conflict whose candidate has the full count makes the difference surfaced, not lost.
  const conflict: Conflict = {
    id: `${ID_A}/sharedWith`,
    recordId: ID_A,
    field: 'sharedWith',
    candidates: [
      { value: 2, replicaId: 'c1' },
      { value: 3, replicaId: 'c2' },
    ],
  };
  const r2 = run(log, [doc({ sharedWith: 2 })], [conflict]);
  assert.equal(r2.metrics.lost, 1);
  assert.equal(r2.metrics.surfaced, 1);
  const r3 = run(log, [doc({ sharedWith: 4 })]);
  assert.equal(r3.metrics.lost, 0);
});

test('causal violation: a stale write is visible although a later write overwrote it', () => {
  const a = rec('c1', 1, setName('old'), AFTER_SETUP);
  const b = rec('c2', 1, setName('new'), { server: 1, c1: 1 });
  const r = run([CREATE_A, a, b], [doc({ name: 'old' })]);
  assert.equal(r.metrics.causalViolations, 1);
  assert.equal(r.outcomes.get(b.id), 'lost');
  assert.equal(r.outcomes.get(a.id), 'preserved');
});

test('converged is false when replicas differ; rejected ops are counted, not judged', () => {
  const rejected = rec('c1', 0, { kind: 'delete', id: ID_B }, {}, { status: 'rejected', id: 'c1:rejected:1' });
  const r = run([CREATE_A, rejected], [doc()], [], [view([doc()]), view([doc({ name: 'x' })])]);
  assert.equal(r.metrics.converged, false);
  assert.equal(r.metrics.rejectedOps, 1);
  assert.equal(r.metrics.ops, 0);
});

test('on a random run every judged op has exactly one outcome and the strategies differ as expected', () => {
  const base = {
    kind: 'random',
    seed: 3,
    clients: 4,
    initialRecords: 4,
    durationMs: 3 * 3_600_000,
    opsPerClientPerHour: 40,
    offline: { meanOnlineMs: 15 * 60_000, meanOfflineMs: 20 * 60_000 },
    skewMs: [0, 60_000, -60_000, 0],
    syncIntervalMs: 60_000,
  };
  const results = Object.fromEntries(
    (['lww', 'vv', 'automerge', 'yjs'] as const).map((strategy) => {
      const { world, endTime } = prepareRun(parseConfig({ ...base, strategy }));
      world.run(endTime);
      world.finish();
      const views = world.views();
      return [strategy, judge({ log: world.log, final: views[0]!, views })];
    }),
  );
  for (const [name, r] of Object.entries(results)) {
    const m = r.metrics;
    assert.equal(m.converged, true, name);
    assert.equal(OUTCOMES.reduce((s, o) => s + m[o], 0), m.ops, name);
    assert.equal(r.outcomes.size, m.ops, name);
  }
  // LWW loses the most; vv surfaces instead of losing scalar conflicts.
  assert.ok(results.lww!.metrics.lost > results.automerge!.metrics.lost, 'lww should lose more than automerge');
  assert.ok(results.vv!.metrics.surfaced > 0);
  assert.equal(results.lww!.metrics.surfaced, 0);
  assert.equal(results.automerge!.byClass.COUNTER.lost, 0);
  assert.equal(results.yjs!.byClass.APPEND.lost, 0);
});
