import { emptyDoc, type SubscriptionDoc } from '@sync-core/model';
import { applyOpToDocs } from '@sync-core/ops';

import { NewSubscription } from '@/model/Subscription';
import { diffOps, fromDoc, opsForCreate } from '@/sync/docs';

const netflix: NewSubscription = {
  name: 'Netflix',
  amount: 49.99,
  currency: 'RON',
  billingCycle: 'MONTHLY',
  nextPaymentDate: '2026-11-04',
  category: 'ENTERTAINMENT',
  isActive: true,
  notes: '',
  tags: ['tv', 'family'],
  payments: [{ id: 'p1', date: '2026-10-04', amountCents: 4999 }],
  sharedWith: 2,
};

const replay = (ops: Parameters<typeof applyOpToDocs>[1][], docs: SubscriptionDoc[] = []) =>
  ops.reduce((acc, op) => applyOpToDocs(acc, op), docs);

describe('opsForCreate / fromDoc', () => {
  it('creates a record whose visible state is the subscription', () => {
    const ops = opsForCreate('r1', netflix);
    expect(ops.map((o) => o.kind)).toEqual(['create', 'addTag', 'addTag', 'addPayment', 'increment', 'increment']);
    const [doc] = replay(ops);
    expect(fromDoc(doc)).toEqual({ ...netflix, id: 'r1', tags: ['family', 'tv'] });
    expect(doc.amountCents).toBe(4999);
  });

  it('falls back to OTHER for a category the app does not know', () => {
    const doc = emptyDoc('r1', { ...replay(opsForCreate('r1', netflix))[0], category: 'GAMES' });
    expect(fromDoc(doc).category).toBe('OTHER');
  });
});

describe('diffOps', () => {
  const [doc] = replay(opsForCreate('r1', netflix));

  it('produces no ops for an unchanged record', () => {
    expect(diffOps(doc, { ...netflix, tags: ['family', 'tv'] })).toEqual([]);
  });

  it('produces one op per changed field, tag, new payment and counter step', () => {
    const edited: NewSubscription = {
      ...netflix,
      amount: 54.99,
      notes: 'premium',
      tags: ['family', 'work'],
      payments: [...netflix.payments, { id: 'p2', date: '2026-11-04', amountCents: 5499 }],
      sharedWith: 0,
    };
    const ops = diffOps(doc, edited);
    expect(ops).toEqual([
      { kind: 'setField', id: 'r1', field: 'amountCents', value: 5499 },
      { kind: 'setField', id: 'r1', field: 'notes', value: 'premium' },
      { kind: 'addTag', id: 'r1', tag: 'work' },
      { kind: 'removeTag', id: 'r1', tag: 'tv' },
      { kind: 'addPayment', id: 'r1', payment: { id: 'p2', date: '2026-11-04', amountCents: 5499 } },
      { kind: 'increment', id: 'r1', by: -1 },
      { kind: 'increment', id: 'r1', by: -1 },
    ]);
    expect(fromDoc(replay(ops, [doc])[0])).toEqual({ ...edited, id: 'r1' });
  });

  it('never removes payments (the history is append-only)', () => {
    expect(diffOps(doc, { ...netflix, tags: ['family', 'tv'], payments: [] })).toEqual([]);
  });
});
