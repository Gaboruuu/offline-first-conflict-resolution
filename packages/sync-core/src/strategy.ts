import type { FieldName, ReplicaId, RecordId, SubscriptionDoc } from './model';
import type { Op } from './ops';

/**
 * Everything a replica needs from its host. Injected so that the simulator can skew clocks
 * and stay deterministic; sync-core itself never calls Date.now() or Math.random().
 */
export interface Env {
  /** Wall clock in milliseconds. May be skewed or go backwards. */
  now(): number;
  /** A fresh UUID. */
  newId(): string;
}

export interface Conflict {
  id: string;
  recordId: RecordId;
  /** A scalar field, or tags / payments / sharedWith (S2 treats them as single values), or '__deleted'. */
  field: FieldName | '__deleted';
  /** At least two entries. */
  candidates: { value: unknown; replicaId: ReplicaId }[];
}

export interface Replica {
  readonly replicaId: ReplicaId;
  /** A local user intent. */
  apply(op: Op): void;
  /** Visible records, sorted by id, in canonical form (see normalizeDoc). */
  read(): SubscriptionDoc[];
  /** Unresolved conflicts, sorted by id. Always [] for S1 and S3. */
  conflicts(): Conflict[];
  /** A new write that dominates all candidates of the conflict. */
  resolve(conflictId: string, candidateIndex: number): void;
  /** Next message for `peer`; null means there is nothing to send. */
  syncMessage(peer: ReplicaId): Uint8Array | null;
  receive(peer: ReplicaId, message: Uint8Array): void;
  /** Full persistent state, including per-peer sync state. */
  save(): Uint8Array;
}

export type StrategyName = 'lww' | 'vv' | 'automerge' | 'yjs' | 'hybrid';

export interface SyncStrategy {
  readonly name: StrategyName;
  create(replicaId: ReplicaId, env: Env): Replica;
  load(bytes: Uint8Array, env: Env): Replica;
}
