/**
 * Workload generators: they turn a run configuration into scheduled events of a World.
 *
 * Fairness rule: for a given seed, every strategy must receive the same sequence of user intents. The random
 * generator therefore never looks at the strategy's replica. Each intent is generated from the client's *shadow*
 * state (World.shadow: the ops the client has integrated, replayed in true-time order without any conflict
 * resolution), which depends only on the causal history; and the causal history depends only on the seeded
 * schedule of ops, connectivity and sync ticks. So the client still edits only what it can see, and the intents
 * are strategy-independent. If an intent is not valid in the strategy's own state (say, an edit of a record the
 * strategy has deleted), the World logs it as rejected and the metrics report it separately.
 */
import {
  BILLING_CYCLES,
  SCALAR_FIELDS,
  getStrategy,
  type Op,
  type OpKind,
  type ScalarFields,
  type SubscriptionDoc,
} from '../../packages/sync-core/src/index';
import type { RandomConfig, RunConfig, ScriptedConfig } from './config';
import { Prng } from './prng';
import { SERVER_ID, World, type ClientSpec } from './world';

export interface PreparedRun {
  world: World;
  /** Virtual time at which the measured run ends (before the final synchronisation). */
  endTime: number;
}

/** Builds the world for `config`, loads the initial data and schedules every event of the run. */
export function prepareRun(config: RunConfig): PreparedRun {
  return config.kind === 'scripted' ? prepareScripted(config) : prepareRandom(config);
}

/** Applies initial ops on the server and lets every client download them. Marked as setup, never judged. */
function loadInitial(world: World, ops: readonly Op[]): void {
  world.setPhase('setup');
  for (const op of ops) {
    const rec = world.applyOp(SERVER_ID, op, true);
    if (rec.status !== 'applied') throw new Error(`initial op rejected: ${rec.reason ?? ''}`);
  }
  if (ops.length > 0) for (const id of world.clientIds) world.sync(id);
  world.setPhase('run');
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted workload (case study)

function prepareScripted(config: ScriptedConfig): PreparedRun {
  const clients: ClientSpec[] = config.clients.map((id) => ({ id, skewMs: config.skewMs[id] ?? 0 }));
  const world = new World(getStrategy(config.strategy), clients);
  loadInitial(world, config.initial);
  let endTime = 0;
  for (const step of config.steps) {
    endTime = Math.max(endTime, step.t);
    switch (step.do) {
      case 'op':
        world.schedule(step.t, { type: 'op', node: step.client, op: step.op! });
        break;
      case 'offline':
        world.schedule(step.t, { type: 'goOffline', client: step.client });
        break;
      case 'online':
        world.schedule(step.t, { type: 'goOnline', client: step.client });
        break;
      case 'sync':
        world.schedule(step.t, { type: 'syncTick', client: step.client });
        break;
    }
  }
  return { world, endTime };
}

// ---------------------------------------------------------------------------------------------------------------
// Random workload (experiments)

const CURRENCIES = ['RON', 'EUR', 'USD'];
const CATEGORIES = ['Streaming', 'Music', 'Cloud', 'Software', 'Fitness', 'News', 'Gaming'];
const TAGS = ['family', 'work', 'shared', 'trial', 'annual', 'student', 'essential', 'cancel-soon'];
const HOUR = 3_600_000;

export function clientIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `c${i + 1}`);
}

export function skewFor(config: RandomConfig, root: Prng): number[] {
  const spec = config.skewMs;
  if (Array.isArray(spec)) return clientIds(config.clients).map((_, i) => spec[i] ?? 0);
  const p = root.fork('skew');
  return clientIds(config.clients).map(() =>
    Math.round(spec.distribution === 'uniform' ? (p.float() * 2 - 1) * spec.scale : p.normal(0, spec.scale)),
  );
}

/** A date YYYY-MM-DD between Nov 2026 and Dec 2027 (days 1-28, so every month has it). */
function randomDate(p: Prng): string {
  const month = p.int(0, 13);
  const year = 2026 + Math.floor((10 + month) / 12);
  const m = ((10 + month) % 12) + 1;
  return `${year}-${String(m).padStart(2, '0')}-${String(p.int(1, 28)).padStart(2, '0')}`;
}

function randomFields(p: Prng, label: string): ScalarFields {
  return {
    name: label,
    amountCents: p.int(100, 20_000),
    currency: p.choice(CURRENCIES),
    billingCycle: p.choice(BILLING_CYCLES),
    nextPaymentDate: randomDate(p),
    category: p.choice(CATEGORIES),
    isActive: true,
    notes: '',
  };
}

/** A different value from the current one where the domain allows it, so that most writes change something. */
function otherThan<T>(p: Prng, items: readonly T[], current: T): T {
  const rest = items.filter((x) => x !== current);
  return p.choice(rest.length > 0 ? rest : items);
}

/**
 * The intent generator of one client. Its choices depend only on its own random stream and on the shadow
 * state, never on a strategy's replica (see the module comment).
 */
export function makeIntentGenerator(config: RandomConfig, client: string, p: Prng): (shadow: SubscriptionDoc[]) => Op {
  let counter = 0;
  return (shadow) => {
    counter++;
    let kind: OpKind = p.pick(config.opMix);
    if (shadow.length === 0) kind = 'create';
    if (kind === 'create') return { kind, id: p.uuid(), fields: randomFields(p, `${client}-new-${counter}`) };
    const doc = p.choice(shadow);
    const id = doc.id;
    switch (kind) {
      case 'setField': {
        const field = p.choice(SCALAR_FIELDS);
        switch (field) {
          case 'name':
            return { kind, id, field, value: `${client}-name-${counter}` };
          case 'notes':
            return { kind, id, field, value: `${client} note ${counter}` };
          case 'amountCents':
            return { kind, id, field, value: p.int(100, 20_000) };
          case 'currency':
            return { kind, id, field, value: otherThan(p, CURRENCIES, doc.currency) };
          case 'billingCycle':
            return { kind, id, field, value: otherThan(p, BILLING_CYCLES, doc.billingCycle) };
          case 'nextPaymentDate':
            return { kind, id, field, value: randomDate(p) };
          case 'category':
            return { kind, id, field, value: otherThan(p, CATEGORIES, doc.category) };
          case 'isActive':
            return { kind, id, field, value: !doc.isActive };
        }
        throw new Error('unreachable');
      }
      case 'removeTag':
        if (doc.tags.length > 0) return { kind, id, tag: p.choice(doc.tags) };
        return { kind: 'addTag', id, tag: p.choice(TAGS) };
      case 'addTag': {
        const missing = TAGS.filter((t) => !doc.tags.includes(t));
        return { kind, id, tag: p.choice(missing.length > 0 ? missing : TAGS) };
      }
      case 'addPayment':
        return { kind, id, payment: { id: p.uuid(), date: randomDate(p), amountCents: doc.amountCents } };
      case 'increment':
        return { kind, id, by: doc.sharedWith > 0 && p.bool() ? -1 : 1 };
      case 'delete':
        return { kind, id };
    }
  };
}

function prepareRandom(config: RandomConfig): PreparedRun {
  const root = new Prng(config.seed);
  const ids = clientIds(config.clients);
  const skews = skewFor(config, root);
  const world = new World(
    getStrategy(config.strategy),
    ids.map((id, i) => ({ id, skewMs: skews[i]! })),
    { seed: config.seed },
  );
  const setup = root.fork('setup');
  loadInitial(
    world,
    Array.from({ length: config.initialRecords }, (_, i): Op => ({
      kind: 'create',
      id: setup.uuid(),
      fields: randomFields(setup, `initial-${i + 1}`),
    })),
  );

  const end = config.durationMs;
  for (const client of ids) {
    // Separate streams per client and purpose: changing one never shifts another.
    const opStream = root.fork(`ops:${client}`);
    const netStream = root.fork(`net:${client}`);
    const syncStream = root.fork(`sync:${client}`);
    const intent = makeIntentGenerator(config, client, opStream.fork('intent'));

    if (config.opsPerClientPerHour > 0) {
      const meanGap = HOUR / config.opsPerClientPerHour;
      const arrive = (t: number): void => {
        if (t >= end) return;
        world.schedule(t, {
          type: 'call',
          run: (w) => {
            w.applyOp(client, intent);
            arrive(t + Math.max(1, Math.round(opStream.exponential(meanGap))));
          },
        });
      };
      arrive(Math.max(1, Math.round(opStream.exponential(meanGap))));
    }

    if (config.offline.meanOfflineMs > 0) {
      let t = 0;
      for (;;) {
        t += Math.max(1, Math.round(netStream.exponential(config.offline.meanOnlineMs)));
        if (t >= end) break;
        world.schedule(t, { type: 'goOffline', client });
        t += Math.max(1, Math.round(netStream.exponential(config.offline.meanOfflineMs)));
        if (t >= end) break;
        world.schedule(t, { type: 'goOnline', client });
      }
    }

    const interval = Math.round(config.syncIntervalMs);
    const first = syncStream.int(1, Math.max(1, interval));
    if (first < end) world.schedule(first, { type: 'syncTick', client, intervalMs: interval, until: end - 1 });
  }
  return { world, endTime: end };
}
