import { hybridStrategy } from '@sync-core/strategies/hybrid';
import { lwwStrategy } from '@sync-core/strategies/lww';
import { versionVectorStrategy } from '@sync-core/strategies/vv';
import { yjsStrategy } from '@sync-core/strategies/yjs';
import type { StrategyName, SyncStrategy } from '@sync-core/strategy';

/**
 * The strategies the app can run, imported one by one from sync-core (not through its index, which
 * also loads Automerge): Automerge needs WebAssembly, which Hermes does not support, so S3 runs on the
 * device only through its control implementation, Yjs. The server and the simulator run all five.
 */
export const APP_STRATEGIES: readonly SyncStrategy[] = [lwwStrategy, versionVectorStrategy, yjsStrategy, hybridStrategy];

/** Strategy of a new install; it must match the server's STRATEGY (the server's default is lww). */
export const DEFAULT_STRATEGY: StrategyName = 'lww';

export const STRATEGY_LABELS: Record<StrategyName, string> = {
  lww: 'S1 · Last-write-wins',
  vv: 'S2 · Version vectors',
  automerge: 'S3 · Automerge',
  yjs: 'S3 · Yjs (CRDT)',
  hybrid: 'S4 · Type-aware hybrid',
};

export function appStrategy(name: string): SyncStrategy | undefined {
  return APP_STRATEGIES.find((s) => s.name === name);
}
