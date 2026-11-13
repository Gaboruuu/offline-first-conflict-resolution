import type { ReplicaId } from '../model';

/**
 * Version vector: for each replica, the number of events of that replica that have been seen.
 * Entries equal to 0 are never stored, so equal vectors are also deep-equal. Values are immutable:
 * every function returns a new vector.
 */
export type VersionVector = Readonly<Record<ReplicaId, number>>;

/** A single event: the `counter`-th event of `replica`. */
export interface Dot {
  replica: ReplicaId;
  counter: number;
}

export type Ordering = 'before' | 'after' | 'equal' | 'concurrent';

export const EMPTY_VV: VersionVector = Object.freeze({});

export function get(vv: VersionVector, replica: ReplicaId): number {
  return Object.prototype.hasOwnProperty.call(vv, replica) ? vv[replica]! : 0;
}

/** The vector after one more event of `replica`. */
export function increment(vv: VersionVector, replica: ReplicaId): VersionVector {
  return { ...vv, [replica]: get(vv, replica) + 1 };
}

/** Pointwise maximum: the vector that has seen everything `a` or `b` has seen. */
export function merge(a: VersionVector, b: VersionVector): VersionVector {
  const out: Record<ReplicaId, number> = { ...a };
  for (const [replica, n] of Object.entries(b)) {
    if (n > get(out, replica)) out[replica] = n;
  }
  return out;
}

/**
 * Causal order of the histories summarised by `a` and `b`:
 * 'before' means a happened before b (a ≤ b pointwise and a ≠ b).
 */
export function compare(a: VersionVector, b: VersionVector): Ordering {
  let aBigger = false;
  let bBigger = false;
  for (const replica of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = get(a, replica);
    const y = get(b, replica);
    if (x > y) aBigger = true;
    else if (y > x) bBigger = true;
    if (aBigger && bBigger) return 'concurrent';
  }
  if (aBigger) return 'after';
  if (bBigger) return 'before';
  return 'equal';
}

/** True when `a` has seen everything `b` has seen (a ≥ b pointwise). */
export function dominates(a: VersionVector, b: VersionVector): boolean {
  const c = compare(a, b);
  return c === 'after' || c === 'equal';
}

/** True when the event `dot` is included in the history summarised by `vv`. */
export function covers(vv: VersionVector, dot: Dot): boolean {
  return get(vv, dot.replica) >= dot.counter;
}
