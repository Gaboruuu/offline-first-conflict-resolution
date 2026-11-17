/**
 * Causal history of the simulated ops. Each replica numbers the ops it applies 1, 2, 3, ...; the set of ops a
 * replica has integrated is always closed under "earlier op of the same origin" (own ops are added in order and
 * sync only takes unions of such sets), so it is represented exactly by a version vector `origin -> count`.
 * `A -> B` (A happened before B) iff A is in the vector B's origin had when B was applied.
 */
export type Seen = Readonly<Record<string, number>>;

export interface OpRef {
  origin: string;
  /** 1-based position among the ops applied by `origin`. */
  seq: number;
  /** What `origin` had integrated just before this op (the op itself excluded). */
  seen: Seen;
}

export function hasSeen(seen: Seen, origin: string, seq: number): boolean {
  return (seen[origin] ?? 0) >= seq;
}

/** A happened before B. */
export function happenedBefore(a: OpRef, b: OpRef): boolean {
  return hasSeen(b.seen, a.origin, a.seq);
}

export function concurrent(a: OpRef, b: OpRef): boolean {
  return !(a.origin === b.origin && a.seq === b.seq) && !happenedBefore(a, b) && !happenedBefore(b, a);
}

/** Pointwise maximum; keys are sorted so that equal vectors serialise identically. */
export function mergeSeen(a: Seen, b: Seen): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  }
  return out;
}

export function sameSeen(a: Seen, b: Seen): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
}
