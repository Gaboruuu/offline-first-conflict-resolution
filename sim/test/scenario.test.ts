import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config';
import { resolveIncludes, scenarioInfo } from '../src/scenario';
import { planRuns } from '../src/cli';

const DIR = join(import.meta.dirname, '..', 'scenarios', 'case-study');
const SCENARIOS = readdirSync(DIR).filter((f) => /^C\d.*\.json$/.test(f)).sort();

test('the case study has the six scenarios C1-C6', () => {
  assert.deepEqual(
    SCENARIOS.map((f) => f.slice(0, 2)),
    ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'],
  );
});

for (const file of SCENARIOS) {
  test(`${file} is a documented scripted configuration on top of the dataset`, () => {
    const raw = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    const info = scenarioInfo(raw);
    assert.equal(info.name, file.slice(0, 2));
    assert.ok(info.title.length > 0 && info.expected.startsWith('Ideal outcome'));
    assert.ok(info.watch.length > 0);
    const config = parseConfig(resolveIncludes(raw, DIR));
    assert.equal(config.kind, 'scripted');
    if (config.kind !== 'scripted') return;
    assert.deepEqual(config.clients, ['c1', 'c2', 'c3']);
    assert.equal(config.initial.filter((op) => op.kind === 'create').length, 6);
    assert.ok(config.steps.some((s) => s.do === 'op'));
  });
}

test('resolveIncludes inlines a steps file and keeps explicit clients and initial ops', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scenario-'));
  writeFileSync(join(dir, 'steps.json'), JSON.stringify([{ t: 1, client: 'c1', do: 'sync' }]));
  writeFileSync(join(dir, 'data.json'), JSON.stringify({ clients: ['a', 'b'], subscriptions: [] }));
  const extra = { kind: 'delete', id: 'x' };
  const out = resolveIncludes({ script: 'steps.json', dataset: 'data.json', clients: ['c1'], initial: [extra] }, dir);
  assert.deepEqual(out, {
    kind: 'scripted',
    steps: [{ t: 1, client: 'c1', do: 'sync' }],
    clients: ['c1'],
    initial: [extra],
  });
});

test('the CLI plans one run per strategy for a scenario file', () => {
  const plan = planRuns(join(DIR, SCENARIOS[0]!), { strategy: 'lww,vv' });
  assert.deepEqual(
    plan.runs.map((r) => r.config.strategy),
    ['lww', 'vv'],
  );
});
