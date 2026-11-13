import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lwwStrategy, syncSession, type Replica } from '../src/index';
import { ID_A, ID_B, NETFLIX, manualEnv } from './fixtures';

/** Two clients and a server, each with its own hand-set clock. */
function setup() {
  const clocks = { server: manualEnv(1_000), c1: manualEnv(1_000), c2: manualEnv(1_000) };
  const server = lwwStrategy.create('server', clocks.server.env);
  const c1 = lwwStrategy.create('c1', clocks.c1.env);
  const c2 = lwwStrategy.create('c2', clocks.c2.env);
  return { clocks, server, c1, c2 };
}

/** c1 creates the record and both clients receive it through the server. */
function shared() {
  const s = setup();
  s.c1.apply({ kind: 'create', id: ID_A, fields: NETFLIX });
  syncSession(s.c1, s.server);
  syncSession(s.c2, s.server);
  return s;
}

function quiet(a: Replica, b: Replica) {
  assert.equal(a.syncMessage(b.replicaId), null);
  assert.equal(b.syncMessage(a.replicaId), null);
}

test('a local op is visible immediately and reaches the other client', () => {
  const { c1, c2, server } = shared();
  assert.deepEqual(c2.read(), c1.read());
  assert.equal(c2.read()[0]!.name, 'Netflix');
  quiet(c1, server);
  quiet(c2, server);
});

test('concurrent edits of different fields: the whole older record is lost', () => {
  const { clocks, c1, c2, server } = shared();
  clocks.c1.set(2_000);
  c1.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'family plan' });
  clocks.c2.set(3_000);
  c2.apply({ kind: 'setField', id: ID_A, field: 'amountCents', value: 5999 });
  syncSession(c1, server);
  syncSession(c2, server);
  syncSession(c1, server);
  for (const r of [c1, c2, server]) {
    const [doc] = r.read();
    assert.equal(doc!.amountCents, 5999);
    assert.equal(doc!.notes, '', 'the earlier write to notes is lost');
  }
  assert.deepEqual(c1.conflicts(), []);
});

test('concurrent edits of the same field: the later timestamp wins regardless of sync order', () => {
  const { clocks, c1, c2, server } = shared();
  clocks.c2.set(2_000);
  c2.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'Netflix (c2)' });
  clocks.c1.set(3_000);
  c1.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'Netflix (c1)' });
  // c2 syncs first, but c1's write is later.
  syncSession(c2, server);
  syncSession(c1, server);
  syncSession(c2, server);
  for (const r of [c1, c2, server]) assert.equal(r.read()[0]!.name, 'Netflix (c1)');
});

test('equal timestamps are broken by replica id', () => {
  const { clocks, c1, c2, server } = shared();
  clocks.c1.set(5_000);
  clocks.c2.set(5_000);
  c1.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'one' });
  c2.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'two' });
  syncSession(c1, server);
  syncSession(c2, server);
  syncSession(c1, server);
  for (const r of [c1, c2, server]) assert.equal(r.read()[0]!.name, 'two');
});

test('clock skew: a client whose clock runs behind loses its later write', () => {
  const { clocks, c1, c2, server } = shared();
  clocks.c1.set(10_000);
  c1.apply({ kind: 'setField', id: ID_A, field: 'category', value: 'Video' });
  syncSession(c1, server);
  syncSession(c2, server);
  // c2 edits after seeing c1's write, but its clock is 5 s behind.
  clocks.c2.set(5_000);
  c2.apply({ kind: 'setField', id: ID_A, field: 'category', value: 'Entertainment' });
  assert.equal(c2.read()[0]!.category, 'Entertainment', 'visible locally until the next sync');
  syncSession(c2, server);
  syncSession(c1, server);
  for (const r of [c1, c2, server]) assert.equal(r.read()[0]!.category, 'Video');
});

test('edit vs delete: the later of the two wins', () => {
  {
    const { clocks, c1, c2, server } = shared();
    clocks.c1.set(2_000);
    c1.apply({ kind: 'delete', id: ID_A });
    clocks.c2.set(3_000);
    c2.apply({ kind: 'addTag', id: ID_A, tag: 'family' });
    syncSession(c1, server);
    syncSession(c2, server);
    syncSession(c1, server);
    for (const r of [c1, c2, server]) assert.deepEqual(r.read()[0]!.tags, ['family'], 'edit is later: record restored');
  }
  {
    const { clocks, c1, c2, server } = shared();
    clocks.c1.set(3_000);
    c1.apply({ kind: 'delete', id: ID_A });
    clocks.c2.set(2_000);
    c2.apply({ kind: 'addTag', id: ID_A, tag: 'family' });
    syncSession(c2, server);
    syncSession(c1, server);
    syncSession(c2, server);
    for (const r of [c1, c2, server]) assert.deepEqual(r.read(), [], 'delete is later: record gone');
  }
});

test('three replicas through a server converge and go quiet', () => {
  const { clocks, c1, c2, server } = shared();
  const c3 = lwwStrategy.create('c3', manualEnv(1_500).env);
  clocks.c1.set(2_000);
  c1.apply({ kind: 'create', id: ID_B, fields: { ...NETFLIX, name: 'Spotify' } });
  clocks.c2.set(2_100);
  c2.apply({ kind: 'increment', id: ID_A, by: 1 });
  c2.apply({ kind: 'addPayment', id: ID_A, payment: { id: 'p1', date: '2026-11-01', amountCents: 4999 } });
  for (let i = 0; i < 2; i++) for (const c of [c1, c2, c3]) syncSession(c, server);
  const expected = server.read();
  assert.equal(expected.length, 2);
  assert.equal(expected[0]!.sharedWith, 1);
  assert.equal(expected[0]!.payments.length, 1);
  for (const c of [c1, c2, c3]) {
    assert.deepEqual(c.read(), expected);
    quiet(c, server);
  }
});

test('receiving the same message twice changes nothing', () => {
  const { clocks, c1, server } = shared();
  clocks.c1.set(2_000);
  c1.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'x' });
  const m = c1.syncMessage('server')!;
  server.receive('c1', m);
  const before = server.save();
  server.receive('c1', m);
  assert.deepEqual(server.save(), before);
});

test('a lost message is sent again', () => {
  const { clocks, c1, server } = shared();
  clocks.c1.set(2_000);
  c1.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'x' });
  assert.ok(c1.syncMessage('server'), 'this message is dropped');
  syncSession(c1, server);
  assert.equal(server.read()[0]!.notes, 'x');
  quiet(c1, server);
});

test('save/load round trip keeps records and per-peer sync state', () => {
  const { clocks, c1, server } = shared();
  const restored = lwwStrategy.load(c1.save(), clocks.c1.env);
  assert.equal(restored.replicaId, 'c1');
  assert.deepEqual(restored.read(), c1.read());
  assert.deepEqual(restored.save(), c1.save());
  // Acknowledged data is not resent.
  quiet(restored, server);
  clocks.c1.set(2_000);
  restored.apply({ kind: 'removeTag', id: ID_A, tag: 'none' });
  syncSession(restored, server);
  assert.deepEqual(server.read(), restored.read());
  assert.throws(() => lwwStrategy.load(new TextEncoder().encode('{"strategy":"vv"}'), clocks.c1.env));
});

test('invalid ops are rejected and change nothing', () => {
  const { c1 } = shared();
  const before = c1.save();
  assert.throws(() => c1.apply({ kind: 'setField', id: ID_B, field: 'name', value: 'x' }), /does not exist/);
  assert.throws(() => c1.apply({ kind: 'create', id: ID_A, fields: NETFLIX }), /already exists/);
  assert.deepEqual(c1.save(), before);
});
