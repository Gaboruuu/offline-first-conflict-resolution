import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIELD_CLASS, SCALAR_FIELDS, emptyDoc, isScalarFieldName, normalizeDoc } from '../src/index';
import { ID_A, NETFLIX } from './fixtures';

test('emptyDoc starts with no tags, no payments and sharedWith = 0', () => {
  assert.deepEqual(emptyDoc(ID_A, NETFLIX), { ...NETFLIX, id: ID_A, tags: [], payments: [], sharedWith: 0 });
});

test('emptyDoc ignores extra properties smuggled into fields', () => {
  const doc = emptyDoc(ID_A, { ...NETFLIX, tags: ['x'] } as typeof NETFLIX);
  assert.deepEqual(doc.tags, []);
});

test('every field has a class and every scalar field is listed', () => {
  assert.equal(Object.keys(FIELD_CLASS).length, SCALAR_FIELDS.length + 3);
  for (const f of SCALAR_FIELDS) assert.ok(isScalarFieldName(f));
  assert.equal(isScalarFieldName('tags'), false);
  assert.equal(isScalarFieldName('id'), false);
});

test('normalizeDoc sorts and deduplicates tags and sorts payments by (date, id)', () => {
  const doc = {
    ...emptyDoc(ID_A, NETFLIX),
    tags: ['b', 'a', 'b'],
    payments: [
      { id: 'p2', date: '2026-02-01', amountCents: 1 },
      { id: 'p3', date: '2026-01-01', amountCents: 1 },
      { id: 'p1', date: '2026-02-01', amountCents: 1 },
    ],
  };
  const n = normalizeDoc(doc);
  assert.deepEqual(n.tags, ['a', 'b']);
  assert.deepEqual(n.payments.map((p) => p.id), ['p3', 'p1', 'p2']);
  assert.deepEqual(doc.tags, ['b', 'a', 'b'], 'input is not modified');
});
