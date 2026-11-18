import { fromBase64, toBase64 } from '@sync-core/codec';
import type { StrategyName } from '@sync-core/strategy';

import { ServerError } from './errors';
import { HttpOptions, requestJson } from './http';

/** One round of a sync session with the server replica. */
export interface SyncRequest {
  strategy: StrategyName;
  replicaId: string;
  /** This replica's next message for the server, or null when it has nothing to send. */
  message: Uint8Array | null;
}

/** Carries sync messages between this replica and the server's (`POST /sync`). */
export interface SyncTransport {
  /** Sends one message (or none) and resolves to the server's answer, null when it has nothing to send. */
  exchange(request: SyncRequest): Promise<Uint8Array | null>;
}

/**
 * [SyncTransport] over HTTP: `{ strategy, replicaId, message: base64 | null }` →
 * `{ message: base64 | null, strategy }`. A server that runs another strategy answers 409 WRONG_STRATEGY.
 */
export class HttpSyncTransport implements SyncTransport {
  constructor(private readonly options: HttpOptions) {}

  async exchange({ strategy, replicaId, message }: SyncRequest): Promise<Uint8Array | null> {
    const json = (await requestJson(this.options, 'POST', '/sync', {
      strategy,
      replicaId,
      message: message ? toBase64(message) : null,
    })) as { message?: unknown } | null;
    const reply = json?.message;
    if (reply === null || reply === undefined) return null;
    if (typeof reply !== 'string') throw new ServerError(200, 'BAD_RESPONSE', 'Expected { message: base64 | null }');
    try {
      return fromBase64(reply);
    } catch {
      throw new ServerError(200, 'BAD_RESPONSE', 'The sync message is not valid base64');
    }
  }
}
