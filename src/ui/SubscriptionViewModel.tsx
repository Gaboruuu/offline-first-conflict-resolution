import { createContext, ReactNode, useContext, useMemo, useState, useSyncExternalStore } from 'react';

import { DeleteResult, SyncRepository } from '@/data/SyncRepository';
import { NewSubscription, Subscription } from '@/model/Subscription';
import { logDebug } from '@/util/log';
import { monthlyTotalRon } from '@/util/money';

/**
 * A finished operation, shown as a snackbar. `offline`: saved on the phone only, sent once online.
 * `remote`: made on another device and brought in by a sync.
 */
export type SubscriptionEvent = {
  type: 'created' | 'updated' | 'deleted';
  name: string;
  offline?: boolean;
  remote?: boolean;
};
type EventListener = (event: SubscriptionEvent) => void;

/**
 * App-scoped view model shared by the list, create, update and delete screens.
 * Screens pass back only the affected element (or just its id, for delete); the
 * list observes the repository and is told about each change through an event.
 * Server and database operations are asynchronous and reject on failure, so every
 * screen can show and log the error itself.
 */
export class SubscriptionViewModel {
  private readonly eventListeners = new Set<EventListener>();

  constructor(private readonly repository: SyncRepository) {
    repository.onRemoteChange((change) => this.emit({ ...change, remote: true }));
  }

  readonly subscribe = (listener: () => void) => this.repository.subscribe(listener);
  readonly getState = () => this.repository.getState();

  /** Loads the list from the local database the first time; afterwards it is served from memory. */
  load(): Promise<void> {
    return this.repository.load();
  }

  /** Runs a sync session with the server, or reconnects while offline. */
  retrySync(): Promise<void> {
    return this.repository.retrySync();
  }

  get(id: string): Subscription | undefined {
    return this.repository.findById(id);
  }

  async add(subscription: NewSubscription): Promise<Subscription> {
    const created = await this.repository.add(subscription);
    this.emit({ type: 'created', name: created.name, offline: this.unsent() });
    return created;
  }

  /** Resolves to undefined when the element no longer exists. */
  async update(subscription: Subscription): Promise<Subscription | undefined> {
    const updated = await this.repository.update(subscription);
    if (updated) this.emit({ type: 'updated', name: updated.name, offline: this.unsent() });
    return updated;
  }

  /** Resolves to undefined when the element no longer exists. */
  async delete(id: string): Promise<DeleteResult | undefined> {
    const name = this.repository.findById(id)?.name;
    const deleted = await this.repository.delete(id);
    if (deleted && name !== undefined) this.emit({ type: 'deleted', name, offline: !deleted.synced });
    return deleted;
  }

  /** Picks a candidate of a conflict; resolves to false when the conflict no longer exists. */
  resolveConflict(conflictId: string, candidateIndex: number): Promise<boolean> {
    return this.repository.resolveConflict(conflictId, candidateIndex);
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  private unsent(): boolean {
    return this.repository.getState().hasUnsentChanges;
  }

  private emit(event: SubscriptionEvent) {
    logDebug('ViewModel', `${event.type} "${event.name}"${event.offline ? ' (offline)' : ''}${event.remote ? ' (remote)' : ''}`);
    this.eventListeners.forEach((listener) => listener(event));
  }
}

const ViewModelContext = createContext<SubscriptionViewModel | null>(null);

/** Creates the view model once, at the root of the app, so every screen shares it. */
export function SubscriptionViewModelProvider({
  repository,
  children,
}: {
  repository: () => SyncRepository;
  children: ReactNode;
}) {
  const [viewModel] = useState(() => new SubscriptionViewModel(repository()));
  return <ViewModelContext.Provider value={viewModel}>{children}</ViewModelContext.Provider>;
}

export function useSubscriptionViewModel(): SubscriptionViewModel {
  const viewModel = useContext(ViewModelContext);
  if (!viewModel) throw new Error('useSubscriptionViewModel must be used inside SubscriptionViewModelProvider');
  return viewModel;
}

/**
 * Observes the sorted list, the load and sync state and the monthly total; re-renders only when the
 * repository publishes.
 */
export function useSubscriptions() {
  const viewModel = useSubscriptionViewModel();
  const state = useSyncExternalStore(viewModel.subscribe, viewModel.getState);
  const subscriptions = state.items;
  const monthlyTotal = useMemo(() => monthlyTotalRon(subscriptions), [subscriptions]);
  const activeCount = useMemo(() => subscriptions.filter((s) => s.isActive).length, [subscriptions]);
  return { ...state, subscriptions, monthlyTotal, activeCount };
}
