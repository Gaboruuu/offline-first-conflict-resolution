/**
 * `npm run sim -- --config <file> [--strategy <name>] [--runs <n>] [--experiment <name>] [--out <dir>]`
 * The config file may also be given as the first positional argument. In PowerShell, npm's shim swallows the
 * first `--`, so options must be passed after a quoted one: `npm run sim '--' --config <file> --runs 1`.
 *
 * The config file is either one run configuration (see config.ts) or an experiment:
 *   { "experiment": "e1", "strategies": ["lww", "vv"], "runs": 10, "configs": [ {...}, {...} ] }
 * Every configuration runs once per strategy and run; run i of a random configuration uses seed + i.
 * A scripted configuration may name its steps file with "script" and its initial data with "dataset"
 * (both relative to the config file, see scenario.ts).
 * Each run appends one line to sim/out/<experiment>/runs.jsonl.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, extname } from 'node:path';
import { isStrategyName, type StrategyName } from '../../packages/sync-core/src/index';
import { parseArgs } from './args';
import { isConfigError, parseConfig, type RunConfig } from './config';
import { appendRun } from './output';
import { resolveIncludes } from './scenario';
import { simulate } from './run';
import { isMain } from './main';

interface Plan {
  experiment: string;
  runs: { config: RunConfig }[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function planRuns(path: string, flags: Record<string, string | true>): Plan {
  const file = readJson(path) as Record<string, unknown>;
  const baseDir = dirname(path);
  const isExperiment = Array.isArray(file.configs);
  const rawConfigs = (isExperiment ? (file.configs as unknown[]) : [file]).map((c) => resolveIncludes(c, baseDir));
  const experiment =
    typeof flags.experiment === 'string'
      ? flags.experiment
      : typeof file.experiment === 'string'
        ? file.experiment
        : basename(path, extname(path));
  const runsFlag = typeof flags.runs === 'string' ? Number(flags.runs) : undefined;
  const runs = runsFlag ?? (typeof file.runs === 'number' ? file.runs : 1);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  let strategies: StrategyName[] | undefined;
  if (typeof flags.strategy === 'string') {
    strategies = flags.strategy === 'all' ? ['lww', 'vv', 'automerge', 'yjs'] : flags.strategy.split(',') as StrategyName[];
  } else if (Array.isArray(file.strategies)) {
    strategies = file.strategies as StrategyName[];
  }
  for (const s of strategies ?? []) if (!isStrategyName(s)) throw new Error(`unknown strategy ${s}`);

  const out: { config: RunConfig }[] = [];
  for (const raw of rawConfigs) {
    const parsed = parseConfig(raw);
    for (const strategy of strategies ?? [parsed.strategy]) {
      const repeat = parsed.kind === 'random' ? runs : 1;
      for (let i = 0; i < repeat; i++) {
        const config: RunConfig =
          parsed.kind === 'random' ? { ...parsed, strategy, seed: parsed.seed + i } : { ...parsed, strategy };
        out.push({ config });
      }
    }
  }
  return { experiment, runs: out };
}

function main(argv: readonly string[]): void {
  const { flags, positional } = parseArgs(argv);
  const configPath = typeof flags.config === 'string' ? flags.config : positional[0];
  if (configPath === undefined) {
    console.error('usage: npm run sim -- [--config] <file> [--strategy <name|all>] [--runs <n>] [--experiment <name>] [--out <dir>]');
    process.exitCode = 2;
    return;
  }
  const plan = planRuns(configPath, flags);
  const outDir = typeof flags.out === 'string' ? flags.out : undefined;
  let file = '';
  for (const { config } of plan.runs) {
    const { result } = simulate(config, plan.experiment);
    file = appendRun(result, outDir);
    const m = result.metrics;
    const seed = config.kind === 'random' ? ` seed=${config.seed}` : '';
    console.log(
      `${config.name} ${config.strategy}${seed}: ops=${m.ops} lost=${m.lost} surfaced=${m.surfaced} ` +
        `lossRate=${m.lossRate.toFixed(4)} converged=${m.converged} payloadBytes=${m.payloadBytes}`,
    );
  }
  console.log(`${plan.runs.length} run(s) appended to ${file}`);
}

if (isMain(import.meta.filename)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (isConfigError(e) || e instanceof SyntaxError) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 2;
    } else {
      throw e;
    }
  }
}
