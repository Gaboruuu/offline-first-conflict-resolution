import { BILLING_CYCLES, BillingCycle, CATEGORIES, Category, NewSubscription, Subscription } from '@/model/Subscription';
import { logDebug } from '@/util/log';
import { NetworkError, ServerError } from './errors';

/** Calls to the SubTrack REST server. `id` here is always the id assigned by the server. */
export interface SubscriptionApi {
  getAll(): Promise<Subscription[]>;
  /** Sends only the new element (no id); resolves to the stored copy with the server's id. */
  create(subscription: NewSubscription): Promise<Subscription>;
  /** Updates the server element with this id in place; rejects with a 404 [ServerError] if it is gone. */
  update(id: number, subscription: NewSubscription): Promise<Subscription>;
  /** Sends only the id. */
  delete(id: number): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 6000;

/** Only the element's fields, in the shape the server expects (never a local id or sync state). */
export function toServerBody(s: NewSubscription): NewSubscription {
  return {
    name: s.name,
    amount: s.amount,
    currency: s.currency,
    billingCycle: s.billingCycle,
    nextPaymentDate: s.nextPaymentDate,
    category: s.category,
    isActive: s.isActive,
    notes: s.notes,
    // The legacy REST server does not store these yet; the strategy-based sync (7.3) replicates them.
    tags: s.tags ?? [],
    payments: s.payments ?? [],
    sharedWith: s.sharedWith ?? 0,
  };
}

/** Checks the JSON the server returned, so a malformed answer never reaches the database. */
export function fromServerJson(json: unknown): Subscription {
  const o = json as Record<string, unknown>;
  const valid =
    o !== null &&
    typeof o === 'object' &&
    Number.isSafeInteger(o.id) &&
    typeof o.name === 'string' &&
    typeof o.amount === 'number' &&
    typeof o.currency === 'string' &&
    BILLING_CYCLES.includes(o.billingCycle as BillingCycle) &&
    typeof o.nextPaymentDate === 'string' &&
    CATEGORIES.includes(o.category as Category) &&
    typeof o.isActive === 'boolean';
  if (!valid) throw new ServerError(200, 'BAD_RESPONSE', `Unexpected subscription from the server: ${JSON.stringify(json)}`);
  return {
    id: o.id as number,
    name: o.name as string,
    amount: o.amount as number,
    currency: o.currency as string,
    billingCycle: o.billingCycle as BillingCycle,
    nextPaymentDate: o.nextPaymentDate as string,
    category: o.category as Category,
    isActive: o.isActive as boolean,
    notes: typeof o.notes === 'string' ? o.notes : '',
    tags: [],
    payments: [],
    sharedWith: 0,
  };
}

/**
 * [SubscriptionApi] over HTTP with `fetch`. Every request has a timeout; a request that never
 * reaches the server rejects with [NetworkError], an error status with [ServerError].
 */
export class HttpSubscriptionApi implements SubscriptionApi {
  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  async getAll(): Promise<Subscription[]> {
    const json = await this.request('GET', '/subscriptions');
    if (!Array.isArray(json)) throw new ServerError(200, 'BAD_RESPONSE', 'Expected a list of subscriptions');
    return json.map(fromServerJson);
  }

  async create(subscription: NewSubscription): Promise<Subscription> {
    return fromServerJson(await this.request('POST', '/subscriptions', toServerBody(subscription)));
  }

  async update(id: number, subscription: NewSubscription): Promise<Subscription> {
    return fromServerJson(await this.request('PUT', `/subscriptions/${id}`, toServerBody(subscription)));
  }

  async delete(id: number): Promise<void> {
    await this.request('DELETE', `/subscriptions/${id}`);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const started = Date.now();
    logDebug('API', `${method} ${url}`, body ?? '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Client-Id': this.clientId },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = controller.signal.aborted ? `timed out after ${this.timeoutMs} ms` : String(error);
      logDebug('API', `${method} ${url} failed: ${reason}`);
      throw new NetworkError(`${method} ${path}: ${reason}`, error);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text().catch(() => '');
    logDebug('API', `${method} ${url} → ${response.status} (${Date.now() - started} ms)`);
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      if (response.ok) throw new ServerError(response.status, 'BAD_RESPONSE', `Response is not JSON: ${text.slice(0, 100)}`);
    }
    if (!response.ok) {
      const error = (json as { error?: { code?: string; message?: string; fields?: Record<string, string> } })?.error;
      throw new ServerError(
        response.status,
        error?.code ?? `HTTP_${response.status}`,
        error?.message ?? `${method} ${path} failed with HTTP ${response.status}`,
        error?.fields,
      );
    }
    return json;
  }
}
