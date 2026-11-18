import { NetworkError, ServerError } from '@/data/errors';
import { SubscriptionApi } from '@/data/SubscriptionApi';
import { LocalSubscription, SubscriptionDao, SyncState } from '@/data/SubscriptionDao';
import { SubscriptionRepository } from '@/data/SubscriptionRepository';
import { ServerEvent, ServerEventHandlers, ServerEventSource } from '@/data/ServerEvents';
import { BillingCycle, NewSubscription, Subscription } from '@/model/Subscription';
import { SubscriptionEvent, SubscriptionViewModel } from '@/ui/SubscriptionViewModel';
import { addDays } from '@/util/dates';
import { monthlyTotalRon } from '@/util/money';

const today = '2026-10-11';
const CLIENT_ID = 'this-phone';

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

/** In-memory stand-in for the SQLite DAO. */
class FakeDao implements SubscriptionDao {
  rows: LocalSubscription[] = [];
  pendingDeletes: number[] = [];
  lastSyncedAt: string | null = null;
  private nextId = 100; // local ids deliberately differ from the server's
  failNext: Error | null = null;
  readonly calls = { getAll: 0 };

  private maybeFail() {
    const error = this.failNext;
    this.failNext = null;
    if (error) throw error;
  }

  async getAll() {
    this.calls.getAll++;
    this.maybeFail();
    return [...this.rows];
  }

  async insert(s: NewSubscription, serverId: number | null, syncState: SyncState) {
    this.maybeFail();
    const id = this.nextId++;
    this.rows.push({ ...s, id, serverId, syncState });
    return id;
  }

  async update(s: LocalSubscription) {
    this.maybeFail();
    const index = this.rows.findIndex((r) => r.id === s.id);
    if (index === -1) return false;
    this.rows[index] = s;
    return true;
  }

  async delete(id: number, queueServerDelete?: number) {
    this.maybeFail();
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    if (this.rows.length < before && queueServerDelete !== undefined) this.pendingDeletes.push(queueServerDelete);
    return this.rows.length < before;
  }

  async getPendingDeletes() {
    return [...this.pendingDeletes];
  }

  async removePendingDelete(serverId: number) {
    this.pendingDeletes = this.pendingDeletes.filter((id) => id !== serverId);
  }

  async getLastSyncedAt() {
    return this.lastSyncedAt;
  }

  async setLastSyncedAt(timestamp: string) {
    this.lastSyncedAt = timestamp;
  }
}

/** In-memory server that records the requests it receives. */
class FakeApi implements SubscriptionApi {
  items: Subscription[] = [];
  reachable = true;
  failNext: Error | null = null;
  private nextId = 1;
  readonly requests: { method: string; id?: number; body?: unknown }[] = [];

  seed(...subscriptions: NewSubscription[]) {
    subscriptions.forEach((s) => this.items.push({ ...s, id: this.nextId++ }));
  }

  private check() {
    if (!this.reachable) throw new NetworkError('Network request failed');
    const error = this.failNext;
    this.failNext = null;
    if (error) throw error;
  }

  async getAll() {
    this.requests.push({ method: 'GET' });
    this.check();
    return this.items.map((s) => ({ ...s }));
  }

  async create(s: NewSubscription) {
    this.requests.push({ method: 'POST', body: s });
    this.check();
    const created = { ...s, id: this.nextId++ };
    this.items.push(created);
    return { ...created };
  }

  async update(id: number, s: NewSubscription) {
    this.requests.push({ method: 'PUT', id, body: s });
    this.check();
    const index = this.items.findIndex((i) => i.id === id);
    if (index === -1) throw new ServerError(404, 'NOT_FOUND', `Subscription ${id} does not exist`);
    this.items[index] = { ...s, id };
    return { ...this.items[index] };
  }

  async delete(id: number) {
    this.requests.push({ method: 'DELETE', id });
    this.check();
    if (!this.items.some((i) => i.id === id)) throw new ServerError(404, 'NOT_FOUND', `Subscription ${id} does not exist`);
    this.items = this.items.filter((i) => i.id !== id);
  }

  count(method: string) {
    return this.requests.filter((r) => r.method === method).length;
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

/** Waits until every queued repository operation (sync, server events) has run; the fakes only use promises. */
const settle = async (_repo: SubscriptionRepository) => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function setup({ server = [] as NewSubscription[], online = true } = {}) {
  const dao = new FakeDao();
  const api = new FakeApi();
  api.seed(...server);
  const events = new FakeEvents();
  const repo = new SubscriptionRepository(dao, api, events, CLIENT_ID, () => new Date('2026-10-11T12:00:00Z'));
  await repo.load();
  if (online) {
    events.open();
    await settle(repo);
  } else {
    api.reachable = false;
    events.close();
  }
  return { dao, api, events, repo };
}

const names = (repo: SubscriptionRepository) => repo.getState().items.map((s) => s.name);

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('SubscriptionRepository – read', () => {
  it('reads the local database once, downloads the server list once and reuses it', async () => {
    const { dao, api, repo } = await setup({ server: [sub('B', 1, 'MONTHLY', 5), sub('A', 1, 'MONTHLY', 1)] });
    await repo.load();
    await repo.add(sub('C', 1, 'MONTHLY', 9));
    await repo.update({ ...repo.getState().items[0], amount: 2 });

    expect(dao.calls.getAll).toBe(1);
    expect(api.count('GET')).toBe(1);
    expect(names(repo)).toEqual(['A', 'B', 'C']);
    expect(repo.getState()).toMatchObject({ status: 'ready', connection: 'online', lastSyncedAt: '2026-10-11T12:00:00.000Z' });
    // The local copy now mirrors the server, under local ids, linked by server id.
    expect(dao.rows.map((r) => [r.name, r.serverId, r.syncState])).toEqual(
      expect.arrayContaining([['A', 2, 'SYNCED'], ['B', 1, 'SYNCED'], ['C', 3, 'SYNCED']]),
    );
  });

  it('shows the local data while offline and downloads the list again only after reconnecting', async () => {
    const { api, events, repo } = await setup({ server: [sub('Netflix')] });
    events.close();
    expect(repo.getState().connection).toBe('offline');
    expect(names(repo)).toEqual(['Netflix']);

    api.seed(sub('Spotify', 10, 'MONTHLY', 3)); // added on another device while we were offline
    events.open();
    await settle(repo);
    expect(api.count('GET')).toBe(2);
    expect(names(repo)).toEqual(['Netflix', 'Spotify']);
  });

  it('reports a failed local read and reads again on retry', async () => {
    const dao = new FakeDao();
    const repo = new SubscriptionRepository(dao, new FakeApi(), new FakeEvents(), CLIENT_ID);
    dao.failNext = new Error('disk I/O error');
    await expect(repo.load()).rejects.toThrow('disk I/O error');
    expect(repo.getState()).toMatchObject({ status: 'error', items: [] });
    await repo.load();
    expect(repo.getState().status).toBe('ready');
    expect(dao.calls.getAll).toBe(2);
  });

  it('applies the changes pushed over the WebSocket, one element at a time', async () => {
    const { dao, api, events, repo } = await setup({ server: [sub('Netflix'), sub('Spotify', 10, 'MONTHLY', 2)] });
    const spotify = repo.getState().items[1];

    events.push({ type: 'created', subscription: { ...sub('Gym', 10, 'MONTHLY', 3), id: 50 }, origin: 'other-phone' });
    events.push({ type: 'updated', subscription: { ...sub('Netflix HD'), id: 1 }, origin: 'other-phone' });
    events.push({ type: 'deleted', id: 99, origin: 'other-phone' }); // unknown: ignored
    await settle(repo);
    expect(names(repo)).toEqual(['Netflix HD', 'Spotify', 'Gym']);
    expect(repo.findById(spotify.id)).toBe(spotify); // untouched row keeps its identity

    events.push({ type: 'deleted', id: 1, origin: 'other-phone' });
    await settle(repo);
    expect(names(repo)).toEqual(['Spotify', 'Gym']);
    expect(dao.rows.map((r) => r.name).sort()).toEqual(['Gym', 'Spotify']);
    expect(api.count('GET')).toBe(1);
  });

  it('ignores the echo of its own changes and keeps a newer local change', async () => {
    const { events, repo } = await setup({ server: [sub('Netflix')] });
    const netflix = repo.getState().items[0];
    events.push({ type: 'created', subscription: { ...sub('Echo'), id: 7 }, origin: CLIENT_ID });
    events.close();
    await repo.update({ ...netflix, name: 'Netflix (mine)' });
    events.push({ type: 'updated', subscription: { ...sub('Netflix (theirs)'), id: 1 }, origin: 'other-phone' });
    await settle(repo);
    expect(names(repo)).toEqual(['Netflix (mine)']);
  });
});

describe('SubscriptionRepository – online writes', () => {
  it('create sends only the new element; the server assigns the id', async () => {
    const { api, dao, repo } = await setup();
    const created = await repo.add(sub('Netflix', 49.99));
    expect(api.requests.at(-1)).toEqual({ method: 'POST', body: sub('Netflix', 49.99) });
    expect(created).toMatchObject({ name: 'Netflix', serverId: 1, syncState: 'SYNCED' });
    expect(dao.rows).toEqual([created]);
    expect(api.items).toEqual([{ ...sub('Netflix', 49.99), id: 1 }]);
  });

  it('update reuses the server element: same server id, same local row, nothing deleted', async () => {
    const { api, dao, repo } = await setup({ server: [sub('Netflix'), sub('Spotify', 10, 'MONTHLY', 2)] });
    const [netflix, spotify] = repo.getState().items;
    const updated = await repo.update({ ...netflix, amount: 59.99 });

    expect(api.requests.at(-1)).toEqual({ method: 'PUT', id: 1, body: { ...sub('Netflix'), amount: 59.99 } });
    expect(updated).toMatchObject({ id: netflix.id, serverId: 1, amount: 59.99, syncState: 'SYNCED' });
    expect(api.items.map((s) => s.id)).toEqual([1, 2]);
    expect(dao.rows.find((r) => r.id === netflix.id)?.amount).toBe(59.99);
    expect(repo.findById(spotify.id)).toBe(spotify);
    expect(api.count('POST') + api.count('DELETE')).toBe(0);
  });

  it('delete sends only the server id', async () => {
    const { api, dao, repo } = await setup({ server: [sub('Netflix'), sub('Spotify', 10, 'MONTHLY', 2)] });
    const netflix = repo.getState().items[0];
    expect(await repo.delete(netflix.id)).toEqual({ synced: true });
    expect(api.requests.at(-1)).toEqual({ method: 'DELETE', id: 1 });
    expect(api.items.map((s) => s.name)).toEqual(['Spotify']);
    expect(dao.rows.map((r) => r.name)).toEqual(['Spotify']);
    expect(names(repo)).toEqual(['Spotify']);
    expect(await repo.delete(netflix.id)).toBeUndefined();
  });

  it('rejects server errors and leaves the local data unchanged', async () => {
    const { api, dao, repo } = await setup({ server: [sub('Netflix')] });
    const before = repo.getState();
    const netflix = before.items[0];

    api.failNext = new ServerError(400, 'VALIDATION_FAILED', 'Some fields are not valid', { name: 'Name is required' });
    await expect(repo.add(sub('X'))).rejects.toBeInstanceOf(ServerError);
    api.failNext = new ServerError(500, 'INTERNAL', 'Internal server error');
    await expect(repo.update({ ...netflix, name: 'Y' })).rejects.toBeInstanceOf(ServerError);
    api.failNext = new ServerError(500, 'INTERNAL', 'Internal server error');
    await expect(repo.delete(netflix.id)).rejects.toBeInstanceOf(ServerError);

    expect(repo.getState().items).toBe(before.items);
    expect(dao.rows).toEqual([netflix]);
  });

  it('removes an element that was deleted on the server when updating it', async () => {
    const { api, repo } = await setup({ server: [sub('Netflix')] });
    const netflix = repo.getState().items[0];
    api.items = [];
    expect(await repo.update({ ...netflix, amount: 5 })).toBeUndefined();
    expect(names(repo)).toEqual([]);
  });

  it('falls back to the local database when the server cannot be reached', async () => {
    const { api, events, repo } = await setup();
    api.reachable = false;
    const created = await repo.add(sub('Netflix'));
    expect(created).toMatchObject({ serverId: null, syncState: 'PENDING_CREATE' });
    expect(repo.getState().connection).toBe('offline');
    expect(events.reconnects).toBe(1);
  });
});

describe('SubscriptionRepository – offline', () => {
  it('stores every change locally and sends it with the right ids once online', async () => {
    const { api, dao, events, repo } = await setup({ server: [sub('Netflix'), sub('Spotify', 10, 'MONTHLY', 2)] });
    const [netflix, spotify] = repo.getState().items;
    events.close();
    api.reachable = false;

    const gym = await repo.add(sub('Gym', 150, 'MONTHLY', 3));
    await repo.update({ ...gym, amount: 120 }); // still a pending create, with the new values
    await repo.update({ ...netflix, amount: 59.99 });
    expect(await repo.delete(spotify.id)).toEqual({ synced: false });

    expect(repo.getState().items.map((s) => [s.name, s.syncState])).toEqual([
      ['Netflix', 'PENDING_UPDATE'],
      ['Gym', 'PENDING_CREATE'],
    ]);
    expect(dao.pendingDeletes).toEqual([2]);
    expect(api.items.map((s) => s.name)).toEqual(['Netflix', 'Spotify']);

    api.reachable = true;
    api.requests.length = 0;
    events.open();
    await settle(repo);

    expect(api.requests.slice(0, 4)).toEqual([
      { method: 'DELETE', id: 2 },
      { method: 'PUT', id: 1, body: { ...sub('Netflix'), amount: 59.99 } },
      { method: 'POST', body: sub('Gym', 120, 'MONTHLY', 3) },
      { method: 'GET' },
    ]);
    expect(api.items.map((s) => [s.id, s.name, s.amount])).toEqual([[1, 'Netflix', 59.99], [3, 'Gym', 120]]);
    expect(repo.getState().items.map((s) => [s.id, s.serverId, s.syncState])).toEqual([
      [netflix.id, 1, 'SYNCED'],
      [gym.id, 3, 'SYNCED'],
    ]);
    expect(dao.pendingDeletes).toEqual([]);
  });

  it('never sends an element created and deleted while offline', async () => {
    const { api, dao, events, repo } = await setup({ online: false });
    const draft = await repo.add(sub('Draft'));
    expect(await repo.delete(draft.id)).toEqual({ synced: true });
    api.reachable = true;
    api.requests.length = 0;
    events.open();
    await settle(repo);
    expect(api.requests).toEqual([{ method: 'GET' }]);
    expect(dao.pendingDeletes).toEqual([]);
  });

  it('drops an offline update of an element that was deleted on the server meanwhile', async () => {
    const { api, events, repo } = await setup({ server: [sub('Netflix')] });
    const netflix = repo.getState().items[0];
    events.close();
    api.reachable = false;
    await repo.update({ ...netflix, amount: 1 });
    api.reachable = true;
    api.items = [];
    events.open();
    await settle(repo);
    expect(names(repo)).toEqual([]);
    expect(repo.getState().syncError).toBeUndefined();
  });

  it('keeps a change the server rejects as pending and sends it again on the next sync', async () => {
    const { api, events, repo } = await setup({ online: false });
    await repo.add(sub('Gym'));
    api.reachable = true;
    api.failNext = new ServerError(400, 'VALIDATION_FAILED', 'Some fields are not valid', { amount: 'bad' });
    events.open();
    await settle(repo);
    expect(repo.getState().items[0].syncState).toBe('PENDING_CREATE');
    expect(repo.getState().syncError).toBeInstanceOf(ServerError);
    expect(repo.getState().lastSyncedAt).not.toBeNull(); // the rest of the sync still ran

    await repo.retrySync();
    expect(api.count('POST')).toBe(2);
    expect(repo.getState().items[0].syncState).toBe('SYNCED');
    expect(repo.getState().syncError).toBeUndefined();
  });
});

describe('SubscriptionViewModel', () => {
  it('reports each operation with the name of the element, offline and remote changes too', async () => {
    const { api, events, repo } = await setup();
    const viewModel = new SubscriptionViewModel(repo);
    const received: SubscriptionEvent[] = [];
    viewModel.onEvent((e) => received.push(e));

    const created = await viewModel.add(sub('Netflix'));
    await viewModel.update({ ...created, name: 'Netflix Premium' });
    api.failNext = new ServerError(500, 'INTERNAL', 'boom');
    await expect(viewModel.delete(created.id)).rejects.toThrow('boom');
    api.reachable = false;
    await viewModel.delete(created.id);
    events.push({ type: 'created', subscription: { ...sub('Gym'), id: 40 }, origin: 'other-phone' });
    await settle(repo);

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
      ].map((s, i) => ({ ...s, id: i + 1 })),
    );
    expect(total).toBe(72);
  });

  it('converts other currencies to RON', () => {
    expect(monthlyTotalRon([{ ...sub('Cloud', 10, 'MONTHLY', 1), currency: 'EUR', id: 1 }])).toBe(49.7);
  });
});
