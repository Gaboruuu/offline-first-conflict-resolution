import { SCALAR_FIELDS, type ScalarFields, type SubscriptionDoc } from '@sync-core/model';
import type { Op } from '@sync-core/ops';

import { CATEGORIES, Category, NewSubscription, Subscription } from '@/model/Subscription';

/**
 * Conversions between the app's model and sync-core's replicated documents, and the translation of
 * the form's edits into ops (Shared design: the app speaks only in ops).
 */

export const toCents = (amount: number): number => Math.round(amount * 100);

/** The visible record of the replica, as the screens show it. */
export function fromDoc(doc: SubscriptionDoc): Subscription {
  return {
    id: doc.id,
    name: doc.name,
    amount: doc.amountCents / 100,
    currency: doc.currency,
    billingCycle: doc.billingCycle,
    nextPaymentDate: doc.nextPaymentDate,
    category: (CATEGORIES as readonly string[]).includes(doc.category) ? (doc.category as Category) : 'OTHER',
    isActive: doc.isActive,
    notes: doc.notes,
    tags: doc.tags,
    payments: doc.payments,
    sharedWith: doc.sharedWith,
  };
}

export function toScalarFields(s: NewSubscription): ScalarFields {
  return {
    name: s.name,
    amountCents: toCents(s.amount),
    currency: s.currency,
    billingCycle: s.billingCycle,
    nextPaymentDate: s.nextPaymentDate,
    category: s.category,
    isActive: s.isActive,
    notes: s.notes,
  };
}

const increments = (id: string, delta: number): Op[] =>
  Array.from({ length: Math.abs(delta) }, () => ({ kind: 'increment', id, by: delta > 0 ? 1 : -1 }) as const);

/** A new subscription: one `create`, then its tags, payments and shared-with count as separate ops. */
export function opsForCreate(id: string, s: NewSubscription): Op[] {
  return [
    { kind: 'create', id, fields: toScalarFields(s) },
    ...[...new Set(s.tags)].map((tag): Op => ({ kind: 'addTag', id, tag })),
    ...s.payments.map((payment): Op => ({ kind: 'addPayment', id, payment: { ...payment } })),
    ...increments(id, s.sharedWith),
  ];
}

/**
 * The ops that turn the record [doc] into the edited values [s]: one `setField` per changed scalar
 * field, `addTag` / `removeTag` per tag, `addPayment` per new payment (the history is append-only, so
 * payments missing from [s] are not removed) and unit `increment`s for the shared-with counter.
 */
export function diffOps(doc: SubscriptionDoc, s: NewSubscription): Op[] {
  const id = doc.id;
  const fields = toScalarFields(s);
  const ops: Op[] = [];
  for (const field of SCALAR_FIELDS) {
    if (fields[field] !== doc[field]) ops.push({ kind: 'setField', id, field, value: fields[field] });
  }
  const before = new Set(doc.tags);
  const after = new Set(s.tags);
  for (const tag of [...after].sort()) if (!before.has(tag)) ops.push({ kind: 'addTag', id, tag });
  for (const tag of [...before].sort()) if (!after.has(tag)) ops.push({ kind: 'removeTag', id, tag });
  const known = new Set(doc.payments.map((p) => p.id));
  for (const payment of s.payments) if (!known.has(payment.id)) ops.push({ kind: 'addPayment', id, payment: { ...payment } });
  ops.push(...increments(id, s.sharedWith - doc.sharedWith));
  return ops;
}
