/**
 * Initial datasets. A dataset file lists the clients of a scenario and the records the server holds before the
 * scenario starts, as plain documents. `datasetOps` turns the documents into the ops that build them (create,
 * then tags, payments and counter increments), because the simulator loads initial data as setup ops.
 */
import { readFileSync } from 'node:fs';
import {
  SCALAR_FIELDS,
  normalizeDoc,
  type Op,
  type ScalarFields,
  type SubscriptionDoc,
} from '../../packages/sync-core/src/index';

export interface Dataset {
  clients: string[];
  subscriptions: SubscriptionDoc[];
}

export function parseDataset(value: unknown): Dataset {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('dataset must be an object');
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.clients) || !v.clients.every((c) => typeof c === 'string' && c !== '' && c !== 'server')) {
    throw new Error('dataset.clients must be a list of client ids');
  }
  if (!Array.isArray(v.subscriptions)) throw new Error('dataset.subscriptions must be a list');
  return { clients: v.clients as string[], subscriptions: v.subscriptions as SubscriptionDoc[] };
}

export function loadDataset(path: string): Dataset {
  return parseDataset(JSON.parse(readFileSync(path, 'utf8')));
}

/** The ops that build `docs` from an empty state, in a fixed order (records by id, then their contents). */
export function datasetOps(docs: readonly SubscriptionDoc[]): Op[] {
  const ops: Op[] = [];
  const sorted = [...docs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const doc of sorted) {
    const fields = Object.fromEntries(SCALAR_FIELDS.map((f) => [f, doc[f]])) as unknown as ScalarFields;
    ops.push({ kind: 'create', id: doc.id, fields });
    const d = normalizeDoc(doc);
    for (const tag of d.tags) ops.push({ kind: 'addTag', id: doc.id, tag });
    for (const payment of d.payments) ops.push({ kind: 'addPayment', id: doc.id, payment: { ...payment } });
    if (!Number.isSafeInteger(d.sharedWith) || d.sharedWith < 0) throw new Error(`bad sharedWith in ${doc.id}`);
    for (let i = 0; i < d.sharedWith; i++) ops.push({ kind: 'increment', id: doc.id, by: 1 });
  }
  return ops;
}
