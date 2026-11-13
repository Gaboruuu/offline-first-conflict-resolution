/**
 * S1: last-write-wins on whole records.
 *
 * Every local op rewrites the whole record and stamps it with the replica's wall clock `env.now()`.
 * Replicas keep, for each record, the envelope with the greatest `(ts, replica, n)`; the losing record is
 * discarded entirely, even when the two writes touched different fields. There is deliberately no logical
 * clock: a replica whose clock runs behind loses its writes (RQ1). `n` is a per-replica write counter that
 * only breaks ties between two writes of the same replica with the same timestamp.
 */
import { decodeJson, encodeJson } from '../codec';
import { normalizeDoc, type RecordId, type ReplicaId, type SubscriptionDoc } from '../model';
import { applyOpToDocs, validateOp, type Op } from '../ops';
import type { Conflict, Env, Replica, SyncStrategy } from '../strategy';
import { compareTuple } from '../util';
import { PeerLog, type MessageHeader, type PeerState } from './peerLog';

export interface LwwEnvelope {
  id: RecordId;
  /** The record, or null once deleted (tombstone). */
  doc: SubscriptionDoc | null;
  /** Wall-clock time of the write on the writing replica (possibly skewed). */
  ts: number;
  replica: ReplicaId;
  /** Write counter of `replica`, tie-breaker only. */
  n: number;
  deleted: boolean;
}

interface LwwMessage extends MessageHeader {
  r: LwwEnvelope[];
}

interface LwwState {
  strategy: 'lww';
  replicaId: ReplicaId;
  writes: number;
  records: Record<RecordId, LwwEnvelope>;
  peers: Record<ReplicaId, PeerState>;
}

/** Positive when `a` wins over `b`. */
export function compareEnvelopes(a: LwwEnvelope, b: LwwEnvelope): number {
  return compareTuple([a.ts, a.replica, a.n], [b.ts, b.replica, b.n]);
}

class LwwReplica implements Replica {
  private readonly records: Map<RecordId, LwwEnvelope>;
  private readonly log: PeerLog;
  private writes: number;

  constructor(
    readonly replicaId: ReplicaId,
    private readonly env: Env,
    state?: LwwState,
  ) {
    this.records = new Map(Object.entries(state?.records ?? {}));
    this.writes = state?.writes ?? 0;
    this.log = new PeerLog(() => [...this.records.keys()], state?.peers ?? {});
  }

  apply(op: Op): void {
    const visible = this.read();
    const valid = validateOp(op, visible);
    if (!valid.ok) throw new Error(`invalid op: ${valid.reason}`);
    const doc = applyOpToDocs(visible, op).find((d) => d.id === op.id) ?? null;
    this.writes += 1;
    this.records.set(op.id, {
      id: op.id,
      doc,
      ts: this.env.now(),
      replica: this.replicaId,
      n: this.writes,
      deleted: doc === null,
    });
    this.log.markDirty(op.id);
  }

  read(): SubscriptionDoc[] {
    return [...this.records.values()]
      .filter((e) => !e.deleted && e.doc !== null)
      .map((e) => normalizeDoc(e.doc!))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  conflicts(): Conflict[] {
    return [];
  }

  resolve(conflictId: string): void {
    throw new Error(`lww never reports conflicts (unknown conflict ${conflictId})`);
  }

  syncMessage(peer: ReplicaId): Uint8Array | null {
    if (!this.log.hasWork(peer)) return null;
    const ids = this.log.unsent(peer);
    const header = this.log.nextHeader(peer, ids);
    const message: LwwMessage = { ...header, r: ids.map((id) => this.records.get(id)!) };
    return encodeJson(message);
  }

  receive(peer: ReplicaId, bytes: Uint8Array): void {
    const message = decodeJson<LwwMessage>(bytes);
    if (!this.log.accept(peer, message, message.r.length > 0)) return;
    for (const incoming of message.r) {
      const local = this.records.get(incoming.id);
      const order = local ? compareEnvelopes(incoming, local) : 1;
      if (order > 0) {
        this.records.set(incoming.id, incoming);
        this.log.markDirty(incoming.id, peer);
        this.log.markClean(peer, incoming.id);
      } else if (order < 0) {
        // The sender holds a losing version: send it the winner so that both converge.
        this.log.markDirtyFor(peer, incoming.id);
      }
    }
  }

  save(): Uint8Array {
    const records: Record<RecordId, LwwEnvelope> = {};
    for (const [id, e] of this.records) records[id] = e;
    const state: LwwState = {
      strategy: 'lww',
      replicaId: this.replicaId,
      writes: this.writes,
      records,
      peers: this.log.toJSON(),
    };
    return encodeJson(state);
  }
}

export const lwwStrategy: SyncStrategy = {
  name: 'lww',
  create: (replicaId, env) => new LwwReplica(replicaId, env),
  load(bytes, env) {
    const state = decodeJson<LwwState>(bytes);
    if (state.strategy !== 'lww') throw new Error(`not an lww state: ${String(state.strategy)}`);
    return new LwwReplica(state.replicaId, env, state);
  },
};
