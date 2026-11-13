import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOpToDocs, emptyDoc, validateOp, type Op, type SubscriptionDoc } from '../src/index';
import { ID_A, ID_B, NETFLIX } from './fixtures';

const docs: SubscriptionDoc[] = [emptyDoc(ID_A, NETFLIX)];

const reason = (op: Op) => {
  const r = validateOp(op, docs);
  return r.ok ? null : r.reason;
};

test('valid ops pass', () => {
  const ok: Op[] = [
    { kind: 'create', id: ID_B, fields: NETFLIX },
    { kind: 'setField', id: ID_A, field: 'notes', value: 'family plan' },
    { kind: 'setField', id: ID_A, field: 'amountCents', value: 5499 },
    { kind: 'setField', id: ID_A, field: 'isActive', value: false },
    { kind: 'setField', id: ID_A, field: 'billingCycle', value: 'YEARLY' },
    { kind: 'addTag', id: ID_A, tag: 'family' },
    { kind: 'removeTag', id: ID_A, tag: 'family' },
    { kind: 'addPayment', id: ID_A, payment: { id: 'p1', date: '2026-11-01', amountCents: 4999 } },
    { kind: 'increment', id: ID_A, by: 1 },
    { kind: 'increment', id: ID_A, by: -1 },
    { kind: 'delete', id: ID_A },
  ];
  for (const op of ok) assert.equal(reason(op), null, JSON.stringify(op));
});

test('ops on unknown or deleted records are rejected', () => {
  assert.match(reason({ kind: 'setField', id: ID_B, field: 'name', value: 'x' })!, /does not exist/);
  assert.match(reason({ kind: 'delete', id: ID_B })!, /does not exist/);
  const afterDelete = applyOpToDocs(docs, { kind: 'delete', id: ID_A });
  assert.equal(validateOp({ kind: 'addTag', id: ID_A, tag: 'x' }, afterDelete).ok, false);
});

test('creating an existing record is rejected', () => {
  assert.match(reason({ kind: 'create', id: ID_A, fields: NETFLIX })!, /already exists/);
});

test('bad field names and ill-typed values are rejected', () => {
  const bad = [
    { kind: 'setField', id: ID_A, field: 'tags', value: 'x' },
    { kind: 'setField', id: ID_A, field: 'id', value: 'x' },
    { kind: 'setField', id: ID_A, field: 'amountCents', value: 49.99 },
    { kind: 'setField', id: ID_A, field: 'amountCents', value: '4999' },
    { kind: 'setField', id: ID_A, field: 'billingCycle', value: 'DAILY' },
    { kind: 'setField', id: ID_A, field: 'nextPaymentDate', value: '1 Dec 2026' },
    { kind: 'setField', id: ID_A, field: 'isActive', value: 'yes' },
    { kind: 'create', id: ID_B, fields: { ...NETFLIX, color: 'red' } },
    { kind: 'create', id: ID_B, fields: { name: 'x' } },
  ] as unknown as Op[];
  for (const op of bad) assert.equal(validateOp(op, docs).ok, false, JSON.stringify(op));
});

test('empty tags, malformed payments and bad increments are rejected', () => {
  assert.match(reason({ kind: 'addTag', id: ID_A, tag: '' })!, /tag/);
  assert.match(reason({ kind: 'removeTag', id: ID_A, tag: '   ' })!, /tag/);
  assert.equal(reason({ kind: 'addPayment', id: ID_A, payment: { id: '', date: '2026-11-01', amountCents: 1 } }) !== null, true);
  assert.equal(reason({ kind: 'addPayment', id: ID_A, payment: { id: 'p', date: '2026/11/01', amountCents: 1 } }) !== null, true);
  assert.equal(reason({ kind: 'increment', id: ID_A, by: 2 } as unknown as Op) !== null, true);
  assert.equal(reason({ kind: 'rename', id: ID_A } as unknown as Op) !== null, true);
});

test('applyOpToDocs gives the sequential reference semantics', () => {
  let s: SubscriptionDoc[] = [];
  s = applyOpToDocs(s, { kind: 'create', id: ID_B, fields: NETFLIX });
  s = applyOpToDocs(s, { kind: 'create', id: ID_A, fields: { ...NETFLIX, name: 'Spotify' } });
  s = applyOpToDocs(s, { kind: 'setField', id: ID_A, field: 'amountCents', value: 2399 });
  s = applyOpToDocs(s, { kind: 'addTag', id: ID_A, tag: 'music' });
  s = applyOpToDocs(s, { kind: 'addTag', id: ID_A, tag: 'family' });
  s = applyOpToDocs(s, { kind: 'addTag', id: ID_A, tag: 'music' });
  s = applyOpToDocs(s, { kind: 'removeTag', id: ID_A, tag: 'family' });
  s = applyOpToDocs(s, { kind: 'addPayment', id: ID_A, payment: { id: 'p2', date: '2026-11-01', amountCents: 2399 } });
  s = applyOpToDocs(s, { kind: 'addPayment', id: ID_A, payment: { id: 'p1', date: '2026-10-01', amountCents: 2399 } });
  s = applyOpToDocs(s, { kind: 'increment', id: ID_A, by: 1 });
  s = applyOpToDocs(s, { kind: 'increment', id: ID_A, by: 1 });
  s = applyOpToDocs(s, { kind: 'delete', id: ID_B });
  assert.deepEqual(s, [
    {
      ...NETFLIX,
      id: ID_A,
      name: 'Spotify',
      amountCents: 2399,
      tags: ['music'],
      payments: [
        { id: 'p1', date: '2026-10-01', amountCents: 2399 },
        { id: 'p2', date: '2026-11-01', amountCents: 2399 },
      ],
      sharedWith: 2,
    },
  ]);
  assert.throws(() => applyOpToDocs(s, { kind: 'delete', id: ID_B }), /invalid op/);
});
