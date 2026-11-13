/**
 * S2: version vectors with field-level merge and surfaced conflicts (Parker et al. 1983).
 *
 * Each record carries a version vector (one event per local write to the record) and, for every field, the
 * set of concurrent versions written to it, each tagged with the dot `(replica, counter)` of its write.
 * `tags`, `payments`, `sharedWith` and `__deleted` are fields like the scalars: a concurrent change to
 * them is a conflict, not a merge.
 *
 * Merging two copies of a record keeps, per field, every version whose dot the other side has not seen,
 * plus the versions both sides have. So if one copy dominates, it is taken as is; if the copies are
 * concurrent, the side whose dot the other has not covered has the newer value; if both sides wrote the
 * field and the values differ, both versions are kept as siblings and the field is reported as a
 * `Conflict`. The visible value is provisional: the version written by the highest replica id.
 *
 * Every edit also writes `__deleted = false`, so an edit concurrent with a delete becomes a conflict on
 * `__deleted`, and the record stays visible until the conflict is resolved.
 */
import { decodeJson, encodeJson, type Json } from '../codec';
import * as vv from '../clock/versionVector';
import type { Dot, VersionVector } from '../clock/versionVector';
import {
  SCALAR_FIELDS,
  normalizeDoc,
  type RecordId,
  type ReplicaId,
  type ScalarFieldName,
  type SubscriptionDoc,
} from '../model';
import { applyOpToDocs, validateOp, type Op } from '../ops';
import type { Conflict, Env, Replica, SyncStrategy } from '../strategy';
import { compareTuple, deepEqual } from '../util';
import { PeerLog, type MessageHeader, type PeerState } from './peerLog';

export type VvField = ScalarFieldName | 'tags' | 'payments' | 'sharedWith' | '__deleted';

const DOC_FIELDS: readonly Exclude<VvField, '__deleted'>[] = [...SCALAR_FIELDS, 'tags', 'payments', 'sharedWith'];
const ALL_FIELDS: readonly VvField[] = [...DOC_FIELDS, '__deleted'];

export interface Version {
  value: Json;
  dot: Dot;
}

export interface VvRecord {
  id: RecordId;
  vv: VersionVector;
  /** Concurrent versions of each field, sorted by (replica, counter). Usually exactly one. */
  fields: Record<VvField, Version[]>;
}

interface VvMessage extends MessageHeader {
  r: VvRecord[];
}

interface VvState {
  strategy: 'vv';
  replicaId: ReplicaId;
  records: Record<RecordId, VvRecord>;
  peers: Record<ReplicaId, PeerState>;
}

const byDot = (a: Version, b: Version) => compareTuple([a.dot.replica, a.dot.counter], [b.dot.replica, b.dot.counter]);
const sameDot = (a: Dot, b: Dot) => a.replica === b.replica && a.counter === b.counter;

/** Siblings that hold the same value are the same answer: keep only the one with the greatest dot. */
function collapse(versions: Version[]): Version[] {
  const sorted = [...versions].sort(byDot);
  const out: Version[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const v = sorted[i]!;
    if (!out.some((o) => deepEqual(o.value, v.value))) out.push(v);
  }
  return out.sort(byDot);
}

/** Merge of one field: keep what the other side has not seen, and what both sides have. */
function mergeField(local: Version[], localVv: VersionVector, remote: Version[], remoteVv: VersionVector): Version[] {
  const keep: Version[] = [];
  for (const l of local) {
    if (!vv.covers(remoteVv, l.dot) || remote.some((r) => sameDot(r.dot, l.dot))) keep.push(l);
  }
  for (const r of remote) {
    if (!vv.covers(localVv, r.dot) && !keep.some((k) => sameDot(k.dot, r.dot))) keep.push(r);
  }
  return collapse(keep);
}

export function mergeRecords(local: VvRecord, remote: VvRecord): VvRecord {
  const fields = {} as Record<VvField, Version[]>;
  for (const f of ALL_FIELDS) fields[f] = mergeField(local.fields[f], local.vv, remote.fields[f], remote.vv);
  return { id: local.id, vv: vv.merge(local.vv, remote.vv), fields };
}

/** The provisional winner among siblings: the version written by the highest replica id. */
function visible(versions: Version[]): Version {
  return versions.reduce((best, v) => (byDot(v, best) > 0 ? v : best));
}

/** A record is hidden only when every version of `__deleted` says so. */
function isDeleted(record: VvRecord): boolean {
  return record.fields.__deleted.every((v) => v.value === true);
}

function toDoc(record: VvRecord): SubscriptionDoc {
  const doc: Record<string, unknown> = { id: record.id };
  for (const f of DOC_FIELDS) doc[f] = visible(record.fields[f]).value;
  return normalizeDoc(doc as unknown as SubscriptionDoc);
}

const conflictId = (recordId: RecordId, field: VvField) => `${recordId}/${field}`;

class VvReplica implements Replica {
  private readonly records: Map<RecordId, VvRecord>;
  private readonly log: PeerLog;

  constructor(
    readonly replicaId: ReplicaId,
    private readonly env: Env,
    state?: VvState,
  ) {
    this.records = new Map(Object.entries(state?.records ?? {}));
    this.log = new PeerLog(() => [...this.records.keys()], state?.peers ?? {});
  }

  /** One local write event on `id` that sets the given fields; returns nothing if there is nothing to write. */
  private write(id: RecordId, values: Partial<Record<VvField, Json>>): void {
    const old = this.records.get(id);
    const clock = vv.increment(old?.vv ?? vv.EMPTY_VV, this.replicaId);
    const dot: Dot = { replica: this.replicaId, counter: vv.get(clock, this.replicaId) };
    const fields = { ...(old?.fields ?? {}) } as Record<VvField, Version[]>;
    for (const [f, value] of Object.entries(values) as [VvField, Json][]) fields[f] = [{ value, dot }];
    this.records.set(id, { id, vv: clock, fields });
    this.log.markDirty(id);
  }

  apply(op: Op): void {
    const docs = this.read();
    const valid = validateOp(op, docs);
    if (!valid.ok) throw new Error(`invalid op: ${valid.reason}`);
    if (op.kind === 'delete') {
      this.write(op.id, { __deleted: true });
      return;
    }
    const after = applyOpToDocs(docs, op).find((d) => d.id === op.id)!;
    const before = docs.find((d) => d.id === op.id);
    const values: Partial<Record<VvField, Json>> = {};
    for (const f of DOC_FIELDS) {
      if (!before || !deepEqual(before[f], after[f])) values[f] = after[f] as unknown as Json;
    }
    if (Object.keys(values).length === 0) return; // e.g. removing a tag that is not there
    values.__deleted = false;
    this.write(op.id, values);
  }

  read(): SubscriptionDoc[] {
    return [...this.records.values()]
      .filter((r) => !isDeleted(r))
      .map(toDoc)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  conflicts(): Conflict[] {
    const out: Conflict[] = [];
    for (const record of this.records.values()) {
      if (isDeleted(record)) continue;
      for (const f of ALL_FIELDS) {
        const versions = record.fields[f];
        if (versions.length < 2) continue;
        out.push({
          id: conflictId(record.id, f),
          recordId: record.id,
          field: f,
          candidates: versions.map((v) => ({ value: v.value, replicaId: v.dot.replica })),
        });
      }
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  resolve(id: string, candidateIndex: number): void {
    const conflict = this.conflicts().find((c) => c.id === id);
    if (!conflict) throw new Error(`unknown conflict ${id}`);
    const candidate = conflict.candidates[candidateIndex];
    if (!candidate) throw new Error(`conflict ${id} has no candidate ${candidateIndex}`);
    const field = id.slice(conflict.recordId.length + 1) as VvField;
    this.write(conflict.recordId, { [field]: candidate.value as Json });
  }

  syncMessage(peer: ReplicaId): Uint8Array | null {
    if (!this.log.hasWork(peer)) return null;
    const ids = this.log.unsent(peer);
    const header = this.log.nextHeader(peer, ids);
    const message: VvMessage = { ...header, r: ids.map((id) => this.records.get(id)!) };
    return encodeJson(message);
  }

  receive(peer: ReplicaId, bytes: Uint8Array): void {
    const message = decodeJson<VvMessage>(bytes);
    if (!this.log.accept(peer, message, message.r.length > 0)) return;
    for (const incoming of message.r) {
      const local = this.records.get(incoming.id);
      const merged = local ? mergeRecords(local, incoming) : incoming;
      if (!local || !deepEqual(merged, local)) {
        this.records.set(incoming.id, merged);
        this.log.markDirty(incoming.id, peer);
      }
      // The sender lacks part of the merged state: send it back so both converge.
      if (deepEqual(merged, incoming)) this.log.markClean(peer, incoming.id);
      else this.log.markDirtyFor(peer, incoming.id);
    }
  }

  save(): Uint8Array {
    const records: Record<RecordId, VvRecord> = {};
    for (const [id, r] of this.records) records[id] = r;
    const state: VvState = { strategy: 'vv', replicaId: this.replicaId, records, peers: this.log.toJSON() };
    return encodeJson(state);
  }
}

export const versionVectorStrategy: SyncStrategy = {
  name: 'vv',
  create: (replicaId, env) => new VvReplica(replicaId, env),
  load(bytes, env) {
    const state = decodeJson<VvState>(bytes);
    if (state.strategy !== 'vv') throw new Error(`not a vv state: ${String(state.strategy)}`);
    return new VvReplica(state.replicaId, env, state);
  },
};
