/**
 * `npm run case-study [-- --out <dir>]`: the case study of the paper (Lab 5-8, requirement 2).
 *
 * Runs the six scripted scenarios C1-C6 (scenarios/case-study) and the small random workload
 * (experiments/case-study.json) for every registered strategy, and writes to <out>/case-study/:
 *   runs.jsonl   one line per run (rewritten from scratch on every call)
 *   summary.csv  mean, sd and 95% CI per configuration and strategy (aggregate.ts)
 *   results.md   the tables of the case study, with the outcome of every scenario op
 * results.md leaves out syncCpuMs, the only metric that is not reproducible, so it is byte-identical between runs.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_STRATEGIES, type StrategyName, type SubscriptionDoc } from '../../packages/sync-core/src/index';
import { aggregate, stats } from './aggregate';
import { parseArgs } from './args';
import { planRuns } from './cli';
import { parseConfig, type ScriptedConfig } from './config';
import { isMain } from './main';
import { judge, type Outcome } from './oracle';
import { appendRun, DEFAULT_OUT_DIR, experimentDir } from './output';
import { simulate, type RunResult } from './run';
import { resolveIncludes, scenarioInfo, type ScenarioInfo } from './scenario';

export const EXPERIMENT = 'case-study';
const SIM_DIR = join(import.meta.dirname, '..');
export const SCENARIO_DIR = join(SIM_DIR, 'scenarios', 'case-study');
export const RANDOM_CONFIG = join(SIM_DIR, 'experiments', 'case-study.json');

export interface OpOutcome {
  /** e.g. "c1 setField notes". */
  label: string;
  outcome: Outcome;
}

export interface ScenarioRun {
  strategy: StrategyName;
  result: RunResult;
  /** Final value of each watched field on the server, e.g. "notes=..."; "(deleted)" for a missing record. */
  watched: string[];
  /** Unresolved conflicts on the watched records. */
  conflicts: number;
  ops: OpOutcome[];
}

export interface ScenarioResult {
  file: string;
  info: ScenarioInfo;
  runs: ScenarioRun[];
}

export function strategyNames(): StrategyName[] {
  return ALL_STRATEGIES.map((s) => s.name);
}

export function scenarioFiles(dir = SCENARIO_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => /^C\d.*\.json$/.test(f))
    .sort();
}

function describeOp(op: ScriptedConfig['steps'][number]['op']): string {
  if (!op) return '';
  switch (op.kind) {
    case 'setField':
      return `${op.field}=${JSON.stringify(op.value)}`;
    case 'addTag':
    case 'removeTag':
      return `${op.kind} ${op.tag}`;
    case 'increment':
      return `increment ${op.by > 0 ? '+' : ''}${op.by}`;
    default:
      return op.kind;
  }
}

function fieldValue(doc: SubscriptionDoc | undefined, field: string): string {
  if (!doc) return '(deleted)';
  return JSON.stringify((doc as unknown as Record<string, unknown>)[field]);
}

/** Runs one scenario file for every strategy, appending each run to runs.jsonl when `outDir` is given. */
export function runScenario(file: string, strategies = strategyNames(), outDir?: string): ScenarioResult {
  const raw = JSON.parse(readFileSync(join(SCENARIO_DIR, file), 'utf8')) as unknown;
  const info = scenarioInfo(raw);
  const parsed = parseConfig(resolveIncludes(raw, SCENARIO_DIR));
  if (parsed.kind !== 'scripted') throw new Error(`${file} is not a scripted scenario`);
  const runs = strategies.map((strategy): ScenarioRun => {
    const config: ScriptedConfig = { ...parsed, strategy };
    const { result, world } = simulate(config, EXPERIMENT);
    if (outDir !== undefined) appendRun(result, outDir);
    const views = world.views();
    const server = views[0]!;
    const { outcomes } = judge({ log: world.log, final: server, views });
    const docs = new Map(server.docs.map((d) => [d.id, d]));
    const watched = info.watch.flatMap((w) => w.fields.map((f) => `${f}=${fieldValue(docs.get(w.id), f)}`));
    const watchedIds = new Set(info.watch.map((w) => w.id));
    const ops = world.log
      .filter((r) => !r.setup)
      .map((r) => ({
        label: `${r.origin} ${describeOp(r.op)}`,
        outcome: (r.status === 'rejected' ? 'rejected' : (outcomes.get(r.id) ?? 'lost')) as Outcome,
      }));
    return {
      strategy,
      result,
      watched,
      conflicts: server.conflicts.filter((c) => watchedIds.has(c.recordId)).length,
      ops,
    };
  });
  return { file, info, runs };
}

function fmt(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return 'n/a';
  return Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

function meanSd(xs: readonly number[], digits = 3): string {
  const s = stats(xs);
  return xs.length > 1 ? `${fmt(s.mean, digits)} ± ${fmt(s.sd, digits)}` : fmt(s.mean, digits);
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

export function renderResults(scenarios: readonly ScenarioResult[], random: readonly RunResult[]): string {
  const out: string[] = [];
  out.push('# Case study results');
  out.push('');
  out.push('Generated by `npm run case-study` (sim/src/caseStudy.ts); do not edit by hand.');
  out.push('Dataset: `sim/scenarios/case-study/dataset.json` (6 subscriptions, clients c1-c3, server as hub).');
  out.push('Outcomes follow the oracle of the paper: preserved, superseded, surfaced, lost, ambiguous.');
  out.push('');
  out.push('## Scripted scenarios');
  out.push('');
  out.push('| Scenario | Strategy | Final value (server) | Lost | Surfaced | Ambiguous | Causal violations | Open conflicts | Converged | Payload (B) |');
  out.push('|---|---|---|---:|---:|---:|---:|---:|---|---:|');
  for (const s of scenarios) {
    for (const r of s.runs) {
      const m = r.result.metrics;
      out.push(
        `| ${s.info.name} | ${r.strategy} | ${cell(r.watched.join(', '))} | ${m.lost} | ${m.surfaced} | ${m.ambiguous} | ` +
          `${m.causalViolations} | ${r.conflicts} | ${m.converged ? 'yes' : 'NO'} | ${m.payloadBytes} |`,
      );
    }
  }
  out.push('');
  for (const s of scenarios) {
    out.push(`### ${s.info.name}: ${s.info.title}`);
    out.push('');
    out.push(s.info.expected);
    out.push('');
    const labels = s.runs[0]?.ops.map((o) => o.label) ?? [];
    out.push(`| Op | ${s.runs.map((r) => r.strategy).join(' | ')} |`);
    out.push(`|---|${s.runs.map(() => '---').join('|')}|`);
    labels.forEach((label, i) => {
      out.push(`| ${cell(label)} | ${s.runs.map((r) => r.ops[i]?.outcome ?? '').join(' | ')} |`);
    });
    out.push('');
  }

  out.push('## Small random workload');
  out.push('');
  const cfg = random[0]?.config;
  if (cfg && cfg.kind === 'random') {
    const seeds = random.filter((r) => r.config.strategy === cfg.strategy).length;
    out.push(
      `${cfg.clients} clients, ${cfg.initialRecords} initial records, ${cfg.durationMs / 3_600_000} simulated hours, ` +
        `${cfg.opsPerClientPerHour} ops per client per hour, skew ${JSON.stringify(cfg.skewMs)} ms, ` +
        `sync every ${cfg.syncIntervalMs / 1000} s, mean online/offline ${cfg.offline.meanOnlineMs / 60000}/` +
        `${cfg.offline.meanOfflineMs / 60000} min; ${seeds} seeds from ${cfg.seed}. Mean ± sample sd over the seeds.`,
    );
    out.push('');
  }
  out.push('| Strategy | Ops | Lost | lossRate | concurrentLossRate | surfacedRate | Causal violations | Converged | Payload (B) | Payload/op (B) | Server state (B) | metadataRatio |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|');
  for (const strategy of [...new Set(random.map((r) => r.config.strategy))]) {
    const rs = random.filter((r) => r.config.strategy === strategy).map((r) => r.metrics);
    const pick = (f: (m: RunResult['metrics']) => number | null): number[] =>
      rs.map(f).filter((x): x is number => x !== null);
    out.push(
      `| ${strategy} | ${meanSd(pick((m) => m.ops), 1)} | ${meanSd(pick((m) => m.lost), 1)} | ` +
        `${meanSd(pick((m) => m.lossRate))} | ${meanSd(pick((m) => m.concurrentLossRate))} | ` +
        `${meanSd(pick((m) => m.surfacedRate))} | ${meanSd(pick((m) => m.causalViolations), 1)} | ` +
        `${rs.filter((m) => m.converged).length}/${rs.length} | ${meanSd(pick((m) => m.payloadBytes), 0)} | ` +
        `${meanSd(pick((m) => m.payloadBytesPerOp), 1)} | ${meanSd(pick((m) => m.stateBytes), 0)} | ` +
        `${meanSd(pick((m) => m.metadataRatio), 2)} |`,
    );
  }
  out.push('');
  out.push('Lost ops by field class (sum over the seeds):');
  out.push('');
  const classes = Object.keys(random[0]?.byClass ?? {});
  out.push(`| Strategy | ${classes.join(' | ')} |`);
  out.push(`|---|${classes.map(() => '---:').join('|')}|`);
  for (const strategy of [...new Set(random.map((r) => r.config.strategy))]) {
    const rs = random.filter((r) => r.config.strategy === strategy);
    const cells = classes.map((c) => {
      const lost = rs.reduce((s, r) => s + (r.byClass[c as keyof RunResult['byClass']]?.lost ?? 0), 0);
      const ops = rs.reduce((s, r) => s + (r.byClass[c as keyof RunResult['byClass']]?.ops ?? 0), 0);
      return `${lost}/${ops}`;
    });
    out.push(`| ${strategy} | ${cells.join(' | ')} |`);
  }
  out.push('');
  return out.join('\n');
}

/** Runs the whole case study into <outDir>/case-study and returns the path of results.md. */
export function runCaseStudy(outDir = DEFAULT_OUT_DIR): string {
  const dir = experimentDir(EXPERIMENT, outDir);
  for (const f of ['runs.jsonl', 'summary.csv', 'results.md']) rmSync(join(dir, f), { force: true });
  const strategies = strategyNames();
  const scenarios = scenarioFiles().map((f) => runScenario(f, strategies, outDir));
  const plan = planRuns(RANDOM_CONFIG, { strategy: strategies.join(',') });
  const random = plan.runs.map(({ config }) => {
    const { result } = simulate(config, EXPERIMENT);
    appendRun(result, outDir);
    return result;
  });
  aggregate(EXPERIMENT, outDir);
  const file = join(dir, 'results.md');
  writeFileSync(file, renderResults(scenarios, random));
  return file;
}

if (isMain(import.meta.filename)) {
  const { flags } = parseArgs(process.argv.slice(2));
  console.log(`wrote ${runCaseStudy(typeof flags.out === 'string' ? flags.out : undefined)}`);
}
