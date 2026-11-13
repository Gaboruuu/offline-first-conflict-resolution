import type { StrategyName, SyncStrategy } from '../strategy';
import { automergeStrategy } from './automerge';
import { lwwStrategy } from './lww';
import { versionVectorStrategy } from './vv';
import { yjsStrategy } from './yjs';

export { automergeStrategy, actorFor } from './automerge';
export { lwwStrategy, compareEnvelopes, type LwwEnvelope } from './lww';
export { versionVectorStrategy, mergeRecords, type VvField, type VvRecord, type Version } from './vv';
export { yjsStrategy, clientIdFor } from './yjs';

/** Every strategy that the simulator, the server and the conformance suite run, in the order of the paper. */
export const ALL_STRATEGIES: readonly SyncStrategy[] = [lwwStrategy, versionVectorStrategy, automergeStrategy, yjsStrategy];

export function getStrategy(name: string): SyncStrategy {
  const strategy = ALL_STRATEGIES.find((s) => s.name === name);
  if (!strategy) {
    throw new Error(`unknown strategy ${name}; expected one of ${ALL_STRATEGIES.map((s) => s.name).join(', ')}`);
  }
  return strategy;
}

export function isStrategyName(name: unknown): name is StrategyName {
  return ALL_STRATEGIES.some((s) => s.name === name);
}
