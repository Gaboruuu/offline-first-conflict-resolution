/** Same rules as the app's form (see the project idea): the server never trusts the client. */

export const BILLING_CYCLES = ['WEEKLY', 'MONTHLY', 'YEARLY'];
export const CATEGORIES = ['ENTERTAINMENT', 'UTILITIES', 'HEALTH_FITNESS', 'EDUCATION', 'WORK', 'OTHER'];
export const CURRENCIES = ['RON', 'EUR', 'USD'];
export const MAX_NAME_LENGTH = 50;
export const MAX_NOTES_LENGTH = 500;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Validates a request body and returns `{ value }` with only the known fields (an `id` sent by the
 * client is ignored: ids are assigned by the server), or `{ errors }` with a message per field.
 */
export function validateSubscription(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: { body: 'Expected a JSON object' } };
  }
  const errors = {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) errors.name = 'Name is required';
  else if (name.length > MAX_NAME_LENGTH) errors.name = `Name must be at most ${MAX_NAME_LENGTH} characters`;

  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) errors.amount = 'Amount must be a number';
  else if (amount <= 0) errors.amount = 'Amount must be greater than 0';
  else if (Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6) errors.amount = 'Use at most 2 decimals';

  const currency = body.currency ?? 'RON';
  if (!CURRENCIES.includes(currency)) errors.currency = `Currency must be one of ${CURRENCIES.join(', ')}`;
  if (!BILLING_CYCLES.includes(body.billingCycle)) {
    errors.billingCycle = `Billing cycle must be one of ${BILLING_CYCLES.join(', ')}`;
  }
  if (!isIsoDate(body.nextPaymentDate)) errors.nextPaymentDate = 'Next payment date must be a YYYY-MM-DD date';
  const category = body.category ?? 'OTHER';
  if (!CATEGORIES.includes(category)) errors.category = `Category must be one of ${CATEGORIES.join(', ')}`;
  const isActive = body.isActive ?? true;
  if (typeof isActive !== 'boolean') errors.isActive = 'isActive must be true or false';
  const notes = body.notes ?? '';
  if (typeof notes !== 'string') errors.notes = 'Notes must be text';
  else if (notes.length > MAX_NOTES_LENGTH) errors.notes = `Notes must be at most ${MAX_NOTES_LENGTH} characters`;

  if (Object.keys(errors).length > 0) return { errors };
  return {
    value: {
      name,
      amount: Math.round(amount * 100) / 100,
      currency,
      billingCycle: body.billingCycle,
      nextPaymentDate: body.nextPaymentDate,
      category,
      isActive,
      notes: notes.trim(),
    },
  };
}
