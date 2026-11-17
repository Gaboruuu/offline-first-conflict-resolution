/**
 * The expected outcome of every case-study scenario per strategy, checked by hand against the
 * scenario descriptions (see results.md). A change here means a strategy or the oracle changed behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StrategyName } from '../../packages/sync-core/src/index';
import { renderResults, runCaseStudy, runScenario, scenarioFiles } from '../src/caseStudy';

interface Expect {
  lost: number;
  surfaced: number;
  ambiguous?: number;
  causalViolations?: number;
  conflicts: number;
  watched: string[];
}

const EXPECTED: Record<string, Partial<Record<StrategyName, Expect>>> = {
  C1: {
    lww: { lost: 1, surfaced: 0, causalViolations: 1, conflicts: 0, watched: ['notes="Student discount until June"', 'category="MUSIC"'] },
    vv: { lost: 0, surfaced: 0, conflicts: 0, watched: ['notes="Student discount until June 2027"', 'category="MUSIC"'] },
    automerge: { lost: 0, surfaced: 0, conflicts: 0, watched: ['notes="Student discount until June 2027"', 'category="MUSIC"'] },
    yjs: { lost: 0, surfaced: 0, conflicts: 0, watched: ['notes="Student discount until June 2027"', 'category="MUSIC"'] },
    hybrid: { lost: 0, surfaced: 0, conflicts: 0, watched: ['notes="Student discount until June 2027"', 'category="MUSIC"'] },
  },
  C2: {
    lww: { lost: 1, surfaced: 0, conflicts: 0, watched: ['amountCents=14500'] },
    vv: { lost: 0, surfaced: 1, conflicts: 1, watched: ['amountCents=14500'] },
    automerge: { lost: 1, surfaced: 0, conflicts: 0, watched: ['amountCents=14500'] },
    yjs: { lost: 1, surfaced: 0, conflicts: 0, watched: ['amountCents=16000'] },
    hybrid: { lost: 0, surfaced: 1, conflicts: 1, watched: ['amountCents=14500'] },
  },
  C3: {
    lww: { lost: 0, surfaced: 0, ambiguous: 2, conflicts: 0, watched: ['notes="Resuming in January"', 'isActive=false'] },
    vv: { lost: 0, surfaced: 0, ambiguous: 2, conflicts: 1, watched: ['notes="Resuming in January"', 'isActive=false'] },
    automerge: { lost: 0, surfaced: 0, ambiguous: 2, conflicts: 0, watched: ['notes=(deleted)', 'isActive=(deleted)'] },
    yjs: { lost: 0, surfaced: 0, ambiguous: 2, conflicts: 0, watched: ['notes=(deleted)', 'isActive=(deleted)'] },
    hybrid: { lost: 0, surfaced: 0, ambiguous: 2, conflicts: 0, watched: ['notes="Resuming in January"', 'isActive=false'] },
  },
  C4: {
    lww: { lost: 1, surfaced: 0, causalViolations: 1, conflicts: 0, watched: ['name="Netflix Premium"'] },
    vv: { lost: 0, surfaced: 0, causalViolations: 0, conflicts: 0, watched: ['name="Netflix Standard"'] },
    automerge: { lost: 0, surfaced: 0, causalViolations: 0, conflicts: 0, watched: ['name="Netflix Standard"'] },
    yjs: { lost: 0, surfaced: 0, causalViolations: 0, conflicts: 0, watched: ['name="Netflix Standard"'] },
    hybrid: { lost: 0, surfaced: 0, causalViolations: 0, conflicts: 0, watched: ['name="Netflix Standard"'] },
  },
  C5: {
    lww: { lost: 3, surfaced: 0, conflicts: 0, watched: ['tags=["essential","mobile","shared"]'] },
    vv: { lost: 0, surfaced: 3, conflicts: 1, watched: ['tags=["essential","mobile","shared"]'] },
    automerge: { lost: 0, surfaced: 0, conflicts: 0, watched: ['tags=["family","mobile","shared","work"]'] },
    yjs: { lost: 0, surfaced: 0, conflicts: 0, watched: ['tags=["family","mobile","shared","work"]'] },
    hybrid: { lost: 0, surfaced: 0, conflicts: 0, watched: ['tags=["family","mobile","shared","work"]'] },
  },
  C6: {
    lww: { lost: 2, surfaced: 0, conflicts: 0, watched: ['sharedWith=2'] },
    vv: { lost: 2, surfaced: 0, conflicts: 0, watched: ['sharedWith=2'] },
    automerge: { lost: 0, surfaced: 0, conflicts: 0, watched: ['sharedWith=4'] },
    yjs: { lost: 0, surfaced: 0, conflicts: 0, watched: ['sharedWith=4'] },
    hybrid: { lost: 0, surfaced: 0, conflicts: 0, watched: ['sharedWith=4'] },
  },
};

for (const file of scenarioFiles()) {
  const name = file.slice(0, 2);
  test(`${name}: every strategy gives the outcome checked by hand`, () => {
    const expected = EXPECTED[name];
    assert.ok(expected, `no expectations for ${name}`);
    const strategies = Object.keys(expected) as StrategyName[];
    const result = runScenario(file, strategies);
    for (const run of result.runs) {
      const e: Expect = expected[run.strategy]!;
      const m = run.result.metrics;
      const got = {
        lost: m.lost,
        surfaced: m.surfaced,
        ambiguous: m.ambiguous,
        causalViolations: m.causalViolations,
        conflicts: run.conflicts,
        watched: run.watched,
      };
      assert.deepEqual(got, { ambiguous: 0, causalViolations: 0, ...e }, `${name} ${run.strategy}`);
      assert.equal(m.converged, true, `${name} ${run.strategy} converged`);
      assert.equal(m.quiescent, true);
      assert.equal(m.rejectedOps, 0);
    }
  });
}

test('the case study writes runs.jsonl, summary.csv and a reproducible results.md', () => {
  const a = mkdtempSync(join(tmpdir(), 'case-study-a-'));
  const b = mkdtempSync(join(tmpdir(), 'case-study-b-'));
  const fileA = runCaseStudy(a);
  const fileB = runCaseStudy(b);
  const md = readFileSync(fileA, 'utf8');
  assert.equal(md, readFileSync(fileB, 'utf8'));
  assert.match(md, /^# Case study results/);
  for (const s of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']) assert.match(md, new RegExp(`### ${s}: `));
  const lines = readFileSync(join(a, 'case-study', 'runs.jsonl'), 'utf8').trim().split('\n');
  const strategies = new Set(lines.map((l) => (JSON.parse(l) as { config: { strategy: string } }).config.strategy));
  assert.equal(lines.length, strategies.size * (6 + 5));
  // A second call rewrites the files instead of appending.
  runCaseStudy(a);
  assert.equal(readFileSync(join(a, 'case-study', 'runs.jsonl'), 'utf8').trim().split('\n').length, lines.length);
  assert.match(readFileSync(join(a, 'case-study', 'summary.csv'), 'utf8'), /^config,strategy,runs,/);
});

test('renderResults handles an empty random workload', () => {
  assert.match(renderResults([], []), /## Small random workload/);
});
