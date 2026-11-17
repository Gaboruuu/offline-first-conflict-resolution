import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncSession, versionVectorStrategy as vvStrategy, type Replica } from '../src/index';
import { ID_A, ID_B, NETFLIX, manualEnv } from './fixtures';

function setup() {
  const server = vvStrategy.create('server', manualEnv().env);
  const c1 = vvStrategy.create('c1', manualEnv().env);
  const c2 = vvStrategy.create('c2', manualEnv().env);
  c1.apply({ kind: 'create', id: ID_A, fields: NETFLIX });
  syncSession(c1, server);
  syncSession(c2, server);
  return { server, c1, c2 };
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
  c2.apply({ kind: 'setField', id: ID_A, field: 'amountCents', value: 5999 });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  const [doc] = server.read();
  assert.equal(doc!.notes, 'family plan');
  assert.equal(doc!.amountCents, 5999);
  assert.deepEqual(server.conflicts(), []);
});

test('a causally later edit of the same field wins without a conflict', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'first' });
  settle(server, c1, c2);
  c2.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'second' });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.equal(c1.read()[0]!.name, 'second');
  assert.deepEqual(c1.conflicts(), []);
});

test('concurrent edits of the same field surface a conflict; resolve dominates both', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'amountCents', value: 5499 });
  c2.apply({ kind: 'setField', id: ID_A, field: 'amountCents', value: 5999 });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  const conflicts = c1.conflicts();
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], {
    id: `${ID_A}/amountCents`,
    recordId: ID_A,
    field: 'amountCents',
    candidates: [
      { value: 5499, replicaId: 'c1' },
      { value: 5999, replicaId: 'c2' },
    ],
  });
  assert.equal(c1.read()[0]!.amountCents, 5999, 'provisional value from the highest replica id');

  c1.resolve(conflicts[0]!.id, 0);
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.deepEqual(c2.conflicts(), []);
  assert.equal(c2.read()[0]!.amountCents, 5499);
});

test('the same value written concurrently is not a conflict', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'category', value: 'Video' });
  c2.apply({ kind: 'setField', id: ID_A, field: 'category', value: 'Video' });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.deepEqual(server.conflicts(), []);
});

test('a later write that saw one of two equal concurrent writes does not erase the other', () => {
  const { server, c1, c2 } = setup();
  const c3 = vvStrategy.create('c3', manualEnv().env);
  syncSession(c3, server);
  c1.apply({ kind: 'setField', id: ID_A, field: 'billingCycle', value: 'YEARLY' });
  c2.apply({ kind: 'setField', id: ID_A, field: 'billingCycle', value: 'YEARLY' });
  syncSession(c2, server);
  syncSession(c3, server);
  // The server now merges c1's equal value; c3 has seen c2's write only, so its edit is concurrent with c1's.
  syncSession(c1, server);
  c3.apply({ kind: 'setField', id: ID_A, field: 'billingCycle', value: 'WEEKLY' });
  syncSession(c3, server);
  settle(server, c1, c2);
  settle(server, c3, c1);
  const conflict = server.conflicts().find((c) => c.field === 'billingCycle');
  assert.ok(conflict, 'c1 YEARLY vs c3 WEEKLY is surfaced');
  assert.deepEqual(conflict.candidates.map((c) => c.value).sort(), ['WEEKLY', 'YEARLY']);
});

test('tags, payments and sharedWith behave like single values', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'addTag', id: ID_A, tag: 'family' });
  c2.apply({ kind: 'addTag', id: ID_A, tag: 'work' });
  c1.apply({ kind: 'increment', id: ID_A, by: 1 });
  c1.apply({ kind: 'increment', id: ID_A, by: 1 });
  c2.apply({ kind: 'increment', id: ID_A, by: 1 });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  const fields = server.conflicts().map((c) => c.field);
  assert.deepEqual(fields.sort(), ['sharedWith', 'tags']);
  assert.equal(server.read()[0]!.sharedWith, 1, 'provisional value from c2: two of the three increments are not visible');
  assert.deepEqual(server.read()[0]!.tags, ['work']);
});

test('edit vs delete: conflict on __deleted, the record stays visible', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'delete', id: ID_A });
  c2.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'still using it' });
  assert.deepEqual(c1.read(), [], 'deleted locally');
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.equal(c1.read()[0]!.notes, 'still using it');
  const [conflict] = c1.conflicts();
  assert.equal(conflict!.field, '__deleted');
  assert.deepEqual(conflict!.candidates, [
    { value: true, replicaId: 'c1' },
    { value: false, replicaId: 'c2' },
  ]);
  c2.resolve(conflict!.id, 0); // agree to delete
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.deepEqual(server.read(), []);
  assert.deepEqual(server.conflicts(), []);
});

test('a delete that saw every edit removes the record', () => {
  const { server, c1, c2 } = setup();
  c2.apply({ kind: 'delete', id: ID_A });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.deepEqual(c1.read(), []);
});

test('three replicas through a server converge and go quiet', () => {
  const { server, c1, c2 } = setup();
  const c3 = vvStrategy.create('c3', manualEnv().env);
  c1.apply({ kind: 'create', id: ID_B, fields: { ...NETFLIX, name: 'Spotify' } });
  c2.apply({ kind: 'addPayment', id: ID_A, payment: { id: 'p1', date: '2026-11-01', amountCents: 4999 } });
  c3.apply({ kind: 'create', id: 'c3-record', fields: { ...NETFLIX, name: 'HBO' } });
  settle(server, c1, c2, c3);
  assertSame(server, c1, c2, c3);
  assert.equal(server.read().length, 3);
  for (const c of [c1, c2, c3]) {
    assert.equal(c.syncMessage('server'), null);
    assert.equal(server.syncMessage(c.replicaId), null);
  }
});

test('receiving the same message twice changes nothing', () => {
  const { server, c1 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'x' });
  const m = c1.syncMessage('server')!;
  server.receive('c1', m);
  const before = server.save();
  server.receive('c1', m);
  assert.deepEqual(server.save(), before);
});

test('save/load round trip keeps records, conflicts and sync state', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'one' });
  c2.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'two' });
  settle(server, c1, c2);
  const restored = vvStrategy.load(c1.save(), manualEnv().env);
  assert.equal(restored.replicaId, 'c1');
  assert.deepEqual(restored.read(), c1.read());
  assert.deepEqual(restored.conflicts(), c1.conflicts());
  assert.deepEqual(restored.save(), c1.save());
  assert.equal(restored.syncMessage('server'), null, 'acknowledged data is not resent');
  restored.resolve(`${ID_A}/name`, 1);
  syncSession(restored, server);
  assert.deepEqual(server.read(), restored.read());
  assert.throws(() => vvStrategy.load(new TextEncoder().encode('{"strategy":"lww"}'), manualEnv().env));
});
