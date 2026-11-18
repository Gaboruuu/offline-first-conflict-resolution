import type { Replica, StrategyName, SyncStrategy } from '@sync-core/strategy';

import { NetworkError, ServerError } from '@/data/errors';
import { MetaKey, ReplicaStore } from '@/data/ReplicaStore';
import { ServerEvent, ServerEventHandlers, ServerEventSource } from '@/data/ServerEvents';
import { SyncRequest, SyncTransport } from '@/data/SyncApi';
import { SERVER_REPLICA, SyncRepository } from '@/data/SyncRepository';
import { BillingCycle, NewSubscription } from '@/model/Subscription';
import { appStrategy, APP_STRATEGIES } from '@/sync/strategies';
import { SubscriptionEvent, SubscriptionViewModel } from '@/ui/SubscriptionViewModel';
import { addDays } from '@/util/dates';
import { monthlyTotalRon } from '@/util/money';

const today = '2026-10-11';

const sub = (name: string, amount = 10, cycle: BillingCycle = 'MONTHLY', inDays = 1, isActive = true): NewSubscription => ({
  name,
  amount,
  currency: 'RON',
  billingCycle: cycle,
  nextPaymentDate: addDays(today, inDays),
  category: 'OTHER',
  isActive,
  notes: '',
  tags: [],
  payments: [],
  sharedWith: 0,
});

/** Deterministic UUID-shaped ids. */
function idSource(prefix: string) {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(4, '0')}`;
}

/** In-memory stand-in for the SQLite replica store. */
class FakeStore implements ReplicaStore {
  replicas = new Map<StrategyName, Uint8Array>();
  meta = new Map<MetaKey, string>();
  legacy: NewSubscription[] = [];
  failNextSave: Error | null = null;
  saves = 0;

  async loadReplica(strategy: StrategyName) {
    return this.replicas.get(strategy) ?? null;
  }
  async saveReplica(strategy: StrategyName, state: Uint8Array) {
    const error = this.failNextSave;
    this.failNextSave = null;
    if (error) throw error;
    this.saves++;
    this.replicas.set(strategy, state);
  }
  async deleteReplicas() {
    this.replicas.clear();
  }
  async getMeta(key: MetaKey) {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: MetaKey, value: string) {
    this.meta.set(key, value);
  }
  async getLegacySubscriptions() {
    return [...this.legacy];
  }
  async saveMigratedReplica(strategy: StrategyName, state: Uint8Array) {
    this.replicas.set(strategy, state);
    this.legacy = [];
  }
}

/** The server replica, answering like syncService: receive the client's message, then reply with its own. */
class FakeServer implements SyncTransport {
  readonly replica: Replica;
  reachable = true;
  failNext: Error | null = null;
  readonly requests: { replicaId: string; bytes: number }[] = [];
  /** Called after a request changed the server's data (what the WebSocket announces). */
  onChanged?: (origin: string) => void;

  constructor(readonly strategy: SyncStrategy) {
    let n = 0;
    this.replica = strategy.create(SERVER_REPLICA, { now: () => 1_000 + n++, newId: idSource('server') });
  }

  async exchange({ strategy, replicaId, message }: SyncRequest) {
    if (!this.reachable) throw new NetworkError('Network request failed');
    const error = this.failNext;
    this.failNext = null;
    if (error) throw error;
    if (strategy !== this.strategy.name) {
      throw new ServerError(409, 'WRONG_STRATEGY', `This server runs strategy "${this.strategy.name}"`);
    }
    this.requests.push({ replicaId, bytes: message?.length ?? 0 });
    const before = JSON.stringify(this.replica.read());
    if (message) this.replica.receive(replicaId, message);
    const reply = this.replica.syncMessage(replicaId);
    if (message && JSON.stringify(this.replica.read()) !== before) this.onChanged?.(replicaId);
    return reply;
  }
}

/** Lets a test open / close the "WebSocket" and push server events. */
class FakeEvents implements ServerEventSource {
  handlers?: ServerEventHandlers;
  reconnects = 0;
  start(handlers: ServerEventHandlers) {
    this.handlers = handlers;
  }
  reconnect() {
    this.reconnects++;
  }
  stop() {}
  open() {
    this.handlers!.onOpen();
  }
  close() {
    this.handlers!.onClose();
  }
  push(event: ServerEvent) {
    this.handlers!.onEvent(event);
  }
}

/** Waits until every queued repository operation has run; the fakes only use promises. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** One wall clock for every device of a test (LWW would otherwise see the devices' clocks as skewed). */
let clock = 2_000;

async function client(server: FakeServer, name: string, { online = true, store = new FakeStore() } = {}) {
  store.meta.set('strategy', server.strategy.name);
  const events = new FakeEvents();
  const repo = new SyncRepository({
    store,
    transport: server,
    serverEvents: events,
    newId: idSource(name),
    now: () => (clock += 10),
  });
  await repo.load();
  if (online) {
    events.open();
    await settle();
  } else {
    events.close();
  }
  return { repo, events, store };
}

async function setup(strategyName: StrategyName = 'lww', options: { online?: boolean } = {}) {
  const server = new FakeServer(appStrategy(strategyName)!);
  return { server, ...(await client(server, 'c1', options)) };
}

const names = (repo: SyncRepository) => repo.getState().items.map((s) => s.name);

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('SyncRepository – local replica', () => {
  it('opens an empty replica, saves it, and generates the replica id once', async () => {
    const { repo, store } = await setup('lww', { online: false });
    expect(repo.getState()).toMatchObject({ status: 'ready', items: [], conflicts: [], strategy: 'lww' });
    expect(repo.getState().replicaId).toBe('app-c1-0001');
    expect(store.meta.get('replica_id')).toBe('app-c1-0001');
    expect(store.replicas.has('lww')).toBe(true);
  });

  it('keeps changes made offline across a restart', async () => {
    const { repo, store, server } = await setup('hybrid', { online: false });
    const created = await repo.add({ ...sub('Netflix'), tags: ['family'], sharedWith: 2 });
    expect(repo.getState().hasUnsentChanges).toBe(true);

    const reopened = await client(server, 'c1', { online: false, store });
    expect(reopened.repo.getState().items).toEqual([created]);
    expect(reopened.repo.getState().hasUnsentChanges).toBe(true);
    expect(reopened.repo.getState().replicaId).toBe(repo.getState().replicaId);
  });

  it('migrates the rows of the previous version into the replica once', async () => {
    const store = new FakeStore();
    store.legacy = [sub('Gym'), sub('Spotify')];
    const server = new FakeServer(appStrategy('lww')!);
    const { repo } = await client(server, 'c1', { online: false, store });
    expect(names(repo).sort()).toEqual(['Gym', 'Spotify']);
    expect(store.legacy).toEqual([]);
    expect(repo.getState().hasUnsentChanges).toBe(true);
  });

  it('reports a failed load and opens the replica again on retry', async () => {
    const store = new FakeStore();
    store.loadReplica = jest.fn().mockRejectedValueOnce(new Error('SQLITE_IOERR')).mockResolvedValue(null);
    const repo = new SyncRepository({ store, transport: new FakeServer(appStrategy('lww')!), serverEvents: new FakeEvents(), newId: idSource('c') });
    await expect(repo.load()).rejects.toThrow('SQLITE_IOERR');
    expect(repo.getState().status).toBe('error');
    await repo.load();
    expect(repo.getState().status).toBe('ready');
  });

  it('turns an edit into the smallest set of ops and keeps untouched records identical', async () => {
    const { repo } = await setup('hybrid', { online: false });
    const a = await repo.add(sub('A'));
    const b = await repo.add({ ...sub('B'), tags: ['x'] });
    const updated = await repo.update({ ...b, amount: 12.5, tags: ['y'], sharedWith: 3 });
    expect(updated).toMatchObject({ amount: 12.5, tags: ['y'], sharedWith: 3 });
    expect(repo.findById(a.id)).toBe(a);
    expect(await repo.update({ ...a, id: 'missing' })).toBeUndefined();
  });

  it('rolls back every op of an intent when one is rejected', async () => {
    const { repo, store } = await setup('lww', { online: false });
    const a = await repo.add(sub('A'));
    store.failNextSave = new Error('SQLITE_FULL');
    await expect(repo.update({ ...a, name: 'B' })).rejects.toThrow('SQLITE_FULL');
    expect(names(repo)).toEqual(['A']);
  });

  it('deletes by id and reports whether the server was told', async () => {
    const { repo } = await setup('lww', { online: false });
    const a = await repo.add(sub('A'));
    expect(await repo.delete(a.id)).toEqual({ synced: false });
    expect(repo.getState().items).toEqual([]);
    expect(await repo.delete(a.id)).toBeUndefined();
  });
});

describe('SyncRepository – sync with the server', () => {
  it.each(APP_STRATEGIES.map((s) => s.name))('%s: two devices converge through the server', async (name) => {
    const server = new FakeServer(appStrategy(name)!);
    const one = await client(server, 'c1');
    const two = await client(server, 'c2');
    server.onChanged = (origin) => {
      for (const c of [one, two]) if (c.repo.getState().replicaId !== origin) c.events.push({ type: 'changed', origin });
    };

    const netflix = await one.repo.add({ ...sub('Netflix', 49.99), tags: ['tv'], sharedWith: 1 });
    await settle();
    expect(two.repo.findById(netflix.id)).toEqual(netflix);

    await two.repo.update({ ...two.repo.findById(netflix.id)!, notes: 'family plan' });
    await settle();
    expect(one.repo.findById(netflix.id)?.notes).toBe('family plan');
    expect(one.repo.getState().items).toEqual(two.repo.getState().items);
    expect(one.repo.getState().hasUnsentChanges).toBe(false);
    expect(one.repo.getState().lastSyncedAt).not.toBeNull();
  });

  it('sends offline changes once the server is reachable again', async () => {
    const { repo, events, server } = await setup('lww', { online: false });
    await repo.add(sub('Offline'));
    expect(server.requests).toHaveLength(0);
    events.open();
    await settle();
    expect(server.replica.read().map((d) => d.name)).toEqual(['Offline']);
    expect(repo.getState()).toMatchObject({ connection: 'online', hasUnsentChanges: false });
  });

  it('goes offline when the server cannot be reached, and keeps the change as unsent', async () => {
    const { repo, events, server } = await setup('lww');
    server.reachable = false;
    await repo.add(sub('A'));
    expect(repo.getState()).toMatchObject({ connection: 'offline', hasUnsentChanges: true, syncError: undefined });
    expect(events.reconnects).toBe(1);

    server.reachable = true;
    events.open();
    await settle();
    expect(server.replica.read().map((d) => d.name)).toEqual(['A']);
  });

  it('reports a server that runs another strategy', async () => {
    const server = new FakeServer(appStrategy('vv')!);
    const store = new FakeStore();
    store.meta.set('strategy', 'lww');
    const events = new FakeEvents();
    const repo = new SyncRepository({ store, transport: server, serverEvents: events, newId: idSource('c') });
    await repo.load();
    events.open();
    await settle();
    expect(repo.getState().syncError).toMatchObject({ code: 'WRONG_STRATEGY' });
    expect(repo.getState().connection).toBe('online');
  });

  it('ignores the announcement of its own sync', async () => {
    const { repo, events, server } = await setup('lww');
    const before = server.requests.length;
    events.push({ type: 'changed', origin: repo.getState().replicaId });
    await settle();
    expect(server.requests).toHaveLength(before);
  });

  it('surfaces concurrent edits of a critical field as a conflict and resolves it (hybrid)', async () => {
    const server = new FakeServer(appStrategy('hybrid')!);
    const one = await client(server, 'c1');
    const created = await one.repo.add(sub('Netflix', 49.99));
    const two = await client(server, 'c2');
    one.events.close();
    two.events.close();

    await one.repo.update({ ...one.repo.findById(created.id)!, amount: 54.99 });
    await two.repo.update({ ...two.repo.findById(created.id)!, amount: 59.99 });
    one.events.open();
    await settle();
    two.events.open();
    await settle();
    one.events.push({ type: 'changed', origin: 'other' });
    await settle();

    const [conflict] = one.repo.getState().conflicts;
    expect(conflict).toMatchObject({ recordId: created.id, field: 'amountCents' });
    expect(conflict.candidates.map((c) => c.value).sort()).toEqual([5499, 5999]);

    const pick = conflict.candidates.findIndex((c) => c.value === 5499);
    expect(await one.repo.resolveConflict(conflict.id, pick)).toBe(true);
    expect(one.repo.getState().conflicts).toEqual([]);
    expect(one.repo.findById(created.id)?.amount).toBe(54.99);
    two.events.push({ type: 'changed', origin: 'other' });
    await settle();
    expect(two.repo.getState().conflicts).toEqual([]);
    expect(two.repo.findById(created.id)?.amount).toBe(54.99);
    expect(await one.repo.resolveConflict(conflict.id, 0)).toBe(false);
  });
});

describe('SubscriptionViewModel', () => {
  it('reports each operation with the name of the element, offline and remote changes too', async () => {
    const server = new FakeServer(appStrategy('lww')!);
    const one = await client(server, 'c1');
    const two = await client(server, 'c2');
    const viewModel = new SubscriptionViewModel(one.repo);
    const received: SubscriptionEvent[] = [];
    viewModel.onEvent((e) => received.push(e));

    const created = await viewModel.add(sub('Netflix'));
    await viewModel.update({ ...created, name: 'Netflix Premium' });
    server.reachable = false;
    await viewModel.delete(created.id);
    server.reachable = true;
    await two.repo.add(sub('Gym'));
    one.events.open();
    await settle();

    expect(received).toEqual([
      { type: 'created', name: 'Netflix', offline: false },
      { type: 'updated', name: 'Netflix Premium', offline: false },
      { type: 'deleted', name: 'Netflix Premium', offline: true },
      { type: 'created', name: 'Gym', remote: true },
    ]);
  });
});

describe('monthlyTotalRon', () => {
  it('normalises cycles and skips paused subscriptions', () => {
    const total = monthlyTotalRon(
      [
        sub('Monthly', 10, 'MONTHLY', 1),
        sub('Yearly', 120, 'YEARLY', 1),
        sub('Weekly', 12, 'WEEKLY', 1),
        sub('Paused', 100, 'MONTHLY', 1, false),
      ].map((s, i) => ({ ...s, id: String(i + 1) })),
    );
    expect(total).toBe(72);
  });

  it('converts other currencies to RON', () => {
    expect(monthlyTotalRon([{ ...sub('Cloud', 10, 'MONTHLY', 1), currency: 'EUR', id: '1' }])).toBe(49.7);
  });
});
