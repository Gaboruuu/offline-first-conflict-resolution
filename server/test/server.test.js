import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { WebSocket } from 'ws';

import { createApp } from '../src/app.js';
import { createLogger } from '../src/log.js';
import { SubscriptionStore } from '../src/store.js';

const netflix = {
  name: 'Netflix',
  amount: 49.99,
  currency: 'RON',
  billingCycle: 'MONTHLY',
  nextPaymentDate: '2026-11-07',
  category: 'ENTERTAINMENT',
  isActive: true,
  notes: 'Shared',
};

let app;
let base;
let dir;
let file;

async function start() {
  const store = new SubscriptionStore(file);
  await store.open([]);
  app = createApp({ store, logger: createLogger({ silent: true }) });
  const { port } = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${port}`;
}

const request = (method, path, body, clientId = 'test-client') =>
  fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function openSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const messages = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    socket.on('open', () => resolve({ socket, messages }));
    socket.on('error', reject);
  });
}

const waitFor = async (condition) => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(condition(), 'condition not met in time');
};

describe('SubTrack server', () => {
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'subtrack-'));
  });
  beforeEach(async () => {
    if (app) await app.close();
    file = join(dir, `${Date.now()}-${Math.random()}.json`);
    await start();
  });
  after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('creates with a server-assigned id, ignoring an id sent by the client', async () => {
    const response = await request('POST', '/subscriptions', { ...netflix, id: 999 });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(created.id, 1);
    assert.deepEqual({ ...created, id: undefined, updatedAt: undefined }, { ...netflix, id: undefined, updatedAt: undefined });

    const second = await (await request('POST', '/subscriptions', { ...netflix, name: 'Spotify' })).json();
    assert.equal(second.id, 2);
    const all = await (await request('GET', '/subscriptions')).json();
    assert.deepEqual(all.map((s) => s.name), ['Netflix', 'Spotify']);
  });

  it('updates in place keeping the id, and returns 404 for a missing element', async () => {
    const created = await (await request('POST', '/subscriptions', netflix)).json();
    const response = await request('PUT', `/subscriptions/${created.id}`, { ...netflix, amount: 59.99 });
    assert.equal(response.status, 200);
    const updated = await response.json();
    assert.equal(updated.id, created.id);
    assert.equal(updated.amount, 59.99);
    assert.equal((await request('GET', '/subscriptions')).status, 200);
    assert.equal((await (await request('GET', '/subscriptions')).json()).length, 1);

    const missing = await request('PUT', '/subscriptions/42', netflix);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'NOT_FOUND');
  });

  it('deletes by id only and persists every change to the data file', async () => {
    const a = await (await request('POST', '/subscriptions', netflix)).json();
    const b = await (await request('POST', '/subscriptions', { ...netflix, name: 'Spotify' })).json();
    assert.equal((await request('DELETE', `/subscriptions/${a.id}`)).status, 204);
    assert.equal((await request('DELETE', `/subscriptions/${a.id}`)).status, 404);

    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.items.map((s) => s.id), [b.id]);
    assert.equal(saved.nextId, 3); // ids are never reused
  });

  it('rejects invalid bodies with a message per field', async () => {
    const response = await request('POST', '/subscriptions', { ...netflix, name: ' ', amount: 1.234, billingCycle: 'DAILY' });
    assert.equal(response.status, 400);
    const { error } = await response.json();
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.deepEqual(Object.keys(error.fields).sort(), ['amount', 'billingCycle', 'name']);

    const badJson = await fetch(`${base}/subscriptions`, { method: 'POST', body: '{nope' });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error.code, 'BAD_JSON');
    assert.equal((await request('GET', '/subscriptions/abc')).status, 400);
  });

  it('pushes every change to the WebSocket clients, tagged with the origin client', async () => {
    const { socket, messages } = await openSocket();
    const created = await (await request('POST', '/subscriptions', netflix, 'phone-1')).json();
    await request('PUT', `/subscriptions/${created.id}`, { ...netflix, name: 'Netflix HD' }, 'phone-2');
    await request('DELETE', `/subscriptions/${created.id}`, undefined, 'phone-1');
    await waitFor(() => messages.length === 3);
    socket.close();

    assert.deepEqual(messages.map((m) => [m.type, m.origin]), [
      ['created', 'phone-1'],
      ['updated', 'phone-2'],
      ['deleted', 'phone-1'],
    ]);
    assert.equal(messages[1].subscription.name, 'Netflix HD');
    assert.equal(messages[2].id, created.id);
  });

  it('keeps the data after a restart', async () => {
    await request('POST', '/subscriptions', netflix);
    await app.close();
    await start();
    const all = await (await request('GET', '/subscriptions')).json();
    assert.deepEqual(all.map((s) => s.name), ['Netflix']);
    const next = await (await request('POST', '/subscriptions', netflix)).json();
    assert.equal(next.id, 2);
  });
});
