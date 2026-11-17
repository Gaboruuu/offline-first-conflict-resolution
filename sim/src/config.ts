/**
 * Run configurations. A run is either *scripted* (a fixed list of timed steps, used by the case study) or
 * *random* (a seeded workload, used by the experiments). `parseConfig` checks a parsed JSON value and fills in
 * defaults, so that the rest of the simulator can trust the types.
 */
import { isStrategyName, type Op, type OpKind, type StrategyName } from '../../packages/sync-core/src/index';

export const OP_KINDS: readonly OpKind[] = [
  'create',
  'setField',
  'addTag',
  'removeTag',
  'addPayment',
  'increment',
  'delete',
];

export type SkewSpec = number[] | { distribution: 'uniform' | 'normal'; scale: number };

export interface RandomConfig {
  kind: 'random';
  name: string;
  seed: number;
  strategy: StrategyName;
  /** Number of clients, named c1..cN. */
  clients: number;
  /** Records created on the server and downloaded by every client before the measured run. */
  initialRecords: number;
  durationMs: number;
  opsPerClientPerHour: number;
  /** Relative weights of the op kinds. */
  opMix: Partial<Record<OpKind, number>>;
  /** Mean length of the online and offline periods (exponentially distributed). meanOfflineMs 0 = always online. */
  offline: { meanOnlineMs: number; meanOfflineMs: number };
  /** Per-client skew (missing entries are 0), or a distribution with scale in ms. */
  skewMs: SkewSpec;
  syncIntervalMs: number;
}

export type ScriptAction = 'op' | 'offline' | 'online' | 'sync';

export interface ScriptStep {
  t: number;
  client: string;
  do: ScriptAction;
  op?: Op;
}

export interface ScriptedConfig {
  kind: 'scripted';
  name: string;
  strategy: StrategyName;
  /** Client ids, e.g. ["c1", "c2", "c3"]. */
  clients: string[];
  /** Clock skew per client in ms; missing clients have none. */
  skewMs: Record<string, number>;
  /** Initial data: ops applied on the server and downloaded by every client before the steps run. */
  initial: Op[];
  steps: ScriptStep[];
}

export type RunConfig = RandomConfig | ScriptedConfig;

export const DEFAULT_OP_MIX: Readonly<Record<OpKind, number>> = {
  create: 1,
  setField: 10,
  addTag: 2,
  removeTag: 1,
  addPayment: 2,
  increment: 2,
  delete: 0.5,
};

class ConfigError extends Error {}

function fail(path: string, message: string): never {
  throw new ConfigError(`config ${path}: ${message}`);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object');
  return v as Record<string, unknown>;
}

function num(v: unknown, path: string, opts: { min?: number; integer?: boolean } = {}): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number');
  if (opts.integer && !Number.isInteger(v)) fail(path, 'must be an integer');
  if (opts.min !== undefined && v < opts.min) fail(path, `must be >= ${opts.min}`);
  return v;
}

function strategyOf(v: unknown, path: string): StrategyName {
  if (!isStrategyName(v)) fail(path, `unknown strategy ${JSON.stringify(v)}`);
  return v;
}

function parseRandom(c: Record<string, unknown>): RandomConfig {
  const opMix = c.opMix === undefined ? { ...DEFAULT_OP_MIX } : obj(c.opMix, 'opMix');
  for (const [k, w] of Object.entries(opMix)) {
    if (!(OP_KINDS as readonly string[]).includes(k)) fail(`opMix.${k}`, 'unknown op kind');
    num(w, `opMix.${k}`, { min: 0 });
  }
  if (!Object.values(opMix).some((w) => (w as number) > 0)) fail('opMix', 'needs a positive weight');
  const offline = c.offline === undefined ? { meanOnlineMs: 1, meanOfflineMs: 0 } : obj(c.offline, 'offline');
  let skewMs: SkewSpec = [];
  if (Array.isArray(c.skewMs)) {
    skewMs = c.skewMs.map((s, i) => num(s, `skewMs[${i}]`));
  } else if (c.skewMs !== undefined) {
    const s = obj(c.skewMs, 'skewMs');
    if (s.distribution !== 'uniform' && s.distribution !== 'normal') fail('skewMs.distribution', 'uniform or normal');
    skewMs = { distribution: s.distribution, scale: num(s.scale, 'skewMs.scale', { min: 0 }) };
  }
  const clients = num(c.clients, 'clients', { min: 1, integer: true });
  return {
    kind: 'random',
    name: typeof c.name === 'string' ? c.name : 'random',
    seed: num(c.seed ?? 1, 'seed', { integer: true }),
    strategy: strategyOf(c.strategy ?? 'lww', 'strategy'),
    clients,
    initialRecords: num(c.initialRecords ?? 0, 'initialRecords', { min: 0, integer: true }),
    durationMs: num(c.durationMs, 'durationMs', { min: 1 }),
    opsPerClientPerHour: num(c.opsPerClientPerHour, 'opsPerClientPerHour', { min: 0 }),
    opMix: opMix as Partial<Record<OpKind, number>>,
    offline: {
      meanOnlineMs: num(offline.meanOnlineMs, 'offline.meanOnlineMs', { min: 1 }),
      meanOfflineMs: num(offline.meanOfflineMs, 'offline.meanOfflineMs', { min: 0 }),
    },
    skewMs,
    syncIntervalMs: num(c.syncIntervalMs, 'syncIntervalMs', { min: 1 }),
  };
}

function parseScripted(c: Record<string, unknown>): ScriptedConfig {
  if (!Array.isArray(c.clients) || c.clients.length === 0) fail('clients', 'must be a non-empty list of ids');
  const clients = c.clients.map((id, i) => {
    if (typeof id !== 'string' || id === '' || id === 'server') fail(`clients[${i}]`, 'must be a client id');
    return id;
  });
  const skew = c.skewMs === undefined ? {} : obj(c.skewMs, 'skewMs');
  for (const [k, v] of Object.entries(skew)) {
    if (!clients.includes(k)) fail(`skewMs.${k}`, 'unknown client');
    num(v, `skewMs.${k}`);
  }
  const initial = c.initial === undefined ? [] : c.initial;
  if (!Array.isArray(initial)) fail('initial', 'must be a list of ops');
  if (!Array.isArray(c.steps)) fail('steps', 'must be a list');
  let last = 0;
  const steps = c.steps.map((raw, i): ScriptStep => {
    const s = obj(raw, `steps[${i}]`);
    const t = num(s.t, `steps[${i}].t`, { min: 0 });
    if (t < last) fail(`steps[${i}].t`, 'steps must be in time order');
    last = t;
    const client = s.client;
    if (typeof client !== 'string' || !(clients.includes(client) || (client === 'server' && s.do === 'op'))) {
      fail(`steps[${i}].client`, 'unknown client');
    }
    if (s.do !== 'op' && s.do !== 'offline' && s.do !== 'online' && s.do !== 'sync') {
      fail(`steps[${i}].do`, 'must be op, offline, online or sync');
    }
    if (s.do === 'op') {
      obj(s.op, `steps[${i}].op`);
      return { t, client, do: 'op', op: s.op as Op };
    }
    return { t, client, do: s.do };
  });
  return {
    kind: 'scripted',
    name: typeof c.name === 'string' ? c.name : 'scripted',
    strategy: strategyOf(c.strategy ?? 'lww', 'strategy'),
    clients,
    skewMs: skew as Record<string, number>,
    initial: initial as Op[],
    steps,
  };
}

export function parseConfig(value: unknown): RunConfig {
  const c = obj(value, '(root)');
  if (c.kind === 'scripted' || (c.kind === undefined && Array.isArray(c.steps))) return parseScripted(c);
  if (c.kind === 'random' || c.kind === undefined) return parseRandom(c);
  fail('kind', 'must be random or scripted');
}

export function isConfigError(e: unknown): e is Error {
  return e instanceof ConfigError;
}
