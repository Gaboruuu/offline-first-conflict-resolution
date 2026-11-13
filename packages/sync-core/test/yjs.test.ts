import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIdFor, yjsStrategy as ys, syncSession, type Replica } from '../src/index';
import { ID_A, ID_B, NETFLIX, manualEnv } from './fixtures';

function setup() {
  const server = ys.create('server', manualEnv().env);
  const c1 = ys.create('c1', manualEnv().env);
  const c2 = ys.create('c2', manualEnv().env);
  c1.apply({ kind: 'create', id: ID_A, fields: NETFLIX });
  syncSession(c1, server);
  syncSession(c2, server);
  return { server, c1, c2 };
}

function settle(server: Replica, ...clients: Replica[]) {
  for (let i = 0; i < 2; i++) for (const c of clients) syncSession(c, server);
}

function assertSame(...replicas: Replica[]) {
  const [first, ...rest] = replicas;
  for (const r of rest) assert.deepEqual(r.read(), first!.read(), r.replicaId);
}

test('records created on different replicas end up in one document', () => {
  const { server, c1, c2 } = setup();
  c2.apply({ kind: 'create', id: ID_B, fields: { ...NETFLIX, name: 'Spotify' } });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.deepEqual(
    c1.read().map((d) => d.name),
    ['Netflix', 'Spotify'],
  );
  assert.deepEqual(c1.read()[0], { ...NETFLIX, id: ID_A, tags: [], payments: [], sharedWith: 0 });
});

test('concurrent edits of different fields are merged', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'family plan' });
  c2.apply({ kind: 'setField', id: ID_A, field: 'amountCents', value: 5999 });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.equal(server.read()[0]!.notes, 'family plan');
  assert.equal(server.read()[0]!.amountCents, 5999);
});

test('concurrent edits of the same field: the library picks one winner, no conflict reported', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'one' });
  c2.apply({ kind: 'setField', id: ID_A, field: 'name', value: 'two' });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.ok(['one', 'two'].includes(server.read()[0]!.name));
  assert.deepEqual(server.conflicts(), []);
});

test('tags, payments and the counter merge without loss', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'addTag', id: ID_A, tag: 'family' });
  c2.apply({ kind: 'addTag', id: ID_A, tag: 'work' });
  c1.apply({ kind: 'increment', id: ID_A, by: 1 });
  c1.apply({ kind: 'increment', id: ID_A, by: 1 });
  c2.apply({ kind: 'increment', id: ID_A, by: 1 });
  c1.apply({ kind: 'addPayment', id: ID_A, payment: { id: 'p2', date: '2026-12-01', amountCents: 4999 } });
  c2.apply({ kind: 'addPayment', id: ID_A, payment: { id: 'p1', date: '2026-11-01', amountCents: 4999 } });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  const [doc] = server.read();
  assert.deepEqual(doc!.tags, ['family', 'work']);
  assert.equal(doc!.sharedWith, 3);
  assert.deepEqual(
    doc!.payments.map((p) => p.id),
    ['p1', 'p2'],
  );
});

test('edit vs delete: the key is removed and the edit is lost', () => {
  const { server, c1, c2 } = setup();
  c1.apply({ kind: 'delete', id: ID_A });
  c2.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'still using it' });
  settle(server, c1, c2);
  assertSame(server, c1, c2);
  assert.deepEqual(server.read(), []);
});

test('three replicas through a server converge and go quiet', () => {
  const { server, c1, c2 } = setup();
  const c3 = ys.create('c3', manualEnv().env);
  c1.apply({ kind: 'create', id: ID_B, fields: { ...NETFLIX, name: 'Spotify' } });
  c2.apply({ kind: 'removeTag', id: ID_A, tag: 'none' });
  c3.apply({ kind: 'create', id: 'c3-record', fields: { ...NETFLIX, name: 'HBO' } });
  settle(server, c1, c2, c3);
  assertSame(server, c1, c2, c3);
  assert.equal(server.read().length, 3);
  for (const c of [c1, c2, c3]) {
    assert.equal(c.syncMessage('server'), null);
    assert.equal(server.syncMessage(c.replicaId), null);
  }
});

test('receiving the same message twice changes nothing visible', () => {
  const { server, c1 } = setup();
  c1.apply({ kind: 'setField', id: ID_A, field: 'notes', value: 'x' });
  const m = c1.syncMessage('server')!;
  server.receive('c1', m);
  const before = server.read();
  server.receive('c1', m);
  assert.deepEqual(server.read(), before);
});

test('save/load round trip keeps the document and the sync states', () => {
  const { server, c1 } = setup();
  const restored = ys.load(c1.save(), manualEnv().env);
  assert.equal(restored.replicaId, 'c1');
  assert.deepEqual(restored.read(), c1.read());
  restored.apply({ kind: 'increment', id: ID_A, by: 1 });
  let bytes = 0;
  syncSession(restored, server, (_, n) => (bytes += n));
  assert.deepEqual(server.read(), restored.read());
  assert.ok(bytes < 1000, `only the new change is exchanged (${bytes} bytes)`);
  assert.throws(() => ys.load(new TextEncoder().encode('{"strategy":"lww"}'), manualEnv().env));
});

test('the Yjs clientID is a fixed hash of the replica id', () => {
  assert.equal(clientIdFor('c1'), clientIdFor('c1'));
  assert.notEqual(clientIdFor('c1'), clientIdFor('c2'));
  const env = manualEnv().env;
  const a = ys.create('c1', env);
  a.apply({ kind: 'create', id: ID_A, fields: NETFLIX });
  const b = ys.create('c1', env);
  b.apply({ kind: 'create', id: ID_A, fields: NETFLIX });
  assert.deepEqual(a.save(), b.save(), 'same ops, same bytes');
});
