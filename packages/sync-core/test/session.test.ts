import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncSession, type Replica } from '../src/index';

/** A toy replica: a grow-only set of numbers that sends what the peer has not acknowledged yet. */
function setReplica(replicaId: string, initial: number[]): Replica & { items: Set<number> } {
  const items = new Set(initial);
  const known = new Map<string, Set<number>>();
  const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
  return {
    replicaId,
    items,
    apply: () => {},
    read: () => [],
    conflicts: () => [],
    resolve: () => {},
    syncMessage(peer) {
      const k = known.get(peer) ?? new Set();
      const missing = [...items].filter((x) => !k.has(x));
      if (missing.length === 0) return null;
      for (const x of missing) k.add(x);
      known.set(peer, k);
      return enc(missing);
    },
    receive(peer, message) {
      const k = known.get(peer) ?? new Set();
      for (const x of JSON.parse(new TextDecoder().decode(message)) as number[]) {
        items.add(x);
        k.add(x);
      }
      known.set(peer, k);
    },
    save: () => enc([...items]),
  };
}

test('syncSession exchanges messages until both sides are quiet', () => {
  const a = setReplica('a', [1, 2]);
  const b = setReplica('b', [3]);
  const log: [string, number][] = [];
  syncSession(a, b, (from, bytes) => log.push([from, bytes]));
  assert.deepEqual([...a.items].sort(), [1, 2, 3]);
  assert.deepEqual([...b.items].sort(), [1, 2, 3]);
  assert.deepEqual(log, [
    ['a', 5],
    ['b', 3],
  ]);
  assert.equal(a.syncMessage('b'), null);
  assert.equal(b.syncMessage('a'), null);
});

test('syncSession throws when a replica never quiesces', () => {
  const chatty = { ...setReplica('a', []), syncMessage: () => new TextEncoder().encode('[0]') };
  assert.throws(() => syncSession(chatty, setReplica('b', [])), /did not quiesce/);
});
