import { resolve } from 'node:path';

/** True when the module at `filename` (import.meta.filename) is the script node was started with. */
export function isMain(filename: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p: string): string => resolve(p).replace(/\.ts$/, '').toLowerCase();
  return norm(entry) === norm(filename);
}
