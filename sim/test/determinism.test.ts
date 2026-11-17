/**
 * Reproducibility: the same config and seed give a byte-identical runs.jsonl line, apart from syncCpuMs and
 * syncCpuMsPerSession (measured time). Checked for every strategy, through the same code path as the CLI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_STRATEGIES } from '../../packages/sync-core/src/index';
import { parseConfig } from '../src/config';
import { appendRun, experimentDir, toJsonLine } from '../src/output';
import { simulate } from '../src/run';

const CONFIG = {
  kind: 'random',
  name: 'determinism',
  seed: 20261117,
  clients: 4,
  initialRecords: 6,
  durationMs: 2 * 3_600_000,
  opsPerClientPerHour: 40,
  offline: { meanOnlineMs: 15 * 60_000, meanOfflineMs: 15 * 60_000 },
  skewMs: { distribution: 'normal', scale: 30_000 },
  syncIntervalMs: 45_000,
};

/** The line with every measured-time field removed. */
function reproducible(line: string): string {
  return JSON.stringify(JSON.parse(line), (key, value: unknown) => (key.startsWith('syncCpuMs') ? undefined : value));
}

for (const strategy of ALL_STRATEGIES) {
  test(`${strategy.name}: same config and seed give the same runs.jsonl line`, () => {
    const dirs = [mkdtempSync(join(tmpdir(), 'sim-a-')), mkdtempSync(join(tmpdir(), 'sim-b-'))];
    try {
      const lines = dirs.map((dir) => {
        appendRun(simulate(parseConfig({ ...CONFIG, strategy: strategy.name }), 'det').result, dir);
        return readFileSync(join(experimentDir('det', dir), 'runs.jsonl'), 'utf8');
      });
      assert.ok(lines[0]!.includes('"syncCpuMs"'));
      assert.equal(reproducible(lines[0]!), reproducible(lines[1]!));
      assert.ok(JSON.parse(lines[0]!).metrics.ops > 50);
    } finally {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a different seed gives a different run', () => {
  const a = toJsonLine(simulate(parseConfig({ ...CONFIG, strategy: 'lww' })).result);
  const b = toJsonLine(simulate(parseConfig({ ...CONFIG, strategy: 'lww', seed: CONFIG.seed + 1 })).result);
  assert.notEqual(reproducible(a), reproducible(b));
});
