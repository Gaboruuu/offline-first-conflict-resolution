/**
 * Ground-truth oracle. From the op log, the causal history (`seen`) and the final replicas it gives every op
 * exactly one outcome and computes the conflict metrics of the paper (Shared design, "Metrics and oracle").
 *
 *   preserved   its effect is visible in the final state
 *   superseded  not visible, but a later op B with A -> B on the same target legitimately replaced it
 *   surfaced    not the visible value, but present as a candidate in conflicts()
 *   lost        none of the above
 *   ambiguous   concurrent add/remove of the same tag, or concurrent edit/delete of a record: a policy choice,
 *               reported separately and never counted as lost
 *
 * The oracle judges values, not provenance: an op whose value is visible counts as preserved even if another op
 * wrote the same value. Counter ops are judged together per record (see judgeCounter). Setup ops (initial data)
 * and ops the replica rejected are never judged.
 */
import {
  FIELD_CLASS,
  SCALAR_FIELDS,
  deepEqual,
  type Conflict,
  type FieldClass,
  type Op,
  type SubscriptionDoc,
} from '../../packages/sync-core/src/index';
import { concurrent, happenedBefore } from './causality';
import type { OpRecord, ReplicaView } from './world';

export type Outcome = 'preserved' | 'superseded' | 'surfaced' | 'lost' | 'ambiguous';

export const OUTCOMES: readonly Outcome[] = ['preserved', 'superseded', 'surfaced', 'lost', 'ambiguous'];

/** Field class of an op for the per-type breakdown (RQ3); create and delete act on the whole record. */
export type OpClass = FieldClass | 'RECORD';

export const OP_CLASSES: readonly OpClass[] = ['SIMPLE', 'CRITICAL', 'SET', 'APPEND', 'COUNTER', 'RECORD'];

export function opClass(op: Op): OpClass {
  switch (op.kind) {
    case 'setField':
      return FIELD_CLASS[op.field];
    case 'addTag':
    case 'removeTag':
      return 'SET';
    case 'addPayment':
      return 'APPEND';
    case 'increment':
      return 'COUNTER';
    case 'create':
    case 'delete':
      return 'RECORD';
  }
}

export type OutcomeCounts = Record<Outcome, number> & { ops: number };

export interface OracleMetrics extends OutcomeCounts {
  lossRate: number;
  /** null when no op had a concurrent op on the same record. */
  concurrentLossRate: number | null;
  surfacedRate: number;
  causalViolations: number;
  converged: boolean;
  /** Ops with at least one concurrent op on the same record. */
  concurrentOps: number;
  /** Ops valid in the client's shadow state that the strategy's replica refused (not judged). */
  rejectedOps: number;
}

export interface OracleResult {
  outcomes: Map<string, Outcome>;
  metrics: OracleMetrics;
  byClass: Record<OpClass, OutcomeCounts>;
}

export interface OracleInput {
  log: readonly OpRecord[];
  /** The replica the outcomes are judged on (the server). */
  final: ReplicaView;
  /** Every replica, for `converged`. */
  views: readonly ReplicaView[];
}

function emptyCounts(): OutcomeCounts {
  return { ops: 0, preserved: 0, superseded: 0, surfaced: 0, lost: 0, ambiguous: 0 };
}

const isEdit = (r: OpRecord): boolean => r.op.kind !== 'create' && r.op.kind !== 'delete';

/** Does op `b` replace the effect of op `a` on the same target? (Same record is checked by the caller.) */
function sameTarget(a: Op, b: Op): boolean {
  if (b.kind === 'delete') return a.kind !== 'delete';
  switch (a.kind) {
    case 'setField':
      return b.kind === 'setField' && b.field === a.field;
    case 'addTag':
    case 'removeTag':
      return (b.kind === 'addTag' || b.kind === 'removeTag') && b.tag === a.tag;
    default:
      // create (its presence), payments and counter increments are only replaced by a delete.
      return false;
  }
}

function visible(op: Op, doc: SubscriptionDoc | undefined): boolean {
  switch (op.kind) {
    case 'create':
      return doc !== undefined;
    case 'delete':
      return doc === undefined;
    case 'setField':
      return doc !== undefined && deepEqual(doc[op.field], op.value);
    case 'addTag':
      return doc !== undefined && doc.tags.includes(op.tag);
    case 'removeTag':
      return doc !== undefined && !doc.tags.includes(op.tag);
    case 'addPayment':
      return doc !== undefined && doc.payments.some((p) => deepEqual(p, op.payment));
    case 'increment':
      throw new Error('counter ops are judged per record');
  }
}

function surfaced(op: Op, conflicts: readonly Conflict[]): boolean {
  const values = (field: Conflict['field']): unknown[] =>
    conflicts.filter((c) => c.field === field).flatMap((c) => c.candidates.map((x) => x.value));
  switch (op.kind) {
    case 'setField':
      return values(op.field).some((v) => deepEqual(v, op.value));
    case 'delete':
      return values('__deleted').some((v) => v === true);
    case 'addTag':
      return values('tags').some((v) => Array.isArray(v) && v.includes(op.tag));
    case 'removeTag':
      return values('tags').some((v) => Array.isArray(v) && !v.includes(op.tag));
    case 'addPayment':
      return values('payments').some((v) => Array.isArray(v) && v.some((p) => deepEqual(p, op.payment)));
    default:
      return false;
  }
}

/** Is `r` one side of a concurrent edit/delete or a concurrent add/remove of the same tag? */
function isAmbiguous(r: OpRecord, others: readonly OpRecord[]): boolean {
  return others.some((o) => {
    if (!concurrent(r, o)) return false;
    if (r.op.kind === 'delete') return isEdit(o);
    if (o.op.kind === 'delete') return isEdit(r);
    if (r.op.kind === 'addTag' && o.op.kind === 'removeTag') return r.op.tag === o.op.tag;
    if (r.op.kind === 'removeTag' && o.op.kind === 'addTag') return r.op.tag === o.op.tag;
    return false;
  });
}

/**
 * Counter ops of one record, judged together. With unit increments, `lost = |expected − actual|`, where expected
 * is the sum of every applied increment. When the record has conflicts on sharedWith (S2), the candidate closest
 * to the expected sum counts as surfaced. The lost (then surfaced) count is attributed to concrete ops, preferring
 * ops with a concurrent op on the record (loss only arises from concurrency), then the latest ones.
 */
function judgeCounter(
  incs: readonly OpRecord[],
  judged: readonly OpRecord[],
  doc: SubscriptionDoc,
  conflicts: readonly Conflict[],
  hasConcurrent: (r: OpRecord) => boolean,
  out: Map<string, Outcome>,
): void {
  const expected = incs.reduce((sum, r) => sum + (r.op.kind === 'increment' ? r.op.by : 0), 0);
  const diff = Math.abs(expected - doc.sharedWith);
  const candidates = conflicts
    .filter((c) => c.field === 'sharedWith')
    .flatMap((c) => c.candidates.map((x) => x.value))
    .filter((v): v is number => typeof v === 'number');
  const best = candidates.length > 0 ? Math.min(diff, ...candidates.map((v) => Math.abs(expected - v))) : diff;
  const order = [...judged].sort(
    (a, b) => Number(hasConcurrent(b)) - Number(hasConcurrent(a)) || b.t - a.t || (a.id < b.id ? -1 : 1),
  );
  const lost = Math.min(best, order.length);
  const surfacedCount = Math.min(diff - best, order.length - lost);
  order.forEach((r, i) => out.set(r.id, i < lost ? 'lost' : i < lost + surfacedCount ? 'surfaced' : 'preserved'));
}

/**
 * Fields whose final value comes only from ops that were causally overwritten: some op A wrote the visible
 * value, but a later op B with A -> B wrote the same field (a stale write won).
 */
function causalViolations(byRecord: Map<string, OpRecord[]>, docs: readonly SubscriptionDoc[]): number {
  let count = 0;
  for (const doc of docs) {
    const ops = byRecord.get(doc.id) ?? [];
    for (const field of SCALAR_FIELDS) {
      const writers = ops.filter(
        (r) => r.op.kind === 'create' || (r.op.kind === 'setField' && r.op.field === field),
      );
      const value = (r: OpRecord): unknown =>
        r.op.kind === 'create' ? r.op.fields[field] : r.op.kind === 'setField' ? r.op.value : undefined;
      const sources = writers.filter((r) => deepEqual(value(r), doc[field]));
      if (sources.length === 0) continue;
      const stale = sources.every((a) =>
        writers.some((b) => b !== a && b.op.kind === 'setField' && happenedBefore(a, b)),
      );
      if (stale) count++;
    }
  }
  return count;
}

export function judge(input: OracleInput): OracleResult {
  const applied = input.log.filter((r) => r.status === 'applied');
  const byRecord = new Map<string, OpRecord[]>();
  for (const r of applied) {
    const list = byRecord.get(r.op.id);
    if (list) list.push(r);
    else byRecord.set(r.op.id, [r]);
  }
  const docs = new Map(input.final.docs.map((d) => [d.id, d]));
  const outcomes = new Map<string, Outcome>();
  const concurrentIds = new Set<string>();

  for (const [recordId, ops] of byRecord) {
    const doc = docs.get(recordId);
    const conflicts = input.final.conflicts.filter((c) => c.recordId === recordId);
    for (const r of ops) if (ops.some((o) => concurrent(r, o))) concurrentIds.add(r.id);
    const hasConcurrent = (r: OpRecord): boolean => concurrentIds.has(r.id);
    const toJudge = ops.filter((r) => !r.setup);

    const pendingCounter: OpRecord[] = [];
    for (const r of toJudge) {
      if (isAmbiguous(r, ops)) {
        outcomes.set(r.id, 'ambiguous');
        continue;
      }
      if (r.op.kind === 'increment') {
        if (doc) pendingCounter.push(r);
        else outcomes.set(r.id, ops.some((b) => b.op.kind === 'delete' && happenedBefore(r, b)) ? 'superseded' : 'lost');
        continue;
      }
      if (visible(r.op, doc)) outcomes.set(r.id, 'preserved');
      else if (ops.some((b) => b !== r && sameTarget(r.op, b.op) && happenedBefore(r, b))) outcomes.set(r.id, 'superseded');
      else if (surfaced(r.op, conflicts)) outcomes.set(r.id, 'surfaced');
      else outcomes.set(r.id, 'lost');
    }
    if (doc && pendingCounter.length > 0) {
      const incs = ops.filter((r) => r.op.kind === 'increment');
      judgeCounter(incs, pendingCounter, doc, conflicts, hasConcurrent, outcomes);
    }
  }

  const total = emptyCounts();
  const byClass = Object.fromEntries(OP_CLASSES.map((c) => [c, emptyCounts()])) as Record<OpClass, OutcomeCounts>;
  let concurrentOps = 0;
  let concurrentLost = 0;
  for (const r of applied) {
    const o = outcomes.get(r.id);
    if (o === undefined) continue;
    total.ops++;
    total[o]++;
    const c = byClass[opClass(r.op)];
    c.ops++;
    c[o]++;
    if (concurrentIds.has(r.id)) {
      concurrentOps++;
      if (o === 'lost') concurrentLost++;
    }
  }
  const first = input.views[0];
  const converged =
    first !== undefined &&
    input.views.every((v) => deepEqual(v.docs, first.docs) && deepEqual(v.conflicts, first.conflicts));

  return {
    outcomes,
    byClass,
    metrics: {
      ...total,
      lossRate: total.ops === 0 ? 0 : total.lost / total.ops,
      concurrentLossRate: concurrentOps === 0 ? null : concurrentLost / concurrentOps,
      surfacedRate: total.ops === 0 ? 0 : total.surfaced / total.ops,
      causalViolations: causalViolations(byRecord, input.final.docs),
      converged,
      concurrentOps,
      rejectedOps: input.log.filter((r) => r.status === 'rejected' && !r.setup).length,
    },
  };
}
