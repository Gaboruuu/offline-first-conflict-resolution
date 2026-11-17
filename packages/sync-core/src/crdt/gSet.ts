/**
 * Grow-only set keyed by id (Shapiro et al. 2011, Specification 11), used for the append-only payment history.
 * Merge is the union. Ids are UUIDs, so one id always carries the same element; if two replicas ever disagree,
 * the element whose encoding sorts last is kept, which keeps merge commutative. The delta of an add is the
 * one-element set.
 */
import { stableStringify } from '../codec';

export type GSet<T> = Readonly<Record<string, T>>;

export const EMPTY: GSet<never> = Object.freeze({});

export function add<T>(s: GSet<T>, id: string, element: T): { state: GSet<T>; delta: GSet<T> } {
  const delta: GSet<T> = { [id]: element };
  return { state: merge(s, delta), delta };
}

/** One element of the union: `a` and `b` are the values both sides hold for the same id. */
export function mergeElement<T>(a: T, b: T): T {
  return stableStringify(a) >= stableStringify(b) ? a : b;
}

export function merge<T>(a: GSet<T>, b: GSet<T>): GSet<T> {
  const out: Record<string, T> = {};
  for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const x = a[id];
    const y = b[id];
    out[id] = x === undefined ? y! : y === undefined ? x : mergeElement(x, y);
  }
  return out;
}

export function has<T>(s: GSet<T>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(s, id);
}

/** The elements sorted by id. */
export function values<T>(s: GSet<T>): T[] {
  return Object.keys(s)
    .sort()
    .map((id) => s[id]!);
}
