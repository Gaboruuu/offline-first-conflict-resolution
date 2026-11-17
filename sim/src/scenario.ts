/**
 * Files a scripted configuration may refer to, resolved relative to the configuration file:
 *   "script":  a JSON file with the steps (a list, or an object whose keys are merged into the configuration);
 *   "dataset": a dataset file (dataset.ts); its clients become the default client list and its records are
 *              prepended to "initial" as setup ops.
 * Other keys a scenario carries for people (title, expected, watch) are kept and ignored by parseConfig.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { datasetOps, loadDataset } from './dataset';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function resolveIncludes(raw: unknown, baseDir: string): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  let c = raw as Record<string, unknown>;
  if (typeof c.script === 'string') {
    const { script, ...rest } = c as Record<string, unknown> & { script: string };
    const steps = readJson(resolve(baseDir, script));
    c = { kind: 'scripted', ...(Array.isArray(steps) ? { steps } : (steps as object)), ...rest };
  }
  if (typeof c.dataset === 'string') {
    const { dataset, ...rest } = c as Record<string, unknown> & { dataset: string };
    const data = loadDataset(resolve(baseDir, dataset));
    const initial = Array.isArray(rest.initial) ? rest.initial : [];
    c = {
      kind: 'scripted',
      ...rest,
      clients: rest.clients ?? data.clients,
      initial: [...datasetOps(data.subscriptions), ...initial],
    };
  }
  return c;
}

/** A scenario file of the case study, with its documentation fields. */
export interface ScenarioInfo {
  name: string;
  title: string;
  expected: string;
  watch: { id: string; fields: string[] }[];
}

export function scenarioInfo(raw: unknown): ScenarioInfo {
  const c = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const watch = Array.isArray(c.watch)
    ? c.watch.map((w) => {
        const x = w as { id?: unknown; fields?: unknown };
        return { id: str(x.id), fields: Array.isArray(x.fields) ? x.fields.map(str) : [] };
      })
    : [];
  return { name: str(c.name), title: str(c.title), expected: str(c.expected), watch };
}
