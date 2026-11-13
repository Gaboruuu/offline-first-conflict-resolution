import {
  BILLING_CYCLES,
  SCALAR_FIELDS,
  comparePayments,
  isScalarFieldName,
  type Payment,
  type RecordId,
  type ScalarFieldName,
  type ScalarFields,
  type ScalarValue,
  type SubscriptionDoc,
} from './model';

/**
 * Every user intent is one `Op`. The app, the simulator and the oracle speak only in ops.
 * A `create` starts the record with tags = [], payments = [] and sharedWith = 0.
 */
export type Op =
  | { kind: 'create'; id: RecordId; fields: ScalarFields }
  | { kind: 'setField'; id: RecordId; field: ScalarFieldName; value: string | number | boolean }
  | { kind: 'addTag' | 'removeTag'; id: RecordId; tag: string }
  | { kind: 'addPayment'; id: RecordId; payment: Payment }
  | { kind: 'increment'; id: RecordId; by: 1 | -1 }
  | { kind: 'delete'; id: RecordId };

export type OpKind = Op['kind'];

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const OK: ValidationResult = { ok: true };
const fail = (reason: string): ValidationResult => ({ ok: false, reason });

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks that `value` is a legal value for scalar field `field`. */
export function validateFieldValue(field: ScalarFieldName, value: unknown): ValidationResult {
  switch (field) {
    case 'name':
    case 'currency':
    case 'category':
    case 'notes':
      return typeof value === 'string' ? OK : fail(`${field} must be a string`);
    case 'amountCents':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? OK
        : fail('amountCents must be a non-negative integer');
    case 'billingCycle':
      return (BILLING_CYCLES as readonly unknown[]).includes(value)
        ? OK
        : fail(`billingCycle must be one of ${BILLING_CYCLES.join(', ')}`);
    case 'nextPaymentDate':
      return typeof value === 'string' && DATE.test(value) ? OK : fail('nextPaymentDate must be YYYY-MM-DD');
    case 'isActive':
      return typeof value === 'boolean' ? OK : fail('isActive must be a boolean');
  }
}

function validateScalarFields(fields: unknown): ValidationResult {
  if (typeof fields !== 'object' || fields === null) return fail('fields must be an object');
  const record = fields as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isScalarFieldName(key)) return fail(`unknown field ${key}`);
  }
  for (const field of SCALAR_FIELDS) {
    if (!(field in record)) return fail(`missing field ${field}`);
    const result = validateFieldValue(field, record[field]);
    if (!result.ok) return result;
  }
  return OK;
}

function validatePayment(payment: unknown): ValidationResult {
  if (typeof payment !== 'object' || payment === null) return fail('payment must be an object');
  const p = payment as Record<string, unknown>;
  if (typeof p.id !== 'string' || p.id === '') return fail('payment id must be a non-empty string');
  if (typeof p.date !== 'string' || !DATE.test(p.date)) return fail('payment date must be YYYY-MM-DD');
  if (typeof p.amountCents !== 'number' || !Number.isSafeInteger(p.amountCents) || p.amountCents < 0) {
    return fail('payment amountCents must be a non-negative integer');
  }
  return OK;
}

/**
 * Checks an op against the replica's visible records (`read()`).
 * Rejects a `create` of an existing id, any other op on an unknown or deleted record,
 * unknown field names, ill-typed values, empty tags and malformed payments.
 */
export function validateOp(op: Op, docs: readonly SubscriptionDoc[]): ValidationResult {
  if (typeof op.id !== 'string' || op.id === '') return fail('record id must be a non-empty string');
  const exists = docs.some((d) => d.id === op.id);

  if (op.kind === 'create') {
    if (exists) return fail(`record ${op.id} already exists`);
    return validateScalarFields(op.fields);
  }
  if (!exists) return fail(`record ${op.id} does not exist or was deleted`);

  switch (op.kind) {
    case 'setField':
      if (!isScalarFieldName(op.field)) return fail(`unknown field ${String(op.field)}`);
      return validateFieldValue(op.field, op.value);
    case 'addTag':
    case 'removeTag':
      return typeof op.tag === 'string' && op.tag.trim() !== '' ? OK : fail('tag must be a non-empty string');
    case 'addPayment':
      return validatePayment(op.payment);
    case 'increment':
      return op.by === 1 || op.by === -1 ? OK : fail('increment must be by 1 or -1');
    case 'delete':
      return OK;
    default:
      return fail(`unknown op kind ${(op as { kind: unknown }).kind as string}`);
  }
}

/**
 * Applies an op to a plain list of documents, with no replication metadata.
 * This is the sequential reference semantics: strategies must agree with it when there is no concurrency.
 * Returns a new list sorted by id; the input is not modified. Invalid ops throw.
 */
export function applyOpToDocs(docs: readonly SubscriptionDoc[], op: Op): SubscriptionDoc[] {
  const result = validateOp(op, docs);
  if (!result.ok) throw new Error(`invalid op: ${result.reason}`);
  let next: SubscriptionDoc[];
  if (op.kind === 'create') {
    next = [...docs, { ...op.fields, id: op.id, tags: [], payments: [], sharedWith: 0 }];
  } else if (op.kind === 'delete') {
    next = docs.filter((d) => d.id !== op.id);
  } else {
    next = docs.map((d) => (d.id === op.id ? applyToDoc(d, op) : d));
  }
  return next.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function applyToDoc(doc: SubscriptionDoc, op: Exclude<Op, { kind: 'create' | 'delete' }>): SubscriptionDoc {
  switch (op.kind) {
    case 'setField':
      return { ...doc, [op.field]: op.value as ScalarValue };
    case 'addTag':
      return { ...doc, tags: [...new Set([...doc.tags, op.tag])].sort() };
    case 'removeTag':
      return { ...doc, tags: doc.tags.filter((t) => t !== op.tag) };
    case 'addPayment':
      return doc.payments.some((p) => p.id === op.payment.id)
        ? doc
        : {
            ...doc,
            payments: [...doc.payments, { ...op.payment }].sort(comparePayments),
          };
    case 'increment':
      return { ...doc, sharedWith: doc.sharedWith + op.by };
  }
}
