/** Where results go: sim/out/<experiment>/runs.jsonl, one JSON object per run. */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunResult } from './run';

/** sim/out, next to this package. */
export const DEFAULT_OUT_DIR = join(import.meta.dirname, '..', 'out');

export function experimentDir(experiment: string, outDir = DEFAULT_OUT_DIR): string {
  if (!/^[A-Za-z0-9._-]+$/.test(experiment)) throw new Error(`bad experiment name ${JSON.stringify(experiment)}`);
  return join(outDir, experiment);
}

/** The runs.jsonl line of a result (no trailing newline). */
export function toJsonLine(result: RunResult): string {
  return JSON.stringify(result);
}

export function appendRun(result: RunResult, outDir = DEFAULT_OUT_DIR): string {
  const dir = experimentDir(result.experiment, outDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'runs.jsonl');
  appendFileSync(file, `${toJsonLine(result)}\n`);
  return file;
}
