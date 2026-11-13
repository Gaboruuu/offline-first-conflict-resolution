/** Small helpers shared by the strategies, the simulator and the oracle. */

export type TupleItem = string | number | boolean;

function compareItem(a: TupleItem, b: TupleItem): number {
  if (typeof a !== typeof b) throw new TypeError(`cannot compare ${typeof a} with ${typeof b}`);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Lexicographic comparison of two tuples of the same shape, e.g. `(timestamp, replicaId)`.
 * Strings compare by UTF-16 code units (not locale), so the order is the same on every platform.
 * A shorter tuple that is a prefix of the longer one sorts first.
 */
export function compareTuple(a: readonly TupleItem[], b: readonly TupleItem[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareItem(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** A sorted copy of `items`, ordered by the key (a single value or a tuple). Stable. */
export function sortedBy<T>(items: Iterable<T>, key: (item: T) => TupleItem | readonly TupleItem[]): T[] {
  const tuple = (item: T): readonly TupleItem[] => {
    const k = key(item);
    return Array.isArray(k) ? k : [k as TupleItem];
  };
  return [...items]
    .map((item) => ({ item, k: tuple(item) }))
    .sort((x, y) => compareTuple(x.k, y.k))
    .map((x) => x.item);
}

/**
 * Structural equality for JSON-like values and Uint8Array: same primitive values (NaN equals NaN),
 * arrays element by element, plain objects with the same own keys. Key order does not matter.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    if (!(a instanceof Uint8Array && b instanceof Uint8Array) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], bb[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(rb, k) || !deepEqual(ra[k], rb[k])) return false;
  }
  return true;
}
