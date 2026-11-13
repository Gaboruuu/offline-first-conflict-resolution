/**
 * S3 control: Yjs (https://yjs.dev), a second CRDT library, to check that the S3 results are not specific
 * to Automerge.
 *
 * The root `Y.Map` `subscriptions` holds one `Y.Map` per record. Scalars are plain map values, `tags` is a
 * `Y.Map` `tag → true`, `payments` a `Y.Map` `paymentId → payment`, and `sharedWith` is emulated as a
 * `Y.Map` `replicaId → { p, n }` (a PN-counter: every replica writes only its own entry). A delete removes
 * the record's key. Yjs resolves concurrent writes itself, so `conflicts()` is always empty.
 *
 * Sync: every message carries the sender's state vector; the answer to a known state vector is
 * `encodeStateAsUpdate(doc, remoteVector)`. A delete does not change the state vector, so the replica also
 * keeps a per-peer "dirty" flag, set by every update that did not come from that peer.
 * The Yjs `clientID` is a fixed hash of the replica id, so runs are deterministic.
 */
import * as Y from 'yjs';
import { decodeJson, encodeJson } from '../codec';
import { SCALAR_FIELDS, normalizeDoc, type Payment, type RecordId, type ReplicaId, type SubscriptionDoc } from '../model';
import { validateOp, type Op } from '../ops';
import type { Conflict, Env, Replica, SyncStrategy } from '../strategy';
import { pack, unpack } from './binaryState';

/** 32-bit FNV-1a of the replica id's UTF-8 bytes, used as the Yjs clientID. */
export function clientIdFor(replicaId: ReplicaId): number {
  let h = 0x811c9dc5;
  for (const b of new TextEncoder().encode(replicaId)) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

interface PeerFlags {
  /** Something changed that the peer may not have. */
  dirty: boolean;
  /** The peer asked for an answer (it sent its state vector without an update). */
  requested: boolean;
}

/**
 * Message: `s` = sender's state vector, `u` = update for the recipient (absent in a first request).
 * Framed as one flag byte, a 4-byte big-endian length of `s`, `s`, then `u`: 5 bytes on top of Yjs's own data.
 */
interface Frame {
  s: Uint8Array;
  u?: Uint8Array;
}

function encodeFrame(frame: Frame): Uint8Array {
  const u = frame.u ?? new Uint8Array(0);
  const out = new Uint8Array(5 + frame.s.length + u.length);
  out[0] = frame.u ? 1 : 0;
  new DataView(out.buffer).setUint32(1, frame.s.length);
  out.set(frame.s, 5);
  out.set(u, 5 + frame.s.length);
  return out;
}

function decodeFrame(bytes: Uint8Array): Frame {
  const sLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1);
  const s = bytes.slice(5, 5 + sLength);
  return bytes[0] === 1 ? { s, u: bytes.slice(5 + sLength) } : { s };
}

type Counter = Y.Map<{ p: number; n: number }>;

function toDoc(id: RecordId, record: Y.Map<unknown>): SubscriptionDoc {
  const doc: Record<string, unknown> = { id };
  for (const f of SCALAR_FIELDS) doc[f] = record.get(f);
  doc.tags = [...(record.get('tags') as Y.Map<boolean>).keys()];
  doc.payments = [...(record.get('payments') as Y.Map<Payment>).values()].map((p) => ({ ...p }));
  let sum = 0;
  for (const { p, n } of (record.get('sharedWith') as Counter).values()) sum += p - n;
  doc.sharedWith = sum;
  return normalizeDoc(doc as unknown as SubscriptionDoc);
}

/** True when `local` contains insertions that the holder of `remote` has not seen. */
function ahead(local: Map<number, number>, remote: Map<number, number>): boolean {
  for (const [client, clock] of local) if (clock > (remote.get(client) ?? 0)) return true;
  return false;
}

class YjsReplica implements Replica {
  private readonly doc = new Y.Doc();
  private readonly peers = new Map<ReplicaId, PeerFlags>();
  private readonly peerVectors = new Map<ReplicaId, Uint8Array>();

  constructor(
    readonly replicaId: ReplicaId,
    readonly env: Env,
    saved?: Map<string, Uint8Array>,
  ) {
    if (saved) {
      Y.applyUpdate(this.doc, saved.get('doc')!);
      const flags = decodeJson<Record<ReplicaId, PeerFlags>>(saved.get('peers')!);
      for (const [peer, f] of Object.entries(flags)) this.peers.set(peer, f);
      for (const [name, bytes] of saved) if (name.startsWith('sv:')) this.peerVectors.set(name.slice(3), bytes);
    }
    // Set after loading: Yjs picks a new random clientID when a remote update contains its own client's items.
    this.doc.clientID = clientIdFor(replicaId);
    this.doc.on('update', (_update: Uint8Array, origin: unknown) => {
      for (const [peer, f] of this.peers) if (peer !== origin) f.dirty = true;
    });
  }

  private get subscriptions(): Y.Map<Y.Map<unknown>> {
    return this.doc.getMap('subscriptions');
  }

  private flags(peer: ReplicaId): PeerFlags {
    let f = this.peers.get(peer);
    if (!f) {
      f = { dirty: true, requested: false };
      this.peers.set(peer, f);
    }
    return f;
  }

  apply(op: Op): void {
    const valid = validateOp(op, this.read());
    if (!valid.ok) throw new Error(`invalid op: ${valid.reason}`);
    this.doc.transact(() => {
      const subs = this.subscriptions;
      if (op.kind === 'create') {
        const record = new Y.Map<unknown>();
        subs.set(op.id, record);
        for (const f of SCALAR_FIELDS) record.set(f, op.fields[f]);
        record.set('tags', new Y.Map<boolean>());
        record.set('payments', new Y.Map<Payment>());
        record.set('sharedWith', new Y.Map());
        return;
      }
      if (op.kind === 'delete') {
        subs.delete(op.id);
        return;
      }
      const record = subs.get(op.id)!;
      switch (op.kind) {
        case 'setField':
          record.set(op.field, op.value);
          return;
        case 'addTag':
          (record.get('tags') as Y.Map<boolean>).set(op.tag, true);
          return;
        case 'removeTag': {
          const tags = record.get('tags') as Y.Map<boolean>;
          if (tags.has(op.tag)) tags.delete(op.tag);
          return;
        }
        case 'addPayment': {
          const payments = record.get('payments') as Y.Map<Payment>;
          if (!payments.has(op.payment.id)) payments.set(op.payment.id, { ...op.payment });
          return;
        }
        case 'increment': {
          const counter = record.get('sharedWith') as Counter;
          const own = counter.get(this.replicaId) ?? { p: 0, n: 0 };
          counter.set(this.replicaId, op.by > 0 ? { p: own.p + 1, n: own.n } : { p: own.p, n: own.n + 1 });
          return;
        }
      }
    });
  }

  read(): SubscriptionDoc[] {
    return [...this.subscriptions.entries()]
      .map(([id, record]) => toDoc(id, record))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  conflicts(): Conflict[] {
    return [];
  }

  resolve(conflictId: string): void {
    throw new Error(`yjs never reports conflicts (unknown conflict ${conflictId})`);
  }

  syncMessage(peer: ReplicaId): Uint8Array | null {
    const f = this.flags(peer);
    if (!f.dirty && !f.requested) return null;
    const s = Y.encodeStateVector(this.doc);
    const remote = this.peerVectors.get(peer);
    f.requested = false;
    if (!remote) return encodeFrame({ s }); // first contact: ask for the peer's state vector
    f.dirty = false;
    return encodeFrame({ s, u: Y.encodeStateAsUpdate(this.doc, remote) });
  }

  receive(peer: ReplicaId, message: Uint8Array): void {
    const f = this.flags(peer);
    const { s, u } = decodeFrame(message);
    if (u) Y.applyUpdate(this.doc, u, peer);
    this.peerVectors.set(peer, s);
    if (!u) f.requested = true;
    if (ahead(Y.decodeStateVector(Y.encodeStateVector(this.doc)), Y.decodeStateVector(s))) f.dirty = true;
  }

  save(): Uint8Array {
    const names = ['doc', 'peers'];
    const flags: Record<ReplicaId, PeerFlags> = {};
    for (const peer of [...this.peers.keys()].sort()) flags[peer] = { ...this.peers.get(peer)! };
    const parts = [Y.encodeStateAsUpdate(this.doc), encodeJson(flags)];
    for (const peer of [...this.peerVectors.keys()].sort()) {
      names.push(`sv:${peer}`);
      parts.push(this.peerVectors.get(peer)!);
    }
    return pack('yjs', this.replicaId, names, parts);
  }
}

export const yjsStrategy: SyncStrategy = {
  name: 'yjs',
  create: (replicaId, env) => new YjsReplica(replicaId, env),
  load(bytes, env) {
    const { replicaId, parts } = unpack('yjs', bytes);
    return new YjsReplica(replicaId, env, parts);
  },
};
