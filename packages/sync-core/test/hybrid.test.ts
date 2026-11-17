import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHybridStrategy,
  decodeJson,
  hybridStrategy,
  syncSession,
  type Replica,
  type SyncStrategy,
} from '../src/index';
import { ID_A, ID_B, NETFLIX, manualEnv, type ManualEnv } from './fixtures';

function setup(strategy: SyncStrategy = hybridStrategy) {
  const envs: Record<string, ManualEnv> = { server: manualEnv(), c1: manualEnv(), c2: manualEnv(), c3: manualEnv() };
  const server = strategy.create('server', envs.server!.env);
  const c1 = strategy.create('c1', envs.c1!.env);
  const c2 = strategy.create('c2', envs.c2!.env);
  const c3 = strategy.create('c3', envs.c3!.env);
  c1.apply({ kind: 'create', id: ID_A, fields: NETFLIX });
  for (const c of [c1, c2, c3]) syncSession(c, server);
  return { server, c1, c2, c3, envs };
}

/** Two rounds through the server: enough for every replica to see everything. */
function settle(server: Replica, ...clients: Replica[]) {
  for (let i = 0; i < 2; i++) for (const c of clients) syncSession(c, server);
}

function assertSame(...replicas: Replica[]) {
  const [first, ...rest] = replicas;
  for (const r of rest) {
    assert.deepEqual(r.read(), first!.read(), `${r.replicaId} read()`);
    assert.deepEqual(r.conflicts(), first!.conflicts(), `${r.replicaId} conflicts()`);
  }
}

test('concurrent edits of different fields are merged', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'family plan' });
  c2.apply({ kind: 'setField', id: ID_A, field: 'category', value: 'Music' });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.equal(server.read()[0]!.notes, 'family plan');
  assert.equal(server.read()[0]!.category, 'Music');
  assert.deepEqual(server.conflicts(), []);
});

test('concurrent edits of a SIMPLE field: the greater HLC wins, no conflict', () => {
  const { server, c1, c2, envs } = setup();
  envs.c2!.tick(10);
  c1.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'from c1' });
  c2.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'from c2' });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.equal(server.read()[0]!.name, 'from c2');
  assert.deepEqual(server.conflicts(), []);
});

test('a causally later write wins even when its clock runs an hour behind', () => {
  const { server, c1, c2, envs } = setup();
  envs.c1!.set(10_000_000);
  envs.c2!.set(10_000_000 - 3_600_000);
  c1.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'Netflix Premium' });
  settle(server, c1, c2);
  c2.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'Netflix Standard' });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.equal(server.read()[0]!.name, 'Netflix Standard');
});

test('concurrent edits of a CRITICAL field surface a conflict; the resolution dominates both', () => {
  const { server, c1, c2, envs } = setup();
  envs.c2!.tick(5);
  c1.apply({ kind: 'setField', id: ID_A, field: 'amountCents', value: 16000 });
  c2.apply({ kind: 'setField', id: ID_A, field: 'amountCents', value: 14500 });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.equal(server.read()[0]!.amountCents, 14500, 'provisional value: the greater HLC');
  assert.deepEqual(server.conflicts(), [
    {
      id: `${ID_A}/amountCents`,
      recordId: ID_A,
      field: 'amountCents',
      candidates: [
        { value: 16000, replicaId: 'c1' },
        { value: 14500, replicaId: 'c2' },
      ],
    },
  ]);
  c1.resolve(`${ID_A}/amountCents`, 0);
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.equal(server.read()[0]!.amountCents, 16000);
  assert.deepEqual(server.conflicts(), []);
});

test('equal concurrent values of a CRITICAL field are not a conflict', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'nextPaymentDate', value: '2027-01-01' });
  c2.apply({ kind: 'setField', id: ID_A, field: 'nextPaymentDate', value: '2027-01-01' });
  settle(server, c1, c2);
  assert.deepEqual(server.conflicts(), []);
});

test('tags merge as an add-wins set', () => {
  const { server, c1, c2, c3 } = setup();
  for (const tag of ['essential', 'mobile']) c1.apply({ kind: 'addTag', id: ID_A, tag });
  settle(server, c1, c2, c3);
  c1.apply({ kind: 'addTag', id: ID_A, tag: 'work' });
  c1.apply({ kind: 'removeTag', id: ID_A, tag: 'essential' });
  c2.apply({ kind: 'addTag', id: ID_A, tag: 'family' });
  c3.apply({ kind: 'addTag', id: ID_A, tag: 'shared' });
  c3.apply({ kind: 'removeTag', id: ID_A, tag: 'mobile' });
  c2.apply({ kind: 'removeTag', id: ID_A, tag: 'mobile' });
  c2.apply({ kind: 'addTag', id: ID_A, tag: 'mobile' });
  settle(server, c1, c2, c3);
  assertSame(server, c1, c2, c3);
  assert.deepEqual(server.read()[0]!.tags, ['family', 'mobile', 'shared', 'work']);
});

test('payments are a grow-only set and the counter adds concurrent increments', () => {
  const { server, c1, c2, c3 } = setup();
  c1.apply({ kind: 'addPayment', id: ID_A, payment: { id: 'p1', date: '2026-11-01', amountCents: 4999 } });
  c2.apply({ kind: 'addPayment', id: ID_A, payment: { id: 'p2', date: '2026-10-01', amountCents: 4999 } });
  for (const c of [c1, c2, c3]) c.apply({ kind: 'increment', id: ID_A, by: 1 });
  c3.apply({ kind: 'increment', id: ID_A, by: -1 });
  settle(server, c1, c2, c3);
  assertSame(server, c1, c2, c3);
  const [doc] = server.read();
  assert.deepEqual(doc!.payments.map((p) => p.id), ['p2', 'p1']);
  assert.equal(doc!.sharedWith, 2);
});

test('edit wins over a concurrent delete by default; a delete that saw every edit removes the record', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'delete', id: ID_A });
  c2.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'Resuming in January' });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.equal(server.read()[0]!.notes, 'Resuming in January');
  c1.apply({ kind: 'delete', id: ID_A });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.deepEqual(server.read(), []);
});

test('with deleteWins a concurrent delete removes the record', () => {
  const strategy = createHybridStrategy({ deletePolicy: 'deleteWins' });
  const { server, c1, c2 } = setup(strategy);
  c1.apply({ kind: 'delete', id: ID_A });
  c2.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'Resuming in January' });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.deepEqual(server.read(), []);
  assert.deepEqual(strategy.load(server.save(), manualEnv().env).read(), []);
});

test('a message carries only the changed entries of a record', () => {
  const { server, c1 } = setup();
  c1.apply({ kind: 'create', id: ID_B, fields: NETFLIX });
  syncSession(c1, server);
  c1.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'x' });
  const message = decodeJson<{ r: { id: string; e: Record<string, unknown> }[] }>(c1.syncMessage('server')!);
  assert.deepEqual(
    message.r.map((r) => [r.id, Object.keys(r.e)]),
    [[ID_A, ['notes']]],
  );
});

test('no-op ops write nothing', () => {
  const { server, c1 } = setup();
  const payment = { id: 'p1', date: '2026-11-01', amountCents: 1 };
  c1.apply({ kind: 'addPayment', id: ID_A, payment });
  syncSession(c1, server);
  const before = c1.save();
  c1.apply({ kind: 'removeTag', id: ID_A, tag: 'absent' });
  c1.apply({ kind: 'addPayment', id: ID_A, payment });
  assert.deepEqual(c1.save(), before);
  assert.equal(c1.syncMessage('server'), null);
});

test('ops on a deleted record are rejected', () => {
  const { c1 } = setup();
  c1.apply({ kind: 'delete', id: ID_A });
  assert.throws(() => c1.apply({ kind: 'increment', id: ID_A, by: 1 }), /does not exist/);
});
