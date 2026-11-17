/**
 * Discrete-event simulation of N clients and one server running the same sync strategy (star topology).
 *
 * Time is virtual: `t` is milliseconds since the start of the run and advances only from event to event.
 * Each client's `Env.now()` returns `T0 + t + skewMs`, so clock skew is injected exactly where the strategies
 * read the clock. The world also keeps the causal history of every op (see causality.ts) for the oracle.
 */
import { performance } from 'node:perf_hooks';
import {
  applyOpToDocs,
  syncSession,
  validateOp,
  type Conflict,
  type Env,
  type Op,
  type Replica,
  type SubscriptionDoc,
  type SyncStrategy,
} from '../../packages/sync-core/src/index';
import { mergeSeen, type Seen } from './causality';
import { EventQueue } from './queue';
import { Prng } from './prng';

/** Wall-clock origin of every run: 1 Nov 2026 00:00 UTC. A fixed origin keeps clocks positive under negative skew. */
export const T0 = 1_793_491_200_000;

export const SERVER_ID = 'server';

/** Upper bound on the passes of the final synchronisation. */
export const MAX_FINAL_PASSES = 10;

export interface ClientSpec {
  id: string;
  /** Offset of this client's wall clock from true time, in ms (positive = clock runs ahead). */
  skewMs: number;
}

/** An op given literally (scripted workloads) or generated from what the client believes it sees. */
export type OpSource = Op | ((shadow: SubscriptionDoc[], client: string) => Op);

export type SimEvent =
  | { type: 'op'; node: string; op: OpSource; setup?: boolean }
  | { type: 'goOffline'; client: string }
  | { type: 'goOnline'; client: string }
  | { type: 'syncTick'; client: string; intervalMs?: number; until?: number }
  /** Escape hatch for workload generators, e.g. to schedule the next arrival of a Poisson process. */
  | { type: 'call'; run: (world: World) => void };

export type Phase = 'setup' | 'run' | 'final';

export interface OpRecord {
  /** `<origin>:<seq>` for applied ops, `<origin>:rejected:<n>` for rejected ones. */
  id: string;
  origin: string;
  /** 1-based among the ops applied by `origin`; 0 for a rejected op. */
  seq: number;
  /** True time (virtual ms since the start). */
  t: number;
  op: Op;
  /** What `origin` had integrated just before this op. */
  seen: Seen;
  status: 'applied' | 'rejected';
  /** Why the replica refused the op (it is valid in the shadow state, but not in this strategy's state). */
  reason?: string;
  /** Initial data loaded before the measured run; never judged by the oracle. */
  setup: boolean;
}

export interface SessionStat {
  t: number;
  client: string;
  phase: Phase;
  bytesUp: number;
  bytesDown: number;
  messages: number;
  cpuMs: number;
}

export interface ReplicaView {
  replicaId: string;
  docs: SubscriptionDoc[];
  conflicts: Conflict[];
}

interface Node {
  id: string;
  replica: Replica;
  skewMs: number;
  online: boolean;
  seen: Record<string, number>;
  applied: number;
  rejected: number;
  shadow?: { key: string; docs: SubscriptionDoc[] };
}

export class World {
  /** Current virtual time. */
  t = 0;
  readonly log: OpRecord[] = [];
  readonly sessions: SessionStat[] = [];
  private readonly queue = new EventQueue<SimEvent>();
  private readonly nodes = new Map<string, Node>();
  private readonly order: string[] = [];
  private phase: Phase = 'run';

  constructor(
    readonly strategy: SyncStrategy,
    clients: readonly ClientSpec[],
    options: { seed?: number } = {},
  ) {
    const ids = new Prng(options.seed ?? 0).fork('newId');
    this.addNode(SERVER_ID, 0, ids);
    for (const c of clients) {
      if (c.id === SERVER_ID || this.nodes.has(c.id)) throw new Error(`duplicate replica id ${c.id}`);
      if (!Number.isFinite(c.skewMs)) throw new Error(`skew of ${c.id} must be finite`);
      this.addNode(c.id, c.skewMs, ids);
      this.order.push(c.id);
    }
  }

  private addNode(id: string, skewMs: number, ids: Prng): void {
    const idStream = ids.fork(id);
    const env: Env = {
      now: () => Math.floor(T0 + this.t + skewMs),
      newId: () => idStream.uuid(),
    };
    this.nodes.set(id, {
      id,
      replica: this.strategy.create(id, env),
      skewMs,
      online: true,
      seen: {},
      applied: 0,
      rejected: 0,
    });
  }

  /** Client ids in creation order. */
  get clientIds(): readonly string[] {
    return this.order;
  }

  replica(id: string): Replica {
    return this.node(id).replica;
  }

  isOnline(client: string): boolean {
    return this.node(client).online;
  }

  seenOf(id: string): Seen {
    return { ...this.node(id).seen };
  }

  private node(id: string): Node {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`unknown replica ${id}`);
    return n;
  }

  schedule(t: number, event: SimEvent): void {
    if (t < this.t) throw new Error(`cannot schedule an event in the past (${t} < ${this.t})`);
    this.queue.push(t, event);
  }

  /** Processes every event with time <= `until` (all events when omitted), in time order. */
  run(until = Infinity): void {
    for (;;) {
      const next = this.queue.peekTime();
      if (next === undefined || next > until) break;
      const { t, event } = this.queue.pop()!;
      this.t = t;
      this.dispatch(event);
    }
    if (Number.isFinite(until) && until > this.t) this.t = until;
  }

  private dispatch(e: SimEvent): void {
    switch (e.type) {
      case 'op':
        this.applyOp(e.node, e.op, e.setup ?? false);
        return;
      case 'goOffline':
        this.node(e.client).online = false;
        return;
      case 'goOnline': {
        const n = this.node(e.client);
        if (!n.online) {
          n.online = true;
          // Like the app, a client synchronises as soon as it is back online.
          this.sync(e.client);
        }
        return;
      }
      case 'syncTick':
        this.sync(e.client);
        if (e.intervalMs !== undefined && e.intervalMs > 0) {
          const next = this.t + e.intervalMs;
          if (e.until === undefined || next <= e.until) this.schedule(next, e);
        }
        return;
      case 'call':
        e.run(this);
        return;
    }
  }

  /**
   * What `id` would see if every op it has integrated were applied in true-time order, with no conflict
   * resolution at all. It depends only on the causal history, never on the strategy, which is what lets the
   * random workload generate the same intents for every strategy.
   */
  shadow(id: string): SubscriptionDoc[] {
    const n = this.node(id);
    const key = JSON.stringify(n.seen);
    if (n.shadow?.key === key) return n.shadow.docs.map(cloneDoc);
    const ops = this.log
      .filter((r) => r.status === 'applied' && r.seq <= (n.seen[r.origin] ?? 0))
      .sort((a, b) => a.t - b.t || cmp(a.origin, b.origin) || a.seq - b.seq);
    let docs: SubscriptionDoc[] = [];
    for (const r of ops) {
      if (validateOp(r.op, docs).ok) docs = applyOpToDocs(docs, r.op);
    }
    n.shadow = { key, docs };
    return docs.map(cloneDoc);
  }

  /** A local user intent on replica `id` at the current time. Returns the log record. */
  applyOp(id: string, source: OpSource, setup = false): OpRecord {
    const n = this.node(id);
    const op = typeof source === 'function' ? source(this.shadow(id), id) : source;
    const seen = { ...n.seen };
    const check = validateOp(op, n.replica.read());
    if (!check.ok) {
      n.rejected++;
      const rec: OpRecord = {
        id: `${id}:rejected:${n.rejected}`,
        origin: id,
        seq: 0,
        t: this.t,
        op,
        seen,
        status: 'rejected',
        reason: check.reason,
        setup,
      };
      this.log.push(rec);
      return rec;
    }
    n.replica.apply(op);
    n.applied++;
    const rec: OpRecord = { id: `${id}:${n.applied}`, origin: id, seq: n.applied, t: this.t, op, seen, status: 'applied', setup };
    this.log.push(rec);
    const oldKey = JSON.stringify(n.seen);
    n.seen = mergeSeen(n.seen, { [id]: n.applied });
    // The op is later in true time than everything the node has seen, so the cached shadow stays exact.
    if (n.shadow?.key === oldKey && validateOp(op, n.shadow.docs).ok) {
      n.shadow = { key: JSON.stringify(n.seen), docs: applyOpToDocs(n.shadow.docs, op) };
    }
    return rec;
  }

  /**
   * One sync session between `client` and the server, measured. Returns null (and does nothing) when the
   * client is offline. Afterwards each side has integrated everything the other had.
   */
  sync(client: string): SessionStat | null {
    const c = this.node(client);
    if (client === SERVER_ID) throw new Error('the server does not start sessions');
    if (!c.online) return null;
    const s = this.node(SERVER_ID);
    let bytesUp = 0;
    let bytesDown = 0;
    let messages = 0;
    const start = performance.now();
    syncSession(c.replica, s.replica, (from, bytes) => {
      messages++;
      if (from === client) bytesUp += bytes;
      else bytesDown += bytes;
    });
    const cpuMs = performance.now() - start;
    const union = mergeSeen(c.seen, s.seen);
    c.seen = union;
    s.seen = { ...union };
    const stat: SessionStat = { t: this.t, client, phase: this.phase, bytesUp, bytesDown, messages, cpuMs };
    this.sessions.push(stat);
    return stat;
  }

  /** Marks the following ops and sessions as initial data (`setup`) or as the measured run. */
  setPhase(phase: Phase): void {
    this.phase = phase;
  }

  /**
   * Runs the remaining events, then brings every client online and lets each one sync with the server in turn
   * until a full pass sends zero bytes (at most MAX_FINAL_PASSES passes).
   */
  finish(): { passes: number; quiescent: boolean } {
    this.run();
    this.setPhase('final');
    for (const id of this.order) this.node(id).online = true;
    for (let pass = 1; pass <= MAX_FINAL_PASSES; pass++) {
      let bytes = 0;
      for (const id of this.order) {
        const stat = this.sync(id)!;
        bytes += stat.bytesUp + stat.bytesDown;
      }
      if (bytes === 0) return { passes: pass, quiescent: true };
    }
    return { passes: MAX_FINAL_PASSES, quiescent: false };
  }

  /** read() and conflicts() of the server and every client (server first). */
  views(): ReplicaView[] {
    return [SERVER_ID, ...this.order].map((id) => {
      const r = this.node(id).replica;
      return { replicaId: id, docs: r.read(), conflicts: r.conflicts() };
    });
  }

  /** `save().length` of every replica (server first). */
  stateBytes(): { replicaId: string; bytes: number }[] {
    return [SERVER_ID, ...this.order].map((id) => ({ replicaId: id, bytes: this.node(id).replica.save().length }));
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneDoc(d: SubscriptionDoc): SubscriptionDoc {
  return { ...d, tags: [...d.tags], payments: d.payments.map((p) => ({ ...p })) };
}
