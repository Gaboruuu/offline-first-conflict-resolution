import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregate, flatten, stats, summarize, tQuantile975 } from '../src/aggregate';
import { planRuns } from '../src/cli';
import { appendRun, experimentDir } from '../src/output';
import { simulate } from '../src/run';
import { parseConfig } from '../src/config';

const SMALL = {
  kind: 'random',
  name: 'small',
  seed: 5,
  clients: 2,
  initialRecords: 2,
  durationMs: 3_600_000,
  opsPerClientPerHour: 20,
  offline: { meanOnlineMs: 600_000, meanOfflineMs: 600_000 },
  skewMs: [0, 1_000],
  syncIntervalMs: 60_000,
};

test('stats: mean, sample sd and Student-t 95% interval', () => {
  const s = stats([1, 2, 3, 4]);
  assert.equal(s.mean, 2.5);
  assert.ok(Math.abs(s.sd - 1.2909944) < 1e-6);
  assert.ok(Math.abs(s.ci95 - (3.182 * s.sd) / 2) < 1e-9);
  assert.equal(stats([7]).sd, 0);
  assert.ok(Number.isNaN(stats([7]).ci95));
  assert.equal(tQuantile975(100), 1.96);
});

test('flatten keeps numbers and booleans and skips null', () => {
  assert.deepEqual(flatten({ a: 1, b: { c: true, d: null }, e: 'x' }), { a: 1, 'b.c': 1 });
});

test('a run produces the metrics of the paper', () => {
  const { result } = simulate(parseConfig({ ...SMALL, strategy: 'vv' }), 'unit');
  const m = result.metrics;
  for (const k of ['lossRate', 'concurrentLossRate', 'surfacedRate', 'causalViolations', 'converged', 'payloadBytes', 'syncRounds', 'syncCpuMs', 'stateBytes', 'metadataRatio']) {
    assert.ok(k in m, k);
  }
  assert.equal(m.converged, true);
  assert.equal(m.quiescent, true);
  assert.ok(m.payloadBytes > 0 && m.stateBytes > 0 && m.metadataRatio > 1);
  assert.ok(m.syncRounds >= 1);
  assert.equal(result.byClass.SIMPLE.ops + result.byClass.CRITICAL.ops + result.byClass.SET.ops + result.byClass.APPEND.ops + result.byClass.COUNTER.ops + result.byClass.RECORD.ops, m.ops);
});

test('runs are appended as JSON lines and aggregated per configuration and strategy', () => {
  const out = mkdtempSync(join(tmpdir(), 'sim-out-'));
  try {
    const cfgFile = join(out, 'exp.json');
    writeFileSync(cfgFile, JSON.stringify({ experiment: 'unit', strategies: ['lww', 'yjs'], runs: 2, configs: [SMALL, { ...SMALL, name: 'other', clients: 3, skewMs: [] }] }));
    const plan = planRuns(cfgFile, {});
    assert.equal(plan.experiment, 'unit');
    assert.equal(plan.runs.length, 8);
    assert.deepEqual(plan.runs.slice(0, 4).map((r) => [r.config.strategy, r.config.kind === 'random' && r.config.seed]), [
      ['lww', 5],
      ['lww', 6],
      ['yjs', 5],
      ['yjs', 6],
    ]);
    assert.equal(planRuns(cfgFile, { strategy: 'vv', runs: '1' }).runs.length, 2);
    for (const { config } of plan.runs) appendRun(simulate(config, plan.experiment).result, out);
    const lines = readFileSync(join(experimentDir('unit', out), 'runs.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 8);
    assert.equal(JSON.parse(lines[0]!).config.strategy, 'lww');

    const csv = readFileSync(aggregate('unit', out), 'utf8').trim().split('\n');
    const header = csv[0]!.split(',');
    assert.deepEqual(header.slice(0, 3), ['config', 'strategy', 'runs']);
    assert.ok(header.includes('lossRate.mean') && header.includes('lossRate.ci95'));
    assert.ok(header.includes('byClass.SIMPLE.lossRate.mean'));
    assert.deepEqual(csv.slice(1).map((r) => r.split(',').slice(0, 3).join(',')), ['small,lww,2', 'small,yjs,2', 'other,lww,2', 'other,yjs,2']);
    const col = header.indexOf('converged.mean');
    assert.ok(csv.slice(1).every((r) => r.split(',')[col] === '1'));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('summarize labels different configurations with the same name apart', () => {
  const line = (clients: number, lossRate: number) => ({ config: { name: 'x', strategy: 'lww', seed: 1, clients }, metrics: { lossRate } });
  const csv = summarize([line(2, 0.1), line(3, 0.2), line(2, 0.3)]).trim().split('\n');
  assert.deepEqual(csv.slice(1).map((r) => r.split(',').slice(0, 4).join(',')), ['x,lww,2,0.2', 'x#2,lww,1,0.2']);
  assert.throws(() => experimentDir('../evil'));
});
