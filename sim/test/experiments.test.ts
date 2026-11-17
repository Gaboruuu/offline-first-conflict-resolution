import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { planRuns } from '../src/cli';
import { simulate } from '../src/run';

const CASE_STUDY = join(import.meta.dirname, '..', 'experiments', 'case-study.json');

test('the small random workload of the case study: 3 clients, 6 records, 2 hours, 5 seeds per strategy', () => {
  const plan = planRuns(CASE_STUDY, {});
  assert.equal(plan.experiment, 'case-study');
  assert.equal(plan.runs.length, 4 * 5);
  for (const { config } of plan.runs) {
    assert.equal(config.kind, 'random');
    if (config.kind !== 'random') continue;
    assert.equal(config.clients, 3);
    assert.equal(config.initialRecords, 6);
    assert.equal(config.durationMs, 2 * 3_600_000);
    assert.deepEqual(config.skewMs, [0, 0, -60_000]);
  }
  assert.equal(new Set(plan.runs.map((r) => (r.config.kind === 'random' ? r.config.seed : 0))).size, 5);
});

test('the random workload has about 60 ops per run, the same for every strategy', () => {
  const plan = planRuns(CASE_STUDY, { strategy: 'lww,yjs' });
  const ops = plan.runs.map(({ config }) => {
    const m = simulate(config).result.metrics;
    return m.ops + m.rejectedOps;
  });
  const lww = ops.slice(0, 5);
  const yjs = ops.slice(5);
  const mean = lww.reduce((s, x) => s + x, 0) / lww.length;
  assert.ok(mean >= 45 && mean <= 80, `mean ops ${mean}`);
  assert.deepEqual(yjs, lww);
});
