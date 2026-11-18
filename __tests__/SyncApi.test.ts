import { fromBase64, toBase64 } from '@sync-core/codec';

import { NetworkError, ServerError } from '@/data/errors';
import { parseServerEvent, WebSocketEventSource } from '@/data/ServerEvents';
import { HttpSyncTransport } from '@/data/SyncApi';
import { strings } from '@/strings';
import { decodeUtf8 } from '@/sync/polyfills';
import { friendlyError } from '@/util/log';

const json = (status: number, body?: unknown) =>
  ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }) as Response;

function transport(respond: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchFn = jest.fn(respond);
  return {
    fetchFn,
    transport: new HttpSyncTransport({ baseUrl: 'http://server:3000', timeoutMs: 50, fetchFn: fetchFn as unknown as typeof fetch }),
  };
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

describe('HttpSyncTransport', () => {
  it('POSTs the strategy, replica id and base64 message to /sync and decodes the reply', async () => {
    const reply = new Uint8Array([7, 8, 9]);
    const { transport: t, fetchFn } = transport(async () => json(200, { message: toBase64(reply), strategy: 'lww' }));
    const sent = new Uint8Array([1, 2, 3, 4]);
    expect(await t.exchange({ strategy: 'lww', replicaId: 'app-1', message: sent })).toEqual(reply);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('http://server:3000/sync');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ strategy: 'lww', replicaId: 'app-1', message: toBase64(sent) });
    expect(fromBase64(body.message)).toEqual(sent);
  });

  it('sends null when there is nothing to send and returns null when the server has nothing', async () => {
    const { transport: t, fetchFn } = transport(async () => json(200, { message: null, strategy: 'vv' }));
    expect(await t.exchange({ strategy: 'vv', replicaId: 'app-1', message: null })).toBeNull();
    expect(JSON.parse(fetchFn.mock.calls[0][1].body as string).message).toBeNull();
  });

  it('turns error responses into ServerError with the code of the body', async () => {
    const { transport: t } = transport(async () =>
      json(409, { error: { code: 'WRONG_STRATEGY', message: 'This server runs strategy "vv", not "lww"' } }),
    );
    const error = await t.exchange({ strategy: 'lww', replicaId: 'a', message: null }).catch((e) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect(error).toMatchObject({ status: 409, code: 'WRONG_STRATEGY' });
  });

  it('turns unreachable servers and timeouts into NetworkError', async () => {
    const { transport: refused } = transport(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(refused.exchange({ strategy: 'lww', replicaId: 'a', message: null })).rejects.toBeInstanceOf(NetworkError);

    const { transport: slow } = transport(
      (_url, init) =>
        new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))),
    );
    await expect(slow.exchange({ strategy: 'lww', replicaId: 'a', message: null })).rejects.toThrow(/timed out after 50 ms/);
  });

  it('rejects malformed replies', async () => {
    const { transport: t } = transport(async () => json(200, { message: 'not base64!' }));
    await expect(t.exchange({ strategy: 'lww', replicaId: 'a', message: null })).rejects.toBeInstanceOf(ServerError);
  });
});

describe('friendlyError', () => {
  it('never shows raw messages', () => {
    expect(friendlyError(new NetworkError('POST /sync: TypeError: Network request failed'))).toBe(strings.errorNetwork);
    expect(friendlyError(new ServerError(409, 'WRONG_STRATEGY', 'x'))).toBe(strings.errorWrongStrategy);
    expect(friendlyError(new ServerError(400, 'BAD_MESSAGE', 'x'))).toBe(strings.errorRejected);
    expect(friendlyError(new ServerError(500, 'INTERNAL', 'Internal server error'))).toBe(strings.errorServer);
    expect(friendlyError(new Error('SQLITE_FULL: database or disk is full'))).toBe(strings.errorStorage);
  });
});

describe('server events', () => {
  it('parses change announcements and ignores the legacy REST events', () => {
    expect(parseServerEvent(JSON.stringify({ type: 'changed', origin: 'app-2' }))).toEqual({ type: 'changed', origin: 'app-2' });
    expect(parseServerEvent(JSON.stringify({ type: 'changed', origin: null }))).toEqual({ type: 'changed', origin: null });
    expect(parseServerEvent(JSON.stringify({ type: 'deleted', id: 4, origin: 'p' }))).toBeNull();
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
    sockets[2].onmessage!({ data: JSON.stringify({ type: 'changed', origin: 'app-2' }) });
    expect(handlers.onEvent).toHaveBeenCalledWith({ type: 'changed', origin: 'app-2' });

    source.stop();
    jest.useRealTimers();
  });
});

describe('UTF-8 decoder polyfill', () => {
  it('decodes like TextDecoder, including multi-byte characters', () => {
    for (const text of ['', 'abc', 'Plată în RON – 49,99 €', '𝄞 emoji 🎵']) {
      expect(decodeUtf8(new TextEncoder().encode(text), true)).toBe(text);
    }
  });

  it('rejects malformed input when fatal, and replaces it otherwise', () => {
    const bad = new Uint8Array([0x61, 0xc3, 0x28, 0xed, 0xa0, 0x80]);
    expect(() => decodeUtf8(bad, true)).toThrow(TypeError);
    expect(decodeUtf8(new Uint8Array([0x61, 0xff]), false)).toBe('a�');
  });
});
