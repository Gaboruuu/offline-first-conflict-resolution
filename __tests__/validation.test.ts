import { strings } from '@/strings';
import { dueText } from '@/util/due';
import { addDays, daysBetween, formatDate, isIsoDate } from '@/util/dates';
import { SubscriptionFormValues, validateAmount, validateSubscriptionForm } from '@/util/validation';

const valid: SubscriptionFormValues = {
  name: '  Netflix ',
  amount: '49,99',
  currency: 'RON',
  billingCycle: 'MONTHLY',
  nextPaymentDate: '2026-10-13',
  category: 'ENTERTAINMENT',
  isActive: true,
  notes: ' shared ',
};

describe('validateSubscriptionForm', () => {
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
