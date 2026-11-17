/**
 * `npm run aggregate -- <experiment>`: reads sim/out/<experiment>/runs.jsonl and writes summary.csv with, per
 * configuration and strategy, the mean, the sample standard deviation and the half-width of the 95% confidence
 * interval (Student t) of every metric over the runs. One row per (configuration, strategy); columns
 * `<metric>.mean`, `<metric>.sd`, `<metric>.ci95`, ready for pgfplots. Per-class metrics are
 * `byClass.<CLASS>.<outcome>` plus `byClass.<CLASS>.lossRate`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './args';
import { DEFAULT_OUT_DIR, experimentDir } from './output';
import { isMain } from './main';

/** Two-sided 97.5% quantiles of Student's t for 1..30 degrees of freedom. */
const T975 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12,
  2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export function tQuantile975(df: number): number {
  if (df < 1) return Number.NaN;
  return df <= T975.length ? T975[df - 1]! : 1.96;
}

export interface Stats {
  n: number;
  mean: number;
  sd: number;
  ci95: number;
}

export function stats(xs: readonly number[]): Stats {
  const n = xs.length;
  if (n === 0) return { n, mean: Number.NaN, sd: Number.NaN, ci95: Number.NaN };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  if (n === 1) return { n, mean, sd: 0, ci95: Number.NaN };
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  return { n, mean, sd, ci95: (tQuantile975(n - 1) * sd) / Math.sqrt(n) };
}

/** Numeric and boolean leaves of a metrics object, with dotted names. null leaves are skipped. */
export function flatten(value: unknown, prefix = ''): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof value === 'number') out[prefix] = value;
  else if (typeof value === 'boolean') out[prefix] = value ? 1 : 0;
  else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) Object.assign(out, flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

interface RunLine {
  config: Record<string, unknown> & { name?: string; strategy?: string };
  metrics: Record<string, unknown>;
  byClass?: Record<string, Record<string, number>>;
}

function metricsOf(line: RunLine): Record<string, number> {
  const byClass: Record<string, unknown> = {};
  for (const [cls, c] of Object.entries(line.byClass ?? {})) {
    byClass[cls] = { ...c, lossRate: c.ops ? (c.lost ?? 0) / c.ops : null };
  }
  return { ...flatten(line.metrics), ...flatten({ byClass }) };
}

function format(x: number): string {
  if (!Number.isFinite(x)) return '';
  return String(Number(x.toPrecision(8)));
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Builds summary.csv from the lines of runs.jsonl. Rows keep the order in which configurations first appear. */
export function summarize(lines: readonly RunLine[]): string {
  const groups = new Map<string, { config: string; strategy: string; rows: Record<string, number>[] }>();
  const labels = new Map<string, string>();
  const used = new Map<string, number>();
  for (const line of lines) {
    const { seed: _seed, strategy, ...rest } = line.config;
    const paramsKey = JSON.stringify(rest);
    let label = labels.get(paramsKey);
    if (label === undefined) {
      const base = typeof line.config.name === 'string' ? line.config.name : 'config';
      const k = (used.get(base) ?? 0) + 1;
      used.set(base, k);
      label = k === 1 ? base : `${base}#${k}`;
      labels.set(paramsKey, label);
    }
    const key = `${paramsKey}\u0000${String(strategy)}`;
    const g = groups.get(key) ?? { config: label, strategy: String(strategy), rows: [] };
    g.rows.push(metricsOf(line));
    groups.set(key, g);
  }
  const names = [...new Set([...groups.values()].flatMap((g) => g.rows.flatMap((r) => Object.keys(r))))];
  const header = ['config', 'strategy', 'runs', ...names.flatMap((m) => [`${m}.mean`, `${m}.sd`, `${m}.ci95`])];
  const out = [header.map(csvCell).join(',')];
  for (const g of groups.values()) {
    const cells = [g.config, g.strategy, String(g.rows.length)];
    for (const m of names) {
      const s = stats(g.rows.map((r) => r[m]).filter((x): x is number => x !== undefined));
      cells.push(format(s.mean), format(s.sd), format(s.ci95));
    }
    out.push(cells.map(csvCell).join(','));
  }
  return `${out.join('\n')}\n`;
}

export function aggregate(experiment: string, outDir = DEFAULT_OUT_DIR): string {
  const dir = experimentDir(experiment, outDir);
  const lines = readFileSync(join(dir, 'runs.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as RunLine);
  const file = join(dir, 'summary.csv');
  writeFileSync(file, summarize(lines));
  return file;
}

if (isMain(import.meta.filename)) {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const experiment = positional[0];
  if (!experiment) {
    console.error('usage: npm run aggregate -- <experiment> [--out <dir>]');
    process.exit(2);
  }
  console.log(`wrote ${aggregate(experiment, typeof flags.out === 'string' ? flags.out : undefined)}`);
}
