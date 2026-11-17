/**
 * S4: the type-aware hybrid strategy, the method proposed by the paper.
 *
 * Each field of a record is replicated by the CRDT that fits its class (FIELD_CLASS):
 *   SIMPLE    LWW register ordered by hybrid logical clocks (Kulkarni et al. 2014), so clock skew cannot make
 *             a causally later write lose;
 *   CRITICAL  multi-value register: concurrent writes are kept and surfaced as a Conflict, never dropped;
 *   SET       OR-Set with add-wins semantics (tags);
 *   APPEND    G-Set keyed by payment id;
 *   COUNTER   PN-Counter (sharedWith).
 * A record is a map of such entries with one causal context shared by all its causal fields (Almeida et al.,
 * delta-state CRDTs). Every local op adds one dot to that context. A delete stores the context it has seen as a
 * tombstone: with `editWins` (default) the record stays visible when some edit was not seen by any delete, with
 * `deleteWins` any delete hides it. The record state is a product of CRDTs, hence a CRDT, so replicas converge.
 *
 * Sync is field-level: the per-peer acknowledgement protocol of PeerLog runs on entries (`<record>|<entry>`)
 * instead of records, so a message carries only the entries changed since the peer's last acknowledgement, each
 * with the record's causal context.
 */
import { decodeJson, encodeJson, type Json } from '../codec';
import * as hlc from '../clock/hlc';
import type { Hlc } from '../clock/hlc';
import * as causal from '../crdt/causal';
import type { Ctx, Dot } from '../crdt/causal';
import * as gSet from '../crdt/gSet';
import * as lww from '../crdt/lwwRegister';
import type { LwwRegister, Stamp } from '../crdt/lwwRegister';
import * as mv from '../crdt/mvRegister';
import type { Version } from '../crdt/mvRegister';
import * as pn from '../crdt/pnCounter';
import type { PnCounter } from '../crdt/pnCounter';
import {
  FIELD_CLASS,
  SCALAR_FIELDS,
  normalizeDoc,
  type Payment,
  type RecordId,
  type ReplicaId,
  type ScalarFieldName,
  type SubscriptionDoc,
} from '../model';
import { validateOp, type Op } from '../ops';
import type { Conflict, Env, Replica, SyncStrategy } from '../strategy';
import { deepEqual } from '../util';
import { PeerLog, type MessageHeader, type PeerState } from './peerLog';

export type DeletePolicy = 'editWins' | 'deleteWins';

export interface HybridOptions {
  deletePolicy?: DeletePolicy;
}

/**
 * Entry keys: a scalar field name, `sharedWith`, `__deleted` (tombstone context), `t:<tag>` (OR-Set dots of one
 * tag) and `p:<payment id>` (one G-Set element).
 */
type Entry = LwwRegister<Json> | Version<Json>[] | Dot[] | Omit<Payment, 'id'> | PnCounter | Ctx;

export interface HybridRecord {
  ctx: Ctx;
  e: Record<string, Entry>;
}

interface WireRecord extends HybridRecord {
  id: RecordId;
}

interface HybridMessage extends MessageHeader {
  /** Sender's clock, present when the message carries data. */
  h?: Stamp;
  r: WireRecord[];
}

interface HybridState {
  strategy: 'hybrid';
  replicaId: ReplicaId;
  policy: DeletePolicy;
  clock: Stamp;
  records: Record<RecordId, HybridRecord>;
  peers: Record<ReplicaId, PeerState>;
}

const TAG = 't:';
const PAYMENT = 'p:';
const TOMBSTONE = '__deleted';
/** PeerLog key of a record's causal context, so that a context-only change also reaches every peer. */
const CTX = '__ctx';
const SEP = '|';

const isCritical = (f: string) => FIELD_CLASS[f as ScalarFieldName] === 'CRITICAL';
const isSimple = (f: string) => FIELD_CLASS[f as ScalarFieldName] === 'SIMPLE';

/** Join of one entry; `lc` and `rc` are the causal contexts of the two record states. */
export function mergeEntry(key: string, l: Entry | undefined, lc: Ctx, r: Entry | undefined, rc: Ctx): Entry | undefined {
  if (isCritical(key)) return mv.joinVersions((l ?? []) as Version<Json>[], lc, (r ?? []) as Version<Json>[], rc);
  if (key.startsWith(TAG)) return causal.joinDots((l ?? []) as Dot[], lc, (r ?? []) as Dot[], rc);
  if (l === undefined) return r;
  if (r === undefined) return l;
  if (isSimple(key)) return lww.merge(l as LwwRegister<Json>, r as LwwRegister<Json>);
  if (key.startsWith(PAYMENT)) return gSet.mergeElement(l, r);
  if (key === 'sharedWith') return pn.merge(l as PnCounter, r as PnCounter);
  if (key === TOMBSTONE) return causal.merge(l as Ctx, r as Ctx);
  throw new Error(`unknown entry ${key}`);
}

class HybridReplica implements Replica {
  private readonly records: Map<RecordId, HybridRecord>;
  private readonly log: PeerLog;
  private clock: Hlc;

  constructor(
    readonly replicaId: ReplicaId,
    private readonly env: Env,
    private readonly policy: DeletePolicy,
    state?: HybridState,
  ) {
    this.records = new Map(Object.entries(state?.records ?? {}));
    this.clock = state ? lww.fromStamp(state.clock) : hlc.initialHlc(replicaId);
    this.log = new PeerLog(() => this.allKeys(), state?.peers ?? {});
  }

  private allKeys(): string[] {
    const out: string[] = [];
    for (const [id, rec] of this.records) {
      out.push(id + SEP + CTX);
      for (const k of Object.keys(rec.e)) out.push(id + SEP + k);
    }
    return out;
  }

  private isVisible(rec: HybridRecord): boolean {
    for (const f of SCALAR_FIELDS) {
      const entry = rec.e[f];
      if (entry === undefined || (isCritical(f) && (entry as Version<Json>[]).length === 0)) return false;
    }
    const tomb = rec.e[TOMBSTONE] as Ctx | undefined;
    if (!tomb) return true;
    return this.policy === 'editWins' ? !causal.covers(tomb, rec.ctx) : false;
  }

  private toDoc(id: RecordId, rec: HybridRecord): SubscriptionDoc {
    const doc: Record<string, unknown> = { id, tags: [], payments: [], sharedWith: 0 };
    for (const f of SCALAR_FIELDS) {
      doc[f] = isCritical(f) ? mv.winner(rec.e[f] as Version<Json>[])!.v : (rec.e[f] as LwwRegister<Json>).v;
    }
    const tags: string[] = [];
    const payments: Payment[] = [];
    for (const [k, entry] of Object.entries(rec.e)) {
      if (k.startsWith(TAG) && (entry as Dot[]).length > 0) tags.push(k.slice(TAG.length));
      else if (k.startsWith(PAYMENT)) payments.push({ id: k.slice(PAYMENT.length), ...(entry as Omit<Payment, 'id'>) });
    }
    doc.tags = tags;
    doc.payments = payments;
    if (rec.e.sharedWith) doc.sharedWith = pn.value(rec.e.sharedWith as PnCounter);
    return normalizeDoc(doc as unknown as SubscriptionDoc);
  }

  apply(op: Op): void {
    const valid = validateOp(op, this.read());
    if (!valid.ok) throw new Error(`invalid op: ${valid.reason}`);
    const old = this.records.get(op.id);
    const rec: HybridRecord = { ctx: old?.ctx ?? causal.EMPTY_CTX, e: { ...(old?.e ?? {}) } };
    const tagKey = 'tag' in op ? TAG + op.tag : '';
    if (op.kind === 'removeTag' && ((rec.e[tagKey] as Dot[] | undefined) ?? []).length === 0) return;
    if (op.kind === 'addPayment' && rec.e[PAYMENT + op.payment.id] !== undefined) return;

    this.clock = hlc.send(this.clock, this.env.now());
    const stamp = lww.toStamp(this.clock);
    const dot = causal.next(rec.ctx, this.replicaId);
    const changed: string[] = [];
    const set = (key: string, entry: Entry) => {
      rec.e[key] = entry;
      changed.push(key);
    };
    const setScalar = (field: ScalarFieldName, value: Json) =>
      set(field, isCritical(field) ? [{ v: value, d: dot, s: stamp }] : lww.write(value, stamp));

    switch (op.kind) {
      case 'create':
        for (const f of SCALAR_FIELDS) setScalar(f, op.fields[f]);
        break;
      case 'setField':
        setScalar(op.field, op.value);
        break;
      case 'addTag':
        set(tagKey, [dot]);
        break;
      case 'removeTag':
        set(tagKey, []);
        break;
      case 'addPayment':
        set(PAYMENT + op.payment.id, { date: op.payment.date, amountCents: op.payment.amountCents });
        break;
      case 'increment':
        set('sharedWith', pn.increment((rec.e.sharedWith as PnCounter | undefined) ?? pn.EMPTY, this.replicaId, op.by).state);
        break;
      case 'delete':
        set(TOMBSTONE, causal.merge((rec.e[TOMBSTONE] as Ctx | undefined) ?? causal.EMPTY_CTX, rec.ctx));
        break;
    }
    if (op.kind !== 'delete') {
      rec.ctx = causal.add(rec.ctx, dot);
      changed.push(CTX);
    }
    this.records.set(op.id, rec);
    for (const k of changed) this.log.markDirty(op.id + SEP + k);
  }

  read(): SubscriptionDoc[] {
    const out: SubscriptionDoc[] = [];
    for (const [id, rec] of this.records) if (this.isVisible(rec)) out.push(this.toDoc(id, rec));
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  conflicts(): Conflict[] {
    const out: Conflict[] = [];
    for (const [id, rec] of this.records) {
      if (!this.isVisible(rec)) continue;
      for (const f of SCALAR_FIELDS) {
        if (!isCritical(f)) continue;
        const candidates = mv.candidates(rec.e[f] as Version<Json>[]);
        if (candidates.length < 2) continue;
        out.push({
          id: `${id}/${f}`,
          recordId: id,
          field: f,
          candidates: candidates.map((c) => ({ value: c.v, replicaId: c.d[0] })),
        });
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  resolve(conflictId: string, candidateIndex: number): void {
    const conflict = this.conflicts().find((c) => c.id === conflictId);
    if (!conflict) throw new Error(`unknown conflict ${conflictId}`);
    const candidate = conflict.candidates[candidateIndex];
    if (!candidate) throw new Error(`conflict ${conflictId} has no candidate ${candidateIndex}`);
    const field = conflict.field as ScalarFieldName;
    this.apply({ kind: 'setField', id: conflict.recordId, field, value: candidate.value as string | number | boolean });
  }

  syncMessage(peer: ReplicaId): Uint8Array | null {
    if (!this.log.hasWork(peer)) return null;
    const keys = this.log.unsent(peer);
    const header = this.log.nextHeader(peer, keys);
    const byRecord = new Map<RecordId, WireRecord>();
    for (const key of keys) {
      const i = key.indexOf(SEP);
      const id = key.slice(0, i);
      const k = key.slice(i + 1);
      const rec = this.records.get(id)!;
      let wire = byRecord.get(id);
      if (!wire) {
        wire = { id, ctx: rec.ctx, e: {} };
        byRecord.set(id, wire);
      }
      if (k !== CTX) wire.e[k] = rec.e[k]!;
    }
    const r = [...byRecord.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const message: HybridMessage = r.length > 0 ? { ...header, h: lww.toStamp(this.clock), r } : { ...header, r };
    return encodeJson(message);
  }

  receive(peer: ReplicaId, bytes: Uint8Array): void {
    const message = decodeJson<HybridMessage>(bytes);
    if (!this.log.accept(peer, message, message.r.length > 0)) return;
    if (message.h) this.clock = hlc.receive(this.clock, lww.fromStamp(message.h), this.env.now());
    for (const incoming of message.r) {
      const local = this.records.get(incoming.id) ?? { ctx: causal.EMPTY_CTX, e: {} };
      const rec: HybridRecord = { ctx: causal.merge(local.ctx, incoming.ctx), e: { ...local.e } };
      const track = (k: string, before: unknown, after: unknown, theirs: unknown) => {
        const key = incoming.id + SEP + k;
        if (!deepEqual(before, after)) this.log.markDirty(key, peer);
        // The sender lacks part of the merged entry: send it back so both converge.
        if (deepEqual(after, theirs)) this.log.markClean(peer, key);
        else this.log.markDirtyFor(peer, key);
      };
      for (const [k, theirs] of Object.entries(incoming.e)) {
        const merged = mergeEntry(k, local.e[k], local.ctx, theirs, incoming.ctx)!;
        rec.e[k] = merged;
        track(k, local.e[k], merged, theirs);
      }
      this.records.set(incoming.id, rec);
      track(CTX, local.ctx, rec.ctx, incoming.ctx);
    }
  }

  save(): Uint8Array {
    const records: Record<RecordId, HybridRecord> = {};
    for (const [id, r] of this.records) records[id] = r;
    const state: HybridState = {
      strategy: 'hybrid',
      replicaId: this.replicaId,
      policy: this.policy,
      clock: lww.toStamp(this.clock),
      records,
      peers: this.log.toJSON(),
    };
    return encodeJson(state);
  }
}

/** S4 with the given delete policy. The registered strategy is `hybridStrategy` (edit wins). */
export function createHybridStrategy(options: HybridOptions = {}): SyncStrategy {
  const policy = options.deletePolicy ?? 'editWins';
  return {
    name: 'hybrid',
    create: (replicaId, env) => new HybridReplica(replicaId, env, policy),
    load(bytes, env) {
      const state = decodeJson<HybridState>(bytes);
      if (state.strategy !== 'hybrid') throw new Error(`not a hybrid state: ${String(state.strategy)}`);
      return new HybridReplica(state.replicaId, env, state.policy, state);
    },
  };
}

export const hybridStrategy: SyncStrategy = createHybridStrategy();
