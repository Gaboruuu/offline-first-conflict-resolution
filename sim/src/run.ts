/**
 * One simulation run: build the world, run the workload, synchronise everything, judge the ops and collect the
 * metrics of the paper. The result is plain JSON (one line of runs.jsonl).
 */
import type { RunConfig } from './config';
import { judge, type OpClass, type OracleMetrics, type OutcomeCounts } from './oracle';
import { prepareRun } from './workload';
import { SERVER_ID, type World } from './world';

export interface RunMetrics extends OracleMetrics {
  /** Sum of all message lengths of the measured run and the final synchronisation (setup excluded). */
  payloadBytes: number;
  payloadBytesPerSession: number;
  payloadBytesPerOp: number;
  /** Mean messages per session (sessions that exchanged at least one message). */
  syncRounds: number;
  /** Sessions that exchanged at least one message. */
  sessions: number;
  /** Time inside syncMessage + receive (performance.now()); the only metric that is not reproducible. */
  syncCpuMs: number;
  syncCpuMsPerSession: number;
  /** save().length of the server. */
  stateBytes: number;
  stateBytesClientMean: number;
  /** stateBytes / byte length of JSON.stringify(read()), for the server. */
  metadataRatio: number;
  metadataRatioClientMean: number;
  /** Passes of the final synchronisation, including the last one that sent nothing. */
  finalPasses: number;
  quiescent: boolean;
}

export interface RunResult {
  experiment: string;
  config: RunConfig;
  metrics: RunMetrics;
  byClass: Record<OpClass, OutcomeCounts>;
}

const utf8 = new TextEncoder();

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Runs `config` to completion; also returns the world for callers that need the op log (case study). */
export function simulate(config: RunConfig, experiment = 'default'): { result: RunResult; world: World } {
  const { world, endTime } = prepareRun(config);
  world.run(endTime);
  const end = world.finish();
  const views = world.views();
  const oracle = judge({ log: world.log, final: views[0]!, views });

  const sessions = world.sessions.filter((s) => s.phase !== 'setup' && s.messages > 0);
  const payloadBytes = sessions.reduce((sum, s) => sum + s.bytesUp + s.bytesDown, 0);
  const syncCpuMs = world.sessions.filter((s) => s.phase !== 'setup').reduce((sum, s) => sum + s.cpuMs, 0);
  const state = world.stateBytes();
  const ratios = state.map((s, i) => {
    const docBytes = utf8.encode(JSON.stringify(views[i]!.docs)).length;
    return docBytes === 0 ? 0 : s.bytes / docBytes;
  });
  const clientState = state.filter((s) => s.replicaId !== SERVER_ID).map((s) => s.bytes);

  const metrics: RunMetrics = {
    ...oracle.metrics,
    payloadBytes,
    payloadBytesPerSession: sessions.length === 0 ? 0 : payloadBytes / sessions.length,
    payloadBytesPerOp: oracle.metrics.ops === 0 ? 0 : payloadBytes / oracle.metrics.ops,
    syncRounds: mean(sessions.map((s) => s.messages)),
    sessions: sessions.length,
    syncCpuMs,
    syncCpuMsPerSession: sessions.length === 0 ? 0 : syncCpuMs / sessions.length,
    stateBytes: state[0]!.bytes,
    stateBytesClientMean: mean(clientState),
    metadataRatio: ratios[0]!,
    metadataRatioClientMean: mean(ratios.slice(1)),
    finalPasses: end.passes,
    quiescent: end.quiescent,
  };
  return { result: { experiment, config, metrics, byClass: oracle.byClass }, world };
}
