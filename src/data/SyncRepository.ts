import type { SubscriptionDoc } from '@sync-core/model';
import type { Op } from '@sync-core/ops';
import type { Conflict, Env, Replica, StrategyName, SyncStrategy } from '@sync-core/strategy';
import { deepEqual } from '@sync-core/util';

import { NewSubscription, Subscription } from '@/model/Subscription';
import { appStrategy, DEFAULT_STRATEGY } from '@/sync/strategies';
import { diffOps, fromDoc, opsForCreate } from '@/sync/docs';
import { logDebug, logError } from '@/util/log';
import { NetworkError } from './errors';
import { ReplicaStore } from './ReplicaStore';
import { ServerEventSource } from './ServerEvents';
import { SyncTransport } from './SyncApi';

type Listener = () => void;

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** `connecting` until the WebSocket opens or fails the first time. */
export type Connection = 'connecting' | 'online' | 'offline';

/** The id of the server replica (Shared design: star topology, clients only sync with the server). */
export const SERVER_REPLICA = 'server';

/** A sync session that has not quiesced after this many rounds is aborted (same bound as syncSession). */
const MAX_ROUNDS = 20;

/** What the list shows: the replica's visible records, its conflicts, and the state of the sync. */
export interface SubscriptionsState {
  readonly status: LoadStatus;
  /** Visible records of the local replica, sorted by next payment date. */
  readonly items: readonly Subscription[];
  /** Unresolved conflicts of the local replica (always empty for S1 and S3). */
  readonly conflicts: readonly Conflict[];
  /** Why the local load failed (only when `status` is `'error'`). */
  readonly error?: unknown;
  readonly connection: Connection;
  readonly syncing: boolean;
  /** When the last sync session with the server finished (ISO timestamp). */
  readonly lastSyncedAt: string | null;
  /** True while some local change has not been sent to the server yet. */
  readonly hasUnsentChanges: boolean;
  /** Why the last sync failed (network errors only make the app offline). */
  readonly syncError?: unknown;
  readonly strategy: StrategyName;
  readonly replicaId: string | null;
}

/** A change made on another device, noticed when a sync session brought it in. */
export interface RemoteChange {
  readonly type: 'created' | 'updated' | 'deleted';
  readonly name: string;
}

/** Result of a delete: `synced` is false when the server will only be told once the app is online. */
export interface DeleteResult {
  readonly synced: boolean;
}

export interface SyncRepositoryDeps {
  store: ReplicaStore;
  transport: SyncTransport;
  serverEvents: ServerEventSource;
  /** UUID source for record ids, payment ids and the replica id. */
  newId: () => string;
  /** Wall clock in milliseconds (the replica's clock; tests inject their own). */
  now?: () => number;
  /** Looks up a strategy by name (defaults to the strategies the app ships). */
  strategies?: (name: string) => SyncStrategy | undefined;
}

const byNextPayment = (a: Subscription, b: Subscription) =>
  a.nextPaymentDate.localeCompare(b.nextPaymentDate) ||
  a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
  a.id.localeCompare(b.id);

/**
 * Single source of truth for subscriptions: a replica of the configured strategy (sync-core), saved in
 * the local database after every change, and synced with the server replica.
 *
 * - **Read**: the list is the replica's `read()`; its `conflicts()` feed the conflict screen.
 * - **Create / update / delete** become ops (an update is diffed into the smallest set of ops), applied
 *   to the local replica and saved, so they always succeed offline. When online, a sync session runs
 *   right away.
 * - **Sync**: one session = the generic loop of sync-core's `syncSession`, one HTTP round per message
 *   pair, until neither side has anything to send. It runs when the WebSocket connects, when the server
 *   announces a change made by another client, and after each local change.
 *
 * Operations run one at a time (a promise queue), so a sync never interleaves with a user's change.
 * Untouched records keep their object identity, so the list only re-renders the rows that changed.
 */
export class SyncRepository {
  private state: SubscriptionsState = {
    status: 'idle',
    items: [],
    conflicts: [],
    connection: 'connecting',
    syncing: false,
    lastSyncedAt: null,
    hasUnsentChanges: false,
    strategy: DEFAULT_STRATEGY,
    replicaId: null,
  };
  private replica?: Replica;
  private strategy?: SyncStrategy;
  private loading?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private listening = false;
  private readonly listeners = new Set<Listener>();
  private readonly remoteListeners = new Set<(change: RemoteChange) => void>();
  private readonly now: () => number;
  private readonly strategies: (name: string) => SyncStrategy | undefined;
  /** The replica's environment: wall clock and UUIDs. */
  private readonly env: Env;

  constructor(private readonly deps: SyncRepositoryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.strategies = deps.strategies ?? appStrategy;
    this.env = { now: () => this.now(), newId: () => deps.newId() };
  }

  /** Current snapshot; the same object is returned until something changes. */
  getState = (): SubscriptionsState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onRemoteChange(listener: (change: RemoteChange) => void): () => void {
    this.remoteListeners.add(listener);
    return () => this.remoteListeners.delete(listener);
  }

  /**
   * Opens the local replica, on the first call only (later calls reuse it), then starts listening to the
   * server. Rows of the previous app version are migrated into `create` ops once. After a failure the
   * next call tries again.
   */
  load(): Promise<void> {
    this.loading ??= this.serialized(async () => {
      logDebug('Repository', 'opening the local replica');
      this.setState({ status: 'loading', error: undefined });
      try {
        await this.openReplica();
        this.setState({ status: 'ready' });
      } catch (error) {
        this.loading = undefined;
        this.setState({ status: 'error', error });
        throw error;
      }
      this.startListening();
    });
    return this.loading;
  }

  findById(id: string): Subscription | undefined {
    return this.state.items.find((s) => s.id === id);
  }

  /** Creates the record locally with a new UUID, then syncs when online. */
  add(subscription: NewSubscription): Promise<Subscription> {
    return this.serialized(async () => {
      const id = this.deps.newId();
      logDebug('Repository', `create "${subscription.name}" as ${id} (${this.state.connection})`);
      await this.applyLocal(opsForCreate(id, subscription));
      await this.syncIfOnline();
      return this.findById(id)!;
    });
  }

  /**
   * Turns the edit into ops against the current record and applies them. Resolves to the visible
   * record, or undefined if it no longer exists (e.g. deleted by a sync).
   */
  update(subscription: Subscription): Promise<Subscription | undefined> {
    return this.serialized(async () => {
      const doc = this.doc(subscription.id);
      logDebug('Repository', `update ${subscription.id} "${subscription.name}" (${this.state.connection})`);
      if (!doc) return undefined;
      const ops = diffOps(doc, subscription);
      if (ops.length === 0) return this.findById(subscription.id);
      await this.applyLocal(ops);
      await this.syncIfOnline();
      return this.findById(subscription.id);
    });
  }

  /** Deletes by id. Resolves to undefined if the record no longer exists. */
  delete(id: string): Promise<DeleteResult | undefined> {
    return this.serialized(async () => {
      logDebug('Repository', `delete ${id} (${this.state.connection})`);
      if (!this.doc(id)) return undefined;
      await this.applyLocal([{ kind: 'delete', id }]);
      await this.syncIfOnline();
      return { synced: !this.state.hasUnsentChanges };
    });
  }

  /** Chooses candidate [candidateIndex] of a conflict: a new local write that dominates all candidates. */
  resolveConflict(conflictId: string, candidateIndex: number): Promise<boolean> {
    return this.serialized(async () => {
      const replica = this.requireReplica();
      if (!replica.conflicts().some((c) => c.id === conflictId)) return false;
      logDebug('Repository', `resolve conflict ${conflictId} with candidate ${candidateIndex}`);
      try {
        replica.resolve(conflictId, candidateIndex);
      } catch (error) {
        await this.reopenReplica();
        throw error;
      }
      await this.persistLocalChange();
      await this.syncIfOnline();
      return true;
    });
  }

  /** Runs a sync session (when online), or reconnects while offline. */
  retrySync(): Promise<void> {
    if (this.state.connection === 'online') return this.sync();
    this.deps.serverEvents.reconnect();
    return Promise.resolve();
  }

  /** One sync session with the server replica (only when online and loaded). */
  sync(): Promise<void> {
    return this.serialized(() => this.syncIfOnline());
  }

  // ---------------------------------------------------------------------------------------------

  private async openReplica() {
    const { store } = this.deps;
    const name = (await store.getMeta('strategy')) ?? DEFAULT_STRATEGY;
    const strategy = this.strategies(name) ?? this.strategies(DEFAULT_STRATEGY)!;
    let replicaId = await store.getMeta('replica_id');
    if (!replicaId) {
      replicaId = `app-${this.deps.newId()}`;
      await store.setMeta('replica_id', replicaId);
    }
    const saved = await store.loadReplica(strategy.name);
    const replica = saved ? strategy.load(saved, this.env) : strategy.create(replicaId, this.env);
    this.replica = replica;
    this.strategy = strategy;

    let unsent = (await store.getMeta('unsent')) === '1';
    const legacy = await store.getLegacySubscriptions();
    if (legacy.length > 0) {
      for (const subscription of legacy) opsForCreate(this.deps.newId(), subscription).forEach((op) => replica.apply(op));
      await store.saveMigratedReplica(strategy.name, replica.save());
      await store.setMeta('unsent', '1');
      unsent = true;
      logDebug('Repository', `migrated ${legacy.length} subscription(s) of the previous version into ops`);
    } else if (!saved) {
      await store.saveReplica(strategy.name, replica.save());
    }
    this.setState({
      strategy: strategy.name,
      replicaId,
      hasUnsentChanges: unsent,
      lastSyncedAt: await store.getMeta('last_synced_at'),
    });
    this.refresh();
    logDebug('Repository', `${strategy.name} replica ${replicaId}: ${this.state.items.length} subscription(s)`);
  }

  /** Throws away the in-memory replica and loads the last saved state again (after a failed write). */
  private async reopenReplica() {
    const saved = await this.deps.store.loadReplica(this.strategy!.name);
    this.replica = saved ? this.strategy!.load(saved, this.env) : this.strategy!.create(this.state.replicaId!, this.env);
    this.refresh();
  }

  private requireReplica(): Replica {
    if (!this.replica || this.state.status !== 'ready') throw new Error('The local replica is not loaded yet');
    return this.replica;
  }

  private doc(id: string): SubscriptionDoc | undefined {
    return this.replica?.read().find((d) => d.id === id);
  }

  /** Applies the ops of one user intent; if one is rejected, none of them is kept. */
  private async applyLocal(ops: readonly Op[]) {
    const replica = this.requireReplica();
    try {
      ops.forEach((op) => replica.apply(op));
    } catch (error) {
      await this.reopenReplica();
      throw error;
    }
    await this.persistLocalChange();
  }

  private async persistLocalChange() {
    await this.deps.store.saveReplica(this.strategy!.name, this.replica!.save());
    if (!this.state.hasUnsentChanges) await this.deps.store.setMeta('unsent', '1');
    this.setState({ hasUnsentChanges: true });
    this.refresh();
  }

  private async syncIfOnline() {
    if (this.state.connection !== 'online' || this.state.status !== 'ready') return;
    await this.runSession();
  }

  /** The generic session loop of sync-core (`syncSession`), with the server reached over [SyncTransport]. */
  private async runSession() {
    const replica = this.requireReplica();
    const strategy = this.strategy!.name;
    const replicaId = this.state.replicaId!;
    const before = replica.read();
    logDebug('Sync', `session started (${strategy})`);
    this.setState({ syncing: true });
    try {
      let quiet = false;
      for (let round = 0; round < MAX_ROUNDS && !quiet; round++) {
        const out = replica.syncMessage(SERVER_REPLICA);
        const reply = await this.deps.transport.exchange({ strategy, replicaId, message: out });
        if (reply) replica.receive(SERVER_REPLICA, reply);
        await this.deps.store.saveReplica(strategy, replica.save());
        quiet = !out && !reply;
      }
      if (!quiet) throw new Error(`sync session did not quiesce after ${MAX_ROUNDS} rounds`);
      const lastSyncedAt = new Date(this.now()).toISOString();
      await this.deps.store.setMeta('last_synced_at', lastSyncedAt);
      await this.deps.store.setMeta('unsent', '0');
      this.setState({ syncing: false, lastSyncedAt, hasUnsentChanges: false, syncError: undefined });
      this.refresh();
      this.notifyRemoteChanges(before, replica.read());
      logDebug('Sync', `session finished, ${this.state.items.length} subscription(s), ${this.state.conflicts.length} conflict(s)`);
    } catch (error) {
      logError('Sync', error);
      this.refresh();
      this.setState({ syncing: false, syncError: error instanceof NetworkError ? undefined : error });
      if (error instanceof NetworkError) this.wentOffline(error);
    }
  }

  private startListening() {
    if (this.listening) return;
    this.listening = true;
    this.deps.serverEvents.start({
      onOpen: () => {
        logDebug('Repository', 'server reachable, online');
        this.setState({ connection: 'online' });
        void this.sync();
      },
      onClose: () => {
        if (this.state.connection !== 'offline') logDebug('Repository', 'server unreachable, offline');
        this.setState({ connection: 'offline', syncing: false });
      },
      onEvent: (event) => {
        if (event.origin === this.state.replicaId) {
          logDebug('Repository', 'ignoring the announcement of our own sync');
          return;
        }
        logDebug('Repository', `server data changed (by ${event.origin ?? 'a reset'}), syncing`);
        void this.sync();
      },
    });
  }

  /** Records that appeared, changed or disappeared during a session were changed on another device. */
  private notifyRemoteChanges(before: readonly SubscriptionDoc[], after: readonly SubscriptionDoc[]) {
    const old = new Map(before.map((d) => [d.id, d]));
    const changes: RemoteChange[] = [];
    for (const doc of after) {
      const previous = old.get(doc.id);
      if (!previous) changes.push({ type: 'created', name: doc.name });
      else if (!deepEqual(previous, doc)) changes.push({ type: 'updated', name: doc.name });
      old.delete(doc.id);
    }
    for (const doc of old.values()) changes.push({ type: 'deleted', name: doc.name });
    changes.forEach((change) => this.remoteListeners.forEach((listener) => listener(change)));
  }

  private wentOffline(error: NetworkError) {
    logDebug('Repository', `server unreachable (${error.message}), switching to offline mode`);
    this.setState({ connection: 'offline' });
    // The WebSocket may not have noticed yet; reconnecting brings the app back online (and syncs) when it opens.
    this.deps.serverEvents.reconnect();
  }

  /** Publishes the replica's visible records and conflicts, keeping unchanged objects. */
  private refresh() {
    if (!this.replica) return;
    const previous = new Map(this.state.items.map((s) => [s.id, s]));
    const items = this.replica
      .read()
      .map(fromDoc)
      .map((item) => {
        const old = previous.get(item.id);
        return old && deepEqual(old, item) ? old : item;
      })
      .sort(byNextPayment);
    const conflicts = this.replica.conflicts();
    const sameItems = items.length === this.state.items.length && items.every((s, i) => s === this.state.items[i]);
    const sameConflicts = deepEqual(conflicts, this.state.conflicts);
    if (sameItems && sameConflicts) return;
    this.setState({
      ...(sameItems ? {} : { items }),
      ...(sameConflicts ? {} : { conflicts }),
    });
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private setState(changes: Partial<SubscriptionsState>) {
    this.state = { ...this.state, ...changes };
    this.listeners.forEach((listener) => listener());
  }
}
