import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { SyncStore } from '../src/syncStore.js';

describe('SyncStore', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'subtrack-sync-'));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null for a strategy that was never saved', () => {
    const store = new SyncStore(':memory:');
    assert.equal(store.loadState('lww'), null);
    store.close();
  });

  it('keeps one replica state per strategy and overwrites it on save', () => {
    const store = new SyncStore(':memory:');
    store.saveState('lww', new Uint8Array([1, 2, 3]));
    store.saveState('vv', new Uint8Array([9]));
    store.saveState('lww', new Uint8Array([4, 5]));
    assert.deepEqual(store.loadState('lww'), new Uint8Array([4, 5]));
    assert.deepEqual(store.loadState('vv'), new Uint8Array([9]));
    store.close();
  });

  it('persists state and the sync log in the database file across reopen', () => {
    const file = join(dir, 'nested', 'subtrack.db');
    const first = new SyncStore(file);
    first.saveState('automerge', new Uint8Array([0, 255, 7]));
    first.logSync({ strategy: 'automerge', peer: 'c1', bytesIn: 10, bytesOut: 20, rounds: 2, cpuMs: 0.5 });
    first.close();

    const second = new SyncStore(file);
    assert.deepEqual(second.loadState('automerge'), new Uint8Array([0, 255, 7]));
    const [row] = second.syncLog('automerge');
    assert.deepEqual(
      { ...row, at: undefined },
      { id: 1, at: undefined, strategy: 'automerge', peer: 'c1', bytesIn: 10, bytesOut: 20, rounds: 2, cpuMs: 0.5 },
    );
    assert.match(row.at, /^\d{4}-\d{2}-\d{2}T/);
    second.close();
  });

  it('reset removes the state and the log of one strategy only', () => {
    const store = new SyncStore(':memory:');
    store.saveState('lww', new Uint8Array([1]));
    store.saveState('yjs', new Uint8Array([2]));
    store.logSync({ strategy: 'lww', peer: 'c1', bytesIn: 1, bytesOut: 1, rounds: 2, cpuMs: 0 });
    store.logSync({ strategy: 'yjs', peer: 'c1', bytesIn: 1, bytesOut: 1, rounds: 2, cpuMs: 0 });
    store.reset('lww');
    assert.equal(store.loadState('lww'), null);
    assert.deepEqual(store.syncLog('lww'), []);
    assert.deepEqual(store.loadState('yjs'), new Uint8Array([2]));
    assert.equal(store.syncLog('yjs').length, 1);
    store.close();
  });
});
