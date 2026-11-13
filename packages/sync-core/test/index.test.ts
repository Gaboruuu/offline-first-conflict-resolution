import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index';

test('the public entry point loads', () => {
  assert.equal(typeof core.SYNC_CORE_VERSION, 'string');
});
