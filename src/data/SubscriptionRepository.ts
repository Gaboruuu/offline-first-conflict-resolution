import { NewSubscription, Subscription } from '@/model/Subscription';
import { logDebug, logError } from '@/util/log';
import { isNotFound, NetworkError } from './errors';
import { SubscriptionApi, toServerBody } from './SubscriptionApi';
import { LocalSubscription, SubscriptionDao } from './SubscriptionDao';
import { ServerEvent, ServerEventSource } from './ServerEvents';

type Listener = () => void;

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** `connecting` until the WebSocket opens or fails the first time. */
export type Connection = 'connecting' | 'online' | 'offline';

/** What the list shows: the cached elements, the state of the one-time load and of the server sync. */
export interface SubscriptionsState {
  readonly status: LoadStatus;
  readonly items: readonly LocalSubscription[];
  /** Why the local load failed (only when `status` is `'error'`). */
  readonly error?: unknown;
  readonly connection: Connection;
  readonly syncing: boolean;
  /** When the list was last refreshed from the server (ISO timestamp). */
  readonly lastSyncedAt: string | null;
  /** Why the last sync failed or could not send some changes (network errors only make the app offline). */
  readonly syncError?: unknown;
}

/** A change made on another device and received over the WebSocket. */
export interface RemoteChange {
  readonly type: 'created' | 'updated' | 'deleted';
  readonly name: string;
}

/** Result of a delete: `synced` is false when the server will only be told once the app is online. */
export interface DeleteResult {
  readonly synced: boolean;
}

const byNextPayment = (a: Subscription, b: Subscription) =>
  a.nextPaymentDate.localeCompare(b.nextPaymentDate) ||
  a.name.toLowerCase().localeCompare(b.name.toLowerCase());

const sameFields = (a: NewSubscription, b: NewSubscription) =>
  a.name === b.name &&
  a.amount === b.amount &&
  a.currency === b.currency &&
  a.billingCycle === b.billingCycle &&
  a.nextPaymentDate === b.nextPaymentDate &&
  a.category === b.category &&
  a.isActive === b.isActive &&
  a.notes === b.notes;

/**
 * Single source of truth for subscriptions: the local database, kept in sync with the server.
 *
 * - **Read**: the local rows are read once ([load]) and kept in memory while the app is alive. When the
 *   WebSocket connects, pending local changes are pushed and the server's list is downloaded once to
 *   refresh the local copy; afterwards the server's changes arrive over the WebSocket, one element at a
 *   time. The list is only downloaded again after the connection was lost (changes may have been missed).
 * - **Create / update / delete** go to the server first while online (only the new element, the edited
 *   element with its server id, or just the server id). The local row is written once the server
 *   answered. While offline – or when the request cannot reach the server – the change is written locally
 *   and marked pending, then sent automatically after reconnecting. Server-side rejections (validation,
 *   not found, server errors) reject the promise and leave everything unchanged.
 *
 * Operations run one at a time (a promise queue), so a sync never interleaves with a user's change.
 * Untouched elements keep their object identity, so the list only re-renders the rows that changed.
 */
export class SubscriptionRepository {
  private state: SubscriptionsState = {
    status: 'idle',
    items: [],
    connection: 'connecting',
    syncing: false,
    lastSyncedAt: null,
  };
  private loading?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private listening = false;
  private readonly listeners = new Set<Listener>();
  private readonly remoteListeners = new Set<(change: RemoteChange) => void>();

  constructor(
    private readonly dao: SubscriptionDao,
    private readonly api: SubscriptionApi,
    private readonly serverEvents: ServerEventSource,
    private readonly clientId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

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
   * Reads every local row, on the first call only (later calls reuse the cache), then starts listening
   * to the server. After a failure the next call tries again.
   */
  load(): Promise<void> {
    this.loading ??= this.serialized(async () => {
      logDebug('Repository', 'loading from the local database');
      this.setState({ status: 'loading', error: undefined });
      try {
        const items = await this.dao.getAll();
        const lastSyncedAt = await this.dao.getLastSyncedAt();
        this.setState({ status: 'ready', items: [...items].sort(byNextPayment), lastSyncedAt });
        logDebug('Repository', `loaded ${items.length} subscription(s), last synced ${lastSyncedAt ?? 'never'}`);
      } catch (error) {
        this.loading = undefined;
        this.setState({ status: 'error', error });
        throw error;
      }
      this.startListening();
    });
    return this.loading;
  }

  findById(id: number): LocalSubscription | undefined {
    return this.state.items.find((s) => s.id === id);
  }

  /** Sends only the new element; the server assigns its id. Offline, it is stored locally as pending. */
  add(subscription: NewSubscription): Promise<LocalSubscription> {
    return this.serialized(async () => {
      logDebug('Repository', `create "${subscription.name}" (${this.state.connection})`);
      if (this.state.connection === 'online') {
        try {
          const stored = await this.api.create(subscription);
          const fields = toServerBody(stored);
          const id = await this.dao.insert(fields, stored.id, 'SYNCED');
          return this.putItem({ ...fields, id, serverId: stored.id, syncState: 'SYNCED' });
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
          this.wentOffline(error);
        }
      }
      const fields = toServerBody(subscription);
      const id = await this.dao.insert(fields, null, 'PENDING_CREATE');
      logDebug('Repository', `created "${subscription.name}" locally, will be sent when online`);
      return this.putItem({ ...fields, id, serverId: null, syncState: 'PENDING_CREATE' });
    });
  }

  /**
   * Updates the element with the same id in place, on the server (same server id) and locally.
   * Resolves to the stored element, or undefined if it no longer exists.
   */
  update(subscription: Subscription): Promise<LocalSubscription | undefined> {
    return this.serialized(async () => {
      const local = this.findById(subscription.id);
      logDebug('Repository', `update #${subscription.id} "${subscription.name}" (${this.state.connection})`);
      if (!local) return undefined;
      const fields = toServerBody(subscription);
      if (local.serverId !== null && this.state.connection === 'online') {
        try {
          const stored = await this.api.update(local.serverId, fields);
          return await this.saveSynced(local, stored);
        } catch (error) {
          if (isNotFound(error)) {
            logDebug('Repository', `#${local.id} was deleted on the server, removing it locally`);
            await this.dao.delete(local.id);
            this.removeItem(local.id);
            return undefined;
          }
          if (!(error instanceof NetworkError)) throw error;
          this.wentOffline(error);
        }
      }
      // Never sent yet: it stays a pending create, which will send these values.
      const syncState = local.syncState === 'PENDING_CREATE' ? 'PENDING_CREATE' : 'PENDING_UPDATE';
      const updated: LocalSubscription = { ...fields, id: local.id, serverId: local.serverId, syncState };
      if (!(await this.dao.update(updated))) return undefined;
      logDebug('Repository', `updated #${local.id} locally (${syncState})`);
      this.putItem(updated);
      this.syncSoon();
      return updated;
    });
  }

  /**
   * Deletes by id: only the server id is sent. Offline, the element is removed locally and its server id
   * is queued. An element that never reached the server is only removed locally.
   */
  delete(id: number): Promise<DeleteResult | undefined> {
    return this.serialized(async () => {
      const local = this.findById(id);
      logDebug('Repository', `delete #${id} (${this.state.connection})`);
      if (!local) return undefined;
      let synced = local.serverId === null;
      if (local.serverId !== null && this.state.connection === 'online') {
        try {
          await this.api.delete(local.serverId);
          synced = true;
        } catch (error) {
          if (isNotFound(error)) synced = true; // already gone on the server
          else if (error instanceof NetworkError) this.wentOffline(error);
          else throw error;
        }
      }
      const queued = synced ? undefined : local.serverId!;
      if (!(await this.dao.delete(id, queued))) return undefined;
      logDebug('Repository', `deleted #${id} locally${synced ? '' : ', server delete queued'}`);
      this.removeItem(id);
      return { synced };
    });
  }

  /** Sends the pending changes and refreshes the list from the server (when online), or reconnects. */
  retrySync(): Promise<void> {
    if (this.state.connection === 'online') return this.sync();
    this.serverEvents.reconnect();
    return Promise.resolve();
  }

  /** Pushes the pending local changes, then downloads the server's list and refreshes the local copy. */
  sync(): Promise<void> {
    return this.serialized(async () => {
      if (this.state.connection !== 'online' || this.state.status !== 'ready') return;
      logDebug('Sync', 'started');
      this.setState({ syncing: true });
      try {
        await this.pushPendingDeletes();
        const failures = await this.pushPendingChanges();
        await this.pullAll();
        const lastSyncedAt = this.now().toISOString();
        await this.dao.setLastSyncedAt(lastSyncedAt);
        this.setState({ syncing: false, lastSyncedAt, syncError: failures[0] });
        logDebug('Sync', `finished, ${this.state.items.length} subscription(s), ${failures.length} change(s) rejected`);
      } catch (error) {
        logError('Sync', error);
        this.setState({ syncing: false, syncError: error instanceof NetworkError ? undefined : error });
        if (error instanceof NetworkError) this.wentOffline(error);
      }
    });
  }

  private startListening() {
    if (this.listening) return;
    this.listening = true;
    this.serverEvents.start({
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
        this.applyServerEvent(event).catch((error) => logError(`Apply server event ${event.type}`, error));
      },
    });
  }

  /** Applies one change pushed by the server to the local database and the cache. */
  private applyServerEvent(event: ServerEvent): Promise<void> {
    return this.serialized(async () => {
      if (event.origin === this.clientId) {
        logDebug('Repository', `ignoring the echo of our own ${event.type}`);
        return;
      }
      if (this.state.status !== 'ready') return;
      if (event.type === 'deleted') {
        const local = this.findByServerId(event.id);
        if (!local) return;
        await this.dao.delete(local.id);
        this.removeItem(local.id);
        logDebug('Repository', `server deleted ${event.id}, removed #${local.id}`);
        this.notifyRemote({ type: 'deleted', name: local.name });
        return;
      }
      const remote = event.subscription;
      if ((await this.dao.getPendingDeletes()).includes(remote.id)) return;
      const local = this.findByServerId(remote.id);
      if (!local) {
        await this.insertSynced(remote);
        logDebug('Repository', `server ${event.type} ${remote.id}, added locally`);
        this.notifyRemote({ type: event.type, name: remote.name });
      } else if (local.syncState !== 'SYNCED') {
        logDebug('Repository', `server updated ${remote.id}, keeping the newer local change of #${local.id}`);
      } else if (!sameFields(local, remote)) {
        await this.saveSynced(local, remote);
        logDebug('Repository', `server updated ${remote.id}, updated #${local.id}`);
        this.notifyRemote({ type: 'updated', name: remote.name });
      }
    });
  }

  private async pushPendingDeletes() {
    for (const serverId of await this.dao.getPendingDeletes()) {
      try {
        await this.api.delete(serverId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await this.dao.removePendingDelete(serverId);
      logDebug('Sync', `sent queued delete of ${serverId}`);
    }
  }

  /** Returns the server's rejections; a network error stops the sync. */
  private async pushPendingChanges(): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const item of this.state.items.filter((s) => s.syncState !== 'SYNCED')) {
      try {
        if (item.serverId === null) {
          const stored = await this.api.create(toServerBody(item));
          await this.saveSynced(item, stored);
          logDebug('Sync', `sent offline create of #${item.id}, server id ${stored.id}`);
        } else {
          try {
            await this.saveSynced(item, await this.api.update(item.serverId, toServerBody(item)));
            logDebug('Sync', `sent offline update of #${item.id}`);
          } catch (error) {
            if (!isNotFound(error)) throw error;
            await this.dao.delete(item.id);
            this.removeItem(item.id);
            logDebug('Sync', `#${item.id} was deleted on the server, dropped the local change`);
          }
        }
      } catch (error) {
        if (error instanceof NetworkError) throw error;
        logError(`Sync #${item.id}`, error);
        failures.push(error);
      }
    }
    return failures;
  }

  /** Downloads the server's list once and makes the local copy match it (pending local changes are kept). */
  private async pullAll() {
    const remote = await this.api.getAll();
    logDebug('Sync', `server has ${remote.length} subscription(s)`);
    const pendingDeletes = new Set(await this.dao.getPendingDeletes());
    const localByServerId = new Map(
      this.state.items.filter((s) => s.serverId !== null).map((s) => [s.serverId!, s] as const),
    );
    const next: LocalSubscription[] = [];
    const remoteIds = new Set<number>();
    let inserted = 0;
    let updated = 0;
    let removed = 0;

    for (const r of remote) {
      if (pendingDeletes.has(r.id)) continue;
      remoteIds.add(r.id);
      const local = localByServerId.get(r.id);
      if (!local) {
        const fields = toServerBody(r);
        const id = await this.dao.insert(fields, r.id, 'SYNCED');
        next.push({ ...fields, id, serverId: r.id, syncState: 'SYNCED' });
        inserted++;
      } else if (local.syncState === 'SYNCED' && !sameFields(local, r)) {
        const fresh: LocalSubscription = { ...toServerBody(r), id: local.id, serverId: r.id, syncState: 'SYNCED' };
        await this.dao.update(fresh);
        next.push(fresh);
        updated++;
      } else {
        next.push(local);
      }
    }
    for (const local of this.state.items) {
      if (local.serverId === null) next.push(local);
      else if (!remoteIds.has(local.serverId)) {
        await this.dao.delete(local.id);
        removed++;
      }
    }
    logDebug('Sync', `local copy refreshed: ${inserted} added, ${updated} updated, ${removed} removed`);
    if (inserted || updated || removed) this.setItems(next);
  }

  private async insertSynced(remote: Subscription): Promise<LocalSubscription> {
    const fields = toServerBody(remote);
    const id = await this.dao.insert(fields, remote.id, 'SYNCED');
    return this.putItem({ ...fields, id, serverId: remote.id, syncState: 'SYNCED' });
  }

  /** Stores the server's copy of [local] (same local id) and marks it synced. */
  private async saveSynced(local: LocalSubscription, stored: Subscription): Promise<LocalSubscription> {
    const synced: LocalSubscription = { ...toServerBody(stored), id: local.id, serverId: stored.id, syncState: 'SYNCED' };
    await this.dao.update(synced);
    return this.putItem(synced);
  }

  private wentOffline(error: NetworkError) {
    logDebug('Repository', `server unreachable (${error.message}), switching to offline mode`);
    this.setState({ connection: 'offline' });
    // The WebSocket may not have noticed yet; reconnecting brings the app back online (and syncs) when it opens.
    this.serverEvents.reconnect();
  }

  /** After a local-only write while online (e.g. editing an element not sent yet), sync right away. */
  private syncSoon() {
    if (this.state.connection === 'online') void this.sync();
  }

  private findByServerId(serverId: number) {
    return this.state.items.find((s) => s.serverId === serverId);
  }

  private notifyRemote(change: RemoteChange) {
    this.remoteListeners.forEach((listener) => listener(change));
  }

  /** Adds or replaces (by local id) one element of the cache. */
  private putItem(item: LocalSubscription): LocalSubscription {
    const exists = this.state.items.some((s) => s.id === item.id);
    this.setItems(exists ? this.state.items.map((s) => (s.id === item.id ? item : s)) : [...this.state.items, item]);
    return item;
  }

  private removeItem(id: number) {
    this.setItems(this.state.items.filter((s) => s.id !== id));
  }

  private setItems(items: LocalSubscription[]) {
    this.setState({ items: items.sort(byNextPayment) });
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
