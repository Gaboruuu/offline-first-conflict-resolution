import { Subscription } from '@/model/Subscription';
import { logDebug, logError } from '@/util/log';
import { fromServerJson } from './SubscriptionApi';

/** A change made on the server, pushed over the WebSocket. `origin` is the client that made it. */
export type ServerEvent =
  | { type: 'created' | 'updated'; subscription: Subscription; origin: string | null }
  | { type: 'deleted'; id: number; origin: string | null };

export interface ServerEventHandlers {
  /** The connection is (re)established: the app is online. */
  onOpen(): void;
  /** The connection was lost or could not be opened: the app is offline until the next [onOpen]. */
  onClose(): void;
  onEvent(event: ServerEvent): void;
}

/** Listens to the server's changes and tells whether the server is reachable. */
export interface ServerEventSource {
  start(handlers: ServerEventHandlers): void;
  /** Drops the current connection (if any) and connects again right away. */
  reconnect(): void;
  stop(): void;
}

export function parseServerEvent(data: string): ServerEvent | null {
  try {
    const message = JSON.parse(data);
    const origin = typeof message.origin === 'string' ? message.origin : null;
    if (message.type === 'created' || message.type === 'updated') {
      return { type: message.type, subscription: fromServerJson(message.subscription), origin };
    }
    if (message.type === 'deleted' && Number.isSafeInteger(message.id)) {
      return { type: 'deleted', id: message.id, origin };
    }
  } catch (error) {
    logError('Parse server event', error);
    return null;
  }
  logError('Parse server event', `unknown message ${data}`);
  return null;
}

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 15000;

/** [ServerEventSource] on a WebSocket, reconnecting with an increasing delay while the server is unreachable. */
export class WebSocketEventSource implements ServerEventSource {
  private socket?: WebSocket;
  private handlers?: ServerEventHandlers;
  private retryMs = MIN_RETRY_MS;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private open = false;

  constructor(
    private readonly url: string,
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
  ) {}

  start(handlers: ServerEventHandlers): void {
    if (this.handlers) return;
    this.handlers = handlers;
    this.connect();
  }

  reconnect(): void {
    if (!this.handlers) return;
    logDebug('WS', 'reconnecting now');
    this.retryMs = MIN_RETRY_MS;
    this.dropSocket();
    this.connect();
  }

  stop(): void {
    this.dropSocket();
    this.handlers = undefined;
  }

  private connect() {
    clearTimeout(this.retryTimer);
    logDebug('WS', `connecting to ${this.url}`);
    const socket = this.createSocket(this.url);
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      logDebug('WS', 'connected');
      this.open = true;
      this.retryMs = MIN_RETRY_MS;
      this.handlers?.onOpen();
    };
    socket.onmessage = (message) => {
      if (socket !== this.socket) return;
      logDebug('WS', 'message', message.data);
      const event = parseServerEvent(String(message.data));
      if (event) this.handlers?.onEvent(event);
    };
    socket.onerror = () => logDebug('WS', 'connection error');
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      logDebug('WS', `closed (code ${event.code}), retrying in ${this.retryMs} ms`);
      this.socket = undefined;
      this.open = false;
      this.handlers?.onClose();
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    };
  }

  private dropSocket() {
    clearTimeout(this.retryTimer);
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
      if (this.open) this.handlers?.onClose();
    }
    this.open = false;
  }
}
