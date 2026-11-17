import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args';

test('parses --name value, --name=value, flags and positionals', () => {
  assert.deepEqual(parseArgs(['--config', 'a.json', '--runs=3', 'e1', '--verbose']), {
    flags: { config: 'a.json', runs: '3', verbose: true },
    positional: ['e1'],
  });
});
