import type { StrategyName } from '@sync-core/strategy';

import { NewSubscription } from '@/model/Subscription';

/** Keys of the `sync_meta` table. */
export type MetaKey =
  /** Strategy of the local replica (developer settings; must match the server's). */
  | 'strategy'
  /** This device's replica id, generated once. */
  | 'replica_id'
  /** When the last sync session finished (ISO timestamp). */
  | 'last_synced_at'
  /** '1' while local changes have not been sent to the server yet. */
  | 'unsent'
  /** Developer settings: artificial clock skew in seconds, and the "force offline" switch ('1' / '0'). */
  | 'clock_skew_s'
  | 'force_offline'
  /** Traffic counters for the metrics export (JSON). */
  | 'metrics';

/**
 * Local persistence of the replica: its full saved state per strategy (`Replica.save()`), plus a few
 * key/value settings. Implementations reject the promise on failure.
 */
export interface ReplicaStore {
  /** The saved state of the replica of this strategy, or null if there is none yet. */
  loadReplica(strategy: StrategyName): Promise<Uint8Array | null>;
  saveReplica(strategy: StrategyName, state: Uint8Array): Promise<void>;
  /** Forgets every saved replica (used when the strategy is changed). */
  deleteReplicas(): Promise<void>;
  getMeta(key: MetaKey): Promise<string | null>;
  setMeta(key: MetaKey, value: string): Promise<void>;
  /**
   * Subscriptions stored by the previous version of the app (schema 2) that were never turned into
   * replica ops; empty once [saveMigratedReplica] ran.
   */
  getLegacySubscriptions(): Promise<NewSubscription[]>;
  /** Saves the replica that now contains the legacy subscriptions and marks them migrated, atomically. */
  saveMigratedReplica(strategy: StrategyName, state: Uint8Array): Promise<void>;
}
