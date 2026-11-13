import type { RecordId, ReplicaId } from '../model';

/**
 * Per-peer bookkeeping shared by the custom strategies (S1, S2, S4): which records still have to be sent to
 * a peer, and the acknowledgement protocol.
 *
 * Every message to a peer gets a sequence number `m` (1, 2, ...) and carries `a`, the highest `m` received
 * from that peer. A record is "dirty" for a peer until a message that contained it is acknowledged.
 * `sent` is the `m` of the message that last carried the record, or 0 if the current version has not
 * been sent yet. A session alternates strictly and every data message is answered (at least by an
 * acknowledgement), so a data message is considered lost, and its records are sent again, when the peer's
 * next message acknowledges less than it, or when we are asked for another message before any answer came.
 *
 * A message that carries data must be acknowledged; an acknowledgement-only message is not, so two quiet
 * replicas never ping-pong.
 */
export interface PeerState {
  /** `m` of the last message sent to the peer. */
  out: number;
  /** Highest `m` received from the peer. */
  in: number;
  /** True when a data message from the peer has not been acknowledged yet. */
  ackDue: boolean;
  /** True when our last data message to the peer has not been answered yet. */
  awaiting: boolean;
  /** Record id → `m` of the message that carried it, 0 = not sent yet. */
  dirty: Record<RecordId, number>;
}

export interface MessageHeader {
  /** Sequence number of this message. */
  m: number;
  /** Highest sequence number received from the recipient. */
  a: number;
}

export class PeerLog {
  private peers: Record<ReplicaId, PeerState>;

  constructor(
    private readonly allRecordIds: () => RecordId[],
    peers: Record<ReplicaId, PeerState> = {},
  ) {
    this.peers = peers;
  }

  /** The state for `peer`; a peer seen for the first time has every record dirty. */
  private state(peer: ReplicaId): PeerState {
    let s = this.peers[peer];
    if (!s) {
      const dirty: Record<RecordId, number> = {};
      for (const id of this.allRecordIds()) dirty[id] = 0;
      s = { out: 0, in: 0, ackDue: false, awaiting: false, dirty };
      this.peers[peer] = s;
    }
    return s;
  }

  /** A record changed: it must be (re)sent to every known peer except `except`. */
  markDirty(id: RecordId, except?: ReplicaId): void {
    for (const [peer, s] of Object.entries(this.peers)) {
      if (peer !== except) s.dirty[id] = 0;
    }
  }

  /** The record must be (re)sent to `peer` only. */
  markDirtyFor(peer: ReplicaId, id: RecordId): void {
    this.state(peer).dirty[id] = 0;
  }

  /** The peer already has the current version of the record. */
  markClean(peer: ReplicaId, id: RecordId): void {
    const s = this.state(peer);
    if (s.dirty[id] === 0) delete s.dirty[id];
  }

  /** Records not yet sent to `peer`, sorted by id. */
  unsent(peer: ReplicaId): RecordId[] {
    const s = this.state(peer);
    this.retryUnanswered(s);
    return Object.keys(s.dirty)
      .filter((id) => s.dirty[id] === 0)
      .sort();
  }

  /** True when there is something to send to `peer` (data or a due acknowledgement). */
  hasWork(peer: ReplicaId): boolean {
    const s = this.state(peer);
    this.retryUnanswered(s);
    return s.ackDue || Object.values(s.dirty).some((m) => m === 0);
  }

  /** Header for the next message to `peer`; records `ids` are marked as carried by it. */
  nextHeader(peer: ReplicaId, ids: readonly RecordId[]): MessageHeader {
    const s = this.state(peer);
    s.out += 1;
    for (const id of ids) s.dirty[id] = s.out;
    s.ackDue = false;
    if (ids.length > 0) s.awaiting = true;
    return { m: s.out, a: s.in };
  }

  /**
   * Processes the header of a message from `peer`. Returns false for a duplicate or out-of-date message,
   * which the caller must then ignore entirely (this makes `receive` idempotent).
   */
  accept(peer: ReplicaId, header: MessageHeader, hasData: boolean): boolean {
    const s = this.state(peer);
    if (header.m <= s.in) return false;
    s.in = header.m;
    s.awaiting = false;
    if (hasData) s.ackDue = true;
    for (const [id, m] of Object.entries(s.dirty)) {
      if (m === 0) continue;
      if (m <= header.a) delete s.dirty[id];
      else s.dirty[id] = 0; // the message that carried it was lost
    }
    return true;
  }

  /** We are about to send again without having heard back: the previous data message was lost. */
  private retryUnanswered(s: PeerState): void {
    if (!s.awaiting) return;
    for (const id of Object.keys(s.dirty)) s.dirty[id] = 0;
    s.awaiting = false;
  }

  toJSON(): Record<ReplicaId, PeerState> {
    return this.peers;
  }
}
