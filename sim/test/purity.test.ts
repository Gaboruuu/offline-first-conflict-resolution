import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Every file under sim/src. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

test('the simulator never reads the wall clock or the platform random source', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const files = sourceFiles(src);
  assert.ok(files.length > 0);
  const forbidden = /\bDate\.now\b|\bMath\.random\b|\bnew Date\b|\bcrypto\.random/;
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => assert.doesNotMatch(line, forbidden, `${file}:${i + 1}`));
  }
});
