import type { Payment } from '@sync-core/model';
import type { Conflict } from '@sync-core/strategy';

import { BILLING_CYCLE_INFO, BillingCycle, CATEGORY_LABELS, Category, Subscription } from '@/model/Subscription';
import { strings } from '@/strings';
import { formatDate } from '@/util/dates';
import { formatMoney } from '@/util/money';

/** A conflict as the conflict screen shows it. */
export interface ConflictView {
  readonly id: string;
  /** Name of the subscription (or a placeholder when it is not visible). */
  readonly title: string;
  /** Which value is disputed, e.g. "Price". */
  readonly field: string;
  readonly candidates: readonly { readonly value: string; readonly origin: string }[];
}

const FIELD_LABELS: Record<string, string> = {
  name: strings.labelName,
  amountCents: strings.conflictFieldPrice,
  currency: strings.labelCurrency,
  billingCycle: strings.labelBillingCycle,
  nextPaymentDate: strings.labelNextPayment,
  category: strings.labelCategory,
  isActive: strings.labelActive,
  notes: strings.conflictFieldNotes,
  tags: strings.labelTags,
  payments: strings.labelPayments,
  sharedWith: strings.labelSharedWith,
  __deleted: strings.conflictFieldDeleted,
};

/** One candidate value, formatted for the user (amounts in the record's currency). */
export function formatCandidate(field: string, value: unknown, currency: string): string {
  switch (field) {
    case 'amountCents':
      return typeof value === 'number' ? formatMoney(value / 100, currency) : String(value);
    case 'nextPaymentDate':
      return typeof value === 'string' ? formatDate(value) : String(value);
    case 'billingCycle':
      return BILLING_CYCLE_INFO[value as BillingCycle]?.label ?? String(value);
    case 'category':
      return CATEGORY_LABELS[value as Category] ?? String(value);
    case 'isActive':
      return value ? strings.conflictActive : strings.conflictPaused;
    case 'tags':
      return Array.isArray(value) && value.length > 0 ? value.map((t) => `#${t}`).join(' ') : strings.conflictNoTags;
    case 'payments':
      return Array.isArray(value) ? strings.conflictPayments((value as Payment[]).length) : String(value);
    case 'sharedWith':
      return typeof value === 'number' ? strings.sharedWithValue(value) : String(value);
    case '__deleted':
      return value === true ? strings.conflictDeleted : strings.conflictKept;
    case 'notes':
      return typeof value === 'string' && value.trim() !== '' ? `“${value}”` : strings.conflictEmpty;
    default:
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/** "Price: 49.99 RON on this device, 54.99 RON on another device" as data for the screen. */
export function describeConflict(conflict: Conflict, record: Subscription | undefined, replicaId: string | null): ConflictView {
  const currency = record?.currency ?? '';
  return {
    id: conflict.id,
    title: record?.name ?? strings.conflictUnknownRecord,
    field: FIELD_LABELS[conflict.field] ?? conflict.field,
    candidates: conflict.candidates.map((c) => ({
      value: formatCandidate(conflict.field, c.value, currency),
      origin: c.replicaId === replicaId ? strings.conflictThisDevice : strings.conflictOtherDevice,
    })),
  };
}
