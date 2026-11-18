import {
  BillingCycle,
  Category,
  MAX_NAME_LENGTH,
  MAX_SHARED_WITH,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  NewSubscription,
  normalizeTag,
  Payment,
} from '@/model/Subscription';
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
  tags: readonly string[];
  payments: readonly Payment[];
  sharedWith: number;
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

/** Checks a tag the user is about to add to [existing]; the tag is normalised first (see normalizeTag). */
export function validateTag(raw: string, existing: readonly string[]): string | undefined {
  const tag = normalizeTag(raw);
  if (tag.length === 0) return strings.errorTagRequired;
  if (tag.length > MAX_TAG_LENGTH) return strings.errorTagTooLong(MAX_TAG_LENGTH);
  if (existing.includes(tag)) return strings.errorTagDuplicate;
  if (existing.length >= MAX_TAGS) return strings.errorTooManyTags(MAX_TAGS);
  return undefined;
}

/** The shared-with stepper's value, kept a whole number between 0 and MAX_SHARED_WITH. */
export function clampSharedWith(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SHARED_WITH, Math.max(0, Math.round(value)));
}

/** Amount typed in the form, in cents (for a payment), or null while it is not a valid amount. */
export function amountCentsOf(raw: string): number | null {
  if (validateAmount(raw)) return null;
  return Math.round(Number(raw.trim().replace(',', '.')) * 100);
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
      tags: [...new Set(values.tags.map(normalizeTag).filter((t) => t.length > 0))].sort(),
      payments: [...values.payments].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),
      sharedWith: clampSharedWith(values.sharedWith),
    },
  };
}
