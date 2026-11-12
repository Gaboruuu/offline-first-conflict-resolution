import { BillingCycle, Category, MAX_NAME_LENGTH, NewSubscription } from '@/model/Subscription';
import { strings } from '@/strings';

/** Raw form input, exactly as the user typed / picked it. */
export interface SubscriptionFormValues {
  name: string;
  amount: string;
  currency: string;
  billingCycle: BillingCycle;
  nextPaymentDate: string | null;
  category: Category;
  isActive: boolean;
  notes: string;
}

export type FormErrors = Partial<Record<'name' | 'amount' | 'nextPaymentDate', string>>;

export type ValidationResult =
  | { ok: true; subscription: NewSubscription }
  | { ok: false; errors: FormErrors };

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export function validateName(raw: string): string | undefined {
  const name = raw.trim();
  if (name.length === 0) return strings.errorNameRequired;
  if (name.length > MAX_NAME_LENGTH) return strings.errorNameTooLong(MAX_NAME_LENGTH);
  return undefined;
}

export function validateAmount(raw: string): string | undefined {
  const text = raw.trim().replace(',', '.');
  if (text.length === 0) return strings.errorAmountRequired;
  if (!NUMBER.test(text)) return strings.errorAmountInvalid;
  if (Number(text) <= 0) return strings.errorAmountPositive;
  const decimals = text.includes('.') ? text.split('.')[1].length : 0;
  if (decimals > 2) return strings.errorAmountDecimals;
  return undefined;
}

/** Validates every field; returns the subscription to store, or an error message per invalid field. */
export function validateSubscriptionForm(values: SubscriptionFormValues): ValidationResult {
  const errors: FormErrors = {
    name: validateName(values.name),
    amount: validateAmount(values.amount),
    nextPaymentDate: values.nextPaymentDate ? undefined : strings.errorDateRequired,
  };
  if (errors.name || errors.amount || errors.nextPaymentDate) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    subscription: {
      name: values.name.trim(),
      amount: Number(values.amount.trim().replace(',', '.')),
      currency: values.currency,
      billingCycle: values.billingCycle,
      nextPaymentDate: values.nextPaymentDate!,
      category: values.category,
      isActive: values.isActive,
      notes: values.notes.trim(),
    },
  };
}
