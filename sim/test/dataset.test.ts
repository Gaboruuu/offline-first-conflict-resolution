import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ALL_STRATEGIES, applyOpToDocs, normalizeDoc, type SubscriptionDoc } from '../../packages/sync-core/src/index';
import { datasetOps, loadDataset } from '../src/dataset';
import { World } from '../src/world';

const DATASET = join(import.meta.dirname, '..', 'scenarios', 'case-study', 'dataset.json');

test('the case-study dataset has six records and three clients', () => {
  const data = loadDataset(DATASET);
  assert.deepEqual(data.clients, ['c1', 'c2', 'c3']);
  assert.equal(data.subscriptions.length, 6);
  assert.equal(new Set(data.subscriptions.map((d) => d.id)).size, 6);
});

test('datasetOps rebuilds the dataset exactly', () => {
  const data = loadDataset(DATASET);
  let docs: SubscriptionDoc[] = [];
  for (const op of datasetOps(data.subscriptions)) docs = applyOpToDocs(docs, op);
  const expected = data.subscriptions.map(normalizeDoc).sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(docs, expected);
});

for (const strategy of ALL_STRATEGIES) {
  test(`${strategy.name}: every replica starts from the dataset`, () => {
    const data = loadDataset(DATASET);
    const w = new World(strategy, data.clients.map((id) => ({ id, skewMs: 0 })));
    for (const op of datasetOps(data.subscriptions)) assert.equal(w.applyOp('server', op, true).status, 'applied');
    for (const id of data.clients) w.sync(id);
    const expected = data.subscriptions.map(normalizeDoc).sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const v of w.views()) {
      assert.deepEqual(v.docs, expected, v.replicaId);
      assert.deepEqual(v.conflicts, [], v.replicaId);
    }
  });
}
