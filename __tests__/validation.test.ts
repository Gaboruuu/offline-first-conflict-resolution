import { strings } from '@/strings';
import { dueText } from '@/util/due';
import { addDays, daysBetween, formatDate, isIsoDate } from '@/util/dates';
import { MAX_SHARED_WITH, MAX_TAG_LENGTH, MAX_TAGS } from '@/model/Subscription';
import {
  amountCentsOf,
  clampSharedWith,
  SubscriptionFormValues,
  validateAmount,
  validateSubscriptionForm,
  validateTag,
} from '@/util/validation';

const valid: SubscriptionFormValues = {
  name: '  Netflix ',
  amount: '49,99',
  currency: 'RON',
  billingCycle: 'MONTHLY',
  nextPaymentDate: '2026-10-13',
  category: 'ENTERTAINMENT',
  isActive: true,
  notes: ' shared ',
  tags: [],
  payments: [],
  sharedWith: 0,
};

describe('validateSubscriptionForm', () => {
  it('normalises tags into a sorted set and sorts payments', () => {
    const result = validateSubscriptionForm({
      ...valid,
      tags: ['Family ', 'work', 'family', ' '],
      payments: [
        { id: 'b', date: '2026-11-01', amountCents: 4999 },
        { id: 'a', date: '2026-10-01', amountCents: 4999 },
      ],
      sharedWith: 2.4,
    });
    expect(result.ok && result.subscription.tags).toEqual(['family', 'work']);
    expect(result.ok && result.subscription.payments.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.ok && result.subscription.sharedWith).toBe(2);
  });

  it('returns a trimmed subscription for valid input', () => {
    const result = validateSubscriptionForm(valid);
    expect(result).toEqual({
      ok: true,
      subscription: { ...valid, name: 'Netflix', amount: 49.99, notes: 'shared' },
    });
  });

  it('reports an error per invalid field', () => {
    const result = validateSubscriptionForm({ ...valid, name: ' ', amount: '', nextPaymentDate: null });
    expect(result).toEqual({
      ok: false,
      errors: {
        name: strings.errorNameRequired,
        amount: strings.errorAmountRequired,
        nextPaymentDate: strings.errorDateRequired,
      },
    });
  });

  it('rejects names longer than 50 characters', () => {
    const result = validateSubscriptionForm({ ...valid, name: 'x'.repeat(51) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.name).toBe(strings.errorNameTooLong(50));
  });
});

describe('validateAmount', () => {
  it.each([
    ['abc', strings.errorAmountInvalid],
    ['1.2.3', strings.errorAmountInvalid],
    ['0', strings.errorAmountPositive],
    ['-5', strings.errorAmountPositive],
    ['1.999', strings.errorAmountDecimals],
    ['12.5', undefined],
    ['.5', undefined],
    ['150', undefined],
  ])('%s -> %s', (input, expected) => {
    expect(validateAmount(input)).toBe(expected);
  });
});

describe('dates', () => {
  it('formats and compares ISO dates', () => {
    expect(formatDate('2026-10-07')).toBe('07 Oct 2026');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(daysBetween('2026-10-11', '2026-10-08')).toBe(-3);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
  });

  it('describes when a payment is due', () => {
    const today = '2026-10-11';
    expect(dueText('2026-10-10', today)).toBe(strings.overdue);
    expect(dueText(today, today)).toBe(strings.dueToday);
    expect(dueText('2026-10-12', today)).toBe(strings.dueTomorrow);
    expect(dueText('2026-10-14', today)).toBe('due in 3 days');
    expect(dueText('2026-10-20', today)).toBe('20 Oct 2026');
  });
});

describe('validateTag', () => {
  it('accepts a new tag and rejects empty, duplicate and long ones', () => {
    expect(validateTag(' Family ', ['work'])).toBeUndefined();
    expect(validateTag('  ', [])).toBe(strings.errorTagRequired);
    expect(validateTag('WORK', ['work'])).toBe(strings.errorTagDuplicate);
    expect(validateTag('x'.repeat(MAX_TAG_LENGTH + 1), [])).toBe(strings.errorTagTooLong(MAX_TAG_LENGTH));
  });

  it('limits the number of tags', () => {
    const tags = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(validateTag('another', tags)).toBe(strings.errorTooManyTags(MAX_TAGS));
  });
});

describe('clampSharedWith and amountCentsOf', () => {
  it('keeps the counter a whole number in range', () => {
    expect(clampSharedWith(-1)).toBe(0);
    expect(clampSharedWith(3)).toBe(3);
    expect(clampSharedWith(MAX_SHARED_WITH + 5)).toBe(MAX_SHARED_WITH);
    expect(clampSharedWith(Number.NaN)).toBe(0);
  });

  it('converts a valid typed amount to cents', () => {
    expect(amountCentsOf('49,99')).toBe(4999);
    expect(amountCentsOf('0.1')).toBe(10);
    expect(amountCentsOf('abc')).toBeNull();
  });
});
