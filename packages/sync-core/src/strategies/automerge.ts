/**
 * S3: a full CRDT, Automerge (https://automerge.org), used through its own document model and sync protocol.
 *
 * All records live in one document `{ subscriptions: { [id]: {...} } }`. Scalar strings are stored as
 * `ImmutableString` (plain registers, as in every other strategy), `tags` as a map `tag → true`,
 * `payments` as a map `paymentId → payment` and `sharedWith` as an Automerge `Counter`. A delete removes the
 * record's key. Concurrent writes are resolved by the library, so `conflicts()` is always empty.
 *
 * Determinism: the actor id is the hex form of the replica id, change timestamps come from `env.now()`, and
 * every replica starts from the same initial change (created with a fixed actor and time), so the
 * `subscriptions` map is one object everywhere instead of concurrently created ones.
 */
import * as Automerge from '@automerge/automerge';
import { pack, unpack } from './binaryState';
import {
  SCALAR_FIELDS,
  normalizeDoc,
  type Payment,
  type RecordId,
  type ReplicaId,
  type SubscriptionDoc,
} from '../model';
import { validateOp, type Op } from '../ops';
import type { Conflict, Env, Replica, SyncStrategy } from '../strategy';

type AmString = Automerge.ImmutableString;
type AmScalar = AmString | number | boolean;

interface AmPayment {
  id: AmString;
  date: AmString;
  amountCents: number;
}

interface AmRecord {
  [field: string]: AmScalar | Record<string, boolean> | Record<string, AmPayment> | Automerge.Counter;
  tags: Record<string, boolean>;
  payments: Record<string, AmPayment>;
  sharedWith: Automerge.Counter;
}

interface AmDoc {
  subscriptions: Record<RecordId, AmRecord>;
}

const encoder = new TextEncoder();

/** Automerge actor ids are hex strings; the replica id's UTF-8 bytes make it deterministic. */
export function actorFor(replicaId: ReplicaId): string {
  return [...encoder.encode(replicaId)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let base: Automerge.Doc<AmDoc> | undefined;

/** The shared initial document: one change by a fixed actor at time 0 that creates `subscriptions`. */
function baseDoc(): Automerge.Doc<AmDoc> {
  base ??= Automerge.change(Automerge.init<AmDoc>({ actor: '00' }), { time: 0 }, (d) => {
    d.subscriptions = {};
  });
  return base;
}

const str = (value: string) => new Automerge.ImmutableString(value);
const plain = (value: unknown): unknown => (value instanceof Automerge.ImmutableString ? value.val : value);

function toDoc(id: RecordId, record: AmRecord): SubscriptionDoc {
  const doc: Record<string, unknown> = { id };
  for (const f of SCALAR_FIELDS) doc[f] = plain(record[f]);
  doc.tags = Object.keys(record.tags);
  doc.payments = Object.values(record.payments).map(
    (p): Payment => ({ id: plain(p.id) as string, date: plain(p.date) as string, amountCents: p.amountCents }),
  );
  doc.sharedWith = record.sharedWith.value;
  return normalizeDoc(doc as unknown as SubscriptionDoc);
}

class AutomergeReplica implements Replica {
  private doc: Automerge.Doc<AmDoc>;
  private readonly syncStates = new Map<ReplicaId, Automerge.SyncState>();

  constructor(
    readonly replicaId: ReplicaId,
    private readonly env: Env,
    saved?: Map<string, Uint8Array>,
  ) {
    const actor = actorFor(replicaId);
    if (saved) {
      this.doc = Automerge.load<AmDoc>(saved.get('doc')!, { actor });
      for (const [name, bytes] of saved) {
        if (name.startsWith('peer:')) this.syncStates.set(name.slice(5), Automerge.decodeSyncState(bytes));
      }
    } else {
      this.doc = Automerge.clone(baseDoc(), { actor });
    }
  }

  apply(op: Op): void {
    const valid = validateOp(op, this.read());
    if (!valid.ok) throw new Error(`invalid op: ${valid.reason}`);
    const time = Math.floor(this.env.now() / 1000);
    this.doc = Automerge.change(this.doc, { time }, (d) => {
      const subs = d.subscriptions;
      switch (op.kind) {
        case 'create': {
          const record: Record<string, unknown> = { tags: {}, payments: {}, sharedWith: new Automerge.Counter(0) };
          for (const f of SCALAR_FIELDS) {
            const v = op.fields[f];
            record[f] = typeof v === 'string' ? str(v) : v;
          }
          subs[op.id] = record as AmRecord;
          return;
        }
        case 'setField':
          subs[op.id]![op.field] = typeof op.value === 'string' ? str(op.value) : op.value;
          return;
        case 'addTag':
          subs[op.id]!.tags[op.tag] = true;
          return;
        case 'removeTag':
          delete subs[op.id]!.tags[op.tag];
          return;
        case 'addPayment': {
          const payments = subs[op.id]!.payments;
          const p = op.payment;
          if (!(p.id in payments)) payments[p.id] = { id: str(p.id), date: str(p.date), amountCents: p.amountCents };
          return;
        }
        case 'increment':
          subs[op.id]!.sharedWith.increment(op.by);
          return;
        case 'delete':
          delete subs[op.id];
          return;
      }
    });
  }

  read(): SubscriptionDoc[] {
    return Object.entries(this.doc.subscriptions)
      .map(([id, record]) => toDoc(id, record))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  conflicts(): Conflict[] {
    return [];
  }

  resolve(conflictId: string): void {
    throw new Error(`automerge never reports conflicts (unknown conflict ${conflictId})`);
  }

  private syncState(peer: ReplicaId): Automerge.SyncState {
    return this.syncStates.get(peer) ?? Automerge.initSyncState();
  }

  syncMessage(peer: ReplicaId): Uint8Array | null {
    const [state, message] = Automerge.generateSyncMessage(this.doc, this.syncState(peer));
    this.syncStates.set(peer, state);
    return message;
  }

  receive(peer: ReplicaId, message: Uint8Array): void {
    const [doc, state] = Automerge.receiveSyncMessage(this.doc, this.syncState(peer), message);
    this.doc = doc;
    this.syncStates.set(peer, state);
  }

  save(): Uint8Array {
    const names = ['doc'];
    const parts = [Automerge.save(this.doc)];
    for (const peer of [...this.syncStates.keys()].sort()) {
      names.push(`peer:${peer}`);
      parts.push(Automerge.encodeSyncState(this.syncStates.get(peer)!));
    }
    return pack('automerge', this.replicaId, names, parts);
  }
}

export const automergeStrategy: SyncStrategy = {
  name: 'automerge',
  create: (replicaId, env) => new AutomergeReplica(replicaId, env),
  load(bytes, env) {
    const { replicaId, parts } = unpack('automerge', bytes);
    return new AutomergeReplica(replicaId, env, parts);
  },
};
