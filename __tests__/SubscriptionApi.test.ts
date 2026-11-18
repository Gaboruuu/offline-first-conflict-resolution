import { NetworkError, ServerError } from '@/data/errors';
import { parseServerEvent, WebSocketEventSource } from '@/data/ServerEvents';
import { HttpSubscriptionApi } from '@/data/SubscriptionApi';
import { NewSubscription } from '@/model/Subscription';
import { strings } from '@/strings';
import { friendlyError } from '@/util/log';

const netflix: NewSubscription = {
  name: 'Netflix',
  amount: 49.99,
  currency: 'RON',
  billingCycle: 'MONTHLY',
  nextPaymentDate: '2026-11-04',
  category: 'ENTERTAINMENT',
  isActive: true,
  notes: '',
  tags: [],
  payments: [],
  sharedWith: 0,
};

const json = (status: number, body?: unknown) =>
  ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }) as Response;

function api(respond: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchFn = jest.fn(respond);
  return { fetchFn, api: new HttpSubscriptionApi('http://server:3000', 'phone-1', 50, fetchFn as unknown as typeof fetch) };
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('HttpSubscriptionApi', () => {
  it('POSTs only the element fields (never a local id or sync state) and returns the server copy', async () => {
    const { api: client, fetchFn } = api(async () => json(201, { ...netflix, id: 9, updatedAt: 'x' }));
    const local = { ...netflix, id: 123, serverId: null, syncState: 'PENDING_CREATE' };
    expect(await client.create(local)).toEqual({ ...netflix, id: 9 });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://server:3000/subscriptions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(netflix);
    expect((init.headers as Record<string, string>)['X-Client-Id']).toBe('phone-1');
  });

  it('PUTs to the server id and DELETEs with only the id', async () => {
    const { api: client, fetchFn } = api(async (_url, init) =>
      init.method === 'DELETE' ? json(204) : json(200, { ...netflix, id: 9 }),
    );
    await client.update(9, netflix);
    await client.delete(9);
    expect(fetchFn.mock.calls.map(([url, init]) => [init.method, url, init.body])).toEqual([
      ['PUT', 'http://server:3000/subscriptions/9', JSON.stringify(netflix)],
      ['DELETE', 'http://server:3000/subscriptions/9', undefined],
    ]);
  });

  it('turns error responses into ServerError with the code and fields of the body', async () => {
    const { api: client } = api(async () =>
      json(400, { error: { code: 'VALIDATION_FAILED', message: 'Some fields are not valid', fields: { name: 'Name is required' } } }),
    );
    const error = await client.create(netflix).catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED', fields: { name: 'Name is required' } });
  });

  it('turns unreachable servers and timeouts into NetworkError', async () => {
    const { api: refused } = api(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(refused.getAll()).rejects.toBeInstanceOf(NetworkError);

    const { api: slow } = api(
      (_url, init) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    await expect(slow.getAll()).rejects.toThrow(/timed out after 50 ms/);
  });

  it('rejects malformed server data', async () => {
    const { api: client } = api(async () => json(200, [{ id: 1, name: 'No amount' }]));
    await expect(client.getAll()).rejects.toBeInstanceOf(ServerError);
  });
});

describe('friendlyError', () => {
  it('never shows raw messages', () => {
    expect(friendlyError(new NetworkError('GET /subscriptions: TypeError: Network request failed'))).toBe(strings.errorNetwork);
    expect(friendlyError(new ServerError(404, 'NOT_FOUND', 'Subscription 3 does not exist'))).toBe(strings.errorNotFound);
    expect(friendlyError(new ServerError(400, 'VALIDATION_FAILED', 'x', { name: 'a', amount: 'b' }))).toBe(
      strings.errorRejectedFields('Name, Amount'),
    );
    expect(friendlyError(new ServerError(500, 'INTERNAL', 'Internal server error'))).toBe(strings.errorServer);
    expect(friendlyError(new Error('SQLITE_FULL: database or disk is full'))).toBe(strings.errorStorage);
  });
});

describe('server events', () => {
  it('parses the server messages and rejects unknown ones', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'deleted', id: 4, origin: 'p' }))).toEqual({ type: 'deleted', id: 4, origin: 'p' });
    expect(parseServerEvent(JSON.stringify({ type: 'updated', subscription: { ...netflix, id: 4 }, origin: null }))).toEqual({
      type: 'updated',
      subscription: { ...netflix, id: 4 },
      origin: null,
    });
    expect(parseServerEvent('{"type":"nope"}')).toBeNull();
    expect(parseServerEvent('not json')).toBeNull();
  });

  it('reconnects with an increasing delay and reports online / offline', () => {
    jest.useFakeTimers();
    const sockets: Record<string, ((e?: unknown) => void) | null>[] = [];
    const source = new WebSocketEventSource('ws://server:3000/ws', () => {
      const socket = { close: jest.fn(), onopen: null, onclose: null, onmessage: null, onerror: null };
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    const handlers = { onOpen: jest.fn(), onClose: jest.fn(), onEvent: jest.fn() };
    source.start(handlers);

    sockets[0].onclose!({ code: 1006 });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sockets[1].onclose!({ code: 1006 });
    jest.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2); // second retry waits 2 s
    jest.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(3);

    sockets[2].onopen!();
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    sockets[2].onmessage!({ data: JSON.stringify({ type: 'deleted', id: 1, origin: null }) });
    expect(handlers.onEvent).toHaveBeenCalledWith({ type: 'deleted', id: 1, origin: null });

    source.stop();
    jest.useRealTimers();
  });
});
