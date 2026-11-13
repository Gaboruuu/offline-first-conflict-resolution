import type { ReplicaId } from './model';
import type { Replica } from './strategy';

/** Upper bound on message rounds in one session; a strategy that needs more is considered broken. */
export const MAX_SYNC_ROUNDS = 20;

/**
 * One sync session between replicas `a` and `b`: both sides alternate messages until neither has anything
 * to send. This loop fits Automerge's multi-round protocol, Yjs's state-vector exchange and the custom
 * strategies alike. `onMessage` is told the sender and size of every message (for payload metrics).
 */
export function syncSession(a: Replica, b: Replica, onMessage?: (from: ReplicaId, bytes: number) => void): void {
  for (let round = 0; round < MAX_SYNC_ROUNDS; round++) {
    const m1 = a.syncMessage(b.replicaId);
    if (m1) {
      onMessage?.(a.replicaId, m1.length);
      b.receive(a.replicaId, m1);
    }
    const m2 = b.syncMessage(a.replicaId);
    if (m2) {
      onMessage?.(b.replicaId, m2.length);
      a.receive(b.replicaId, m2);
    }
    if (!m1 && !m2) return;
  }
  throw new Error('sync session did not quiesce');
}
