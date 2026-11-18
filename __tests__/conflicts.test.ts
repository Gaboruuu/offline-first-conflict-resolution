import type { Conflict } from '@sync-core/strategy';

import { Subscription } from '@/model/Subscription';
import { strings } from '@/strings';
import { describeConflict, formatCandidate } from '@/util/conflicts';

const netflix: Subscription = {
  id: 'r1',
  name: 'Netflix',
  amount: 49.99,
  currency: 'RON',
  billingCycle: 'MONTHLY',
  nextPaymentDate: '2026-11-04',
  category: 'ENTERTAINMENT',
  isActive: true,
  notes: '',
  tags: [],
  payments: [],
  sharedWith: 0,
};

describe('describeConflict', () => {
  it('names the record, the field and where each candidate comes from', () => {
    const conflict: Conflict = {
      id: 'r1/amountCents',
      recordId: 'r1',
      field: 'amountCents',
      candidates: [
        { value: 4999, replicaId: 'app-me' },
        { value: 5499, replicaId: 'app-other' },
      ],
    };
    expect(describeConflict(conflict, netflix, 'app-me')).toEqual({
      id: 'r1/amountCents',
      title: 'Netflix',
      field: strings.conflictFieldPrice,
      candidates: [
        { value: '49.99 RON', origin: strings.conflictThisDevice },
        { value: '54.99 RON', origin: strings.conflictOtherDevice },
      ],
    });
  });

  it('still describes a conflict whose record is not visible', () => {
    const conflict: Conflict = {
      id: 'r2/__deleted',
      recordId: 'r2',
      field: '__deleted',
      candidates: [
        { value: true, replicaId: 'a' },
        { value: false, replicaId: 'b' },
      ],
    };
    const view = describeConflict(conflict, undefined, null);
    expect(view.title).toBe(strings.conflictUnknownRecord);
    expect(view.candidates.map((c) => c.value)).toEqual([strings.conflictDeleted, strings.conflictKept]);
  });
});

describe('formatCandidate', () => {
  it('formats every kind of field', () => {
    expect(formatCandidate('nextPaymentDate', '2026-11-04', 'RON')).toMatch(/Nov/);
    expect(formatCandidate('billingCycle', 'YEARLY', 'RON')).toBe('Yearly');
    expect(formatCandidate('category', 'WORK', 'RON')).toBe('Work');
    expect(formatCandidate('isActive', false, 'RON')).toBe(strings.conflictPaused);
    expect(formatCandidate('tags', ['a', 'b'], 'RON')).toBe('#a #b');
    expect(formatCandidate('tags', [], 'RON')).toBe(strings.conflictNoTags);
    expect(formatCandidate('payments', [{ id: 'p', date: '2026-01-01', amountCents: 1 }], 'RON')).toBe('1 payment');
    expect(formatCandidate('sharedWith', 3, 'RON')).toBe('3 people');
    expect(formatCandidate('notes', '', 'RON')).toBe(strings.conflictEmpty);
    expect(formatCandidate('name', 'Netflix HD', 'RON')).toBe('Netflix HD');
  });
});
