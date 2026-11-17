/**
 * Dots and causal contexts for the causal CRDTs (multi-value register, OR-Set), after Almeida, Shoker and
 * Baquero, "Delta state replicated data types" (JPDC 2018).
 *
 * A dot `[replica, n]` names the n-th write event of a replica. A causal context is the set of dots a state
 * has seen, stored as a version vector (the contiguous prefix per replica) plus a "cloud" of the dots above it.
 * The cloud is what makes deltas exact: the delta of one write knows only its own dots, not the history before
 * them. Every function returns canonical values (cloud sorted, compacted into the vector, omitted when empty), so
 * equal contexts are deep-equal.
 */
import type { ReplicaId } from '../model';
import { compareTuple } from '../util';

export type Dot = readonly [replica: ReplicaId, counter: number];

export interface Ctx {
  /** Contiguous prefix: replica -> highest counter n such that dots 1..n are all included. No zero entries. */
  readonly v: Readonly<Record<ReplicaId, number>>;
  /** Included dots above the prefix, sorted; absent when empty. */
  readonly c?: readonly Dot[];
}

export const EMPTY_CTX: Ctx = Object.freeze({ v: Object.freeze({}) });

export const compareDots = (a: Dot, b: Dot): number => compareTuple(a, b);
export const sameDot = (a: Dot, b: Dot): boolean => a[0] === b[0] && a[1] === b[1];

const prefix = (c: Ctx, r: ReplicaId) => (Object.prototype.hasOwnProperty.call(c.v, r) ? c.v[r]! : 0);

export function has(c: Ctx, d: Dot): boolean {
  return d[1] <= prefix(c, d[0]) || (c.c ?? []).some((x) => sameDot(x, d));
}

/** Canonical context from a prefix and any dots: moves contiguous dots into the prefix, drops covered ones. */
function normalize(v: Record<ReplicaId, number>, dots: Iterable<Dot>): Ctx {
  const out: Record<ReplicaId, number> = {};
  for (const [r, n] of Object.entries(v)) if (n > 0) out[r] = n;
  const rest = [...dots].sort(compareDots);
  let cloud: Dot[] = [];
  for (const d of rest) {
    const p = out[d[0]] ?? 0;
    if (d[1] <= p || cloud.some((x) => sameDot(x, d))) continue;
    cloud.push(d);
  }
  // Compact: the cloud is sorted, so one pass per replica in counter order is enough.
  let changed = true;
  while (changed) {
    changed = false;
    cloud = cloud.filter((d) => {
      const p = out[d[0]] ?? 0;
      if (d[1] === p + 1) {
        out[d[0]] = d[1];
        changed = true;
        return false;
      }
      return d[1] > p;
    });
  }
  const sorted: Record<ReplicaId, number> = {};
  for (const r of Object.keys(out).sort()) sorted[r] = out[r]!;
  return cloud.length > 0 ? { v: sorted, c: cloud } : { v: sorted };
}

/** A context holding exactly the given dots (used for deltas). */
export function fromDots(dots: Iterable<Dot>): Ctx {
  return normalize({}, dots);
}

export function add(c: Ctx, ...dots: Dot[]): Ctx {
  return normalize({ ...c.v }, [...(c.c ?? []), ...dots]);
}

export function merge(a: Ctx, b: Ctx): Ctx {
  const v: Record<ReplicaId, number> = { ...a.v };
  for (const [r, n] of Object.entries(b.v)) if (n > (v[r] ?? 0)) v[r] = n;
  return normalize(v, [...(a.c ?? []), ...(b.c ?? [])]);
}

/** The next dot of `replica`: one above every dot of it that the context has seen. */
export function next(c: Ctx, replica: ReplicaId): Dot {
  let n = prefix(c, replica);
  for (const d of c.c ?? []) if (d[0] === replica && d[1] > n) n = d[1];
  return [replica, n + 1];
}

/** True when `a` has seen every dot of `b`. */
export function covers(a: Ctx, b: Ctx): boolean {
  for (const [r, n] of Object.entries(b.v)) {
    if (n > prefix(a, r)) {
      for (let i = prefix(a, r) + 1; i <= n; i++) if (!has(a, [r, i])) return false;
    }
  }
  return (b.c ?? []).every((d) => has(a, d));
}

/**
 * Join of two dot sets under their contexts (the DotSet join of Almeida et al.): keep the dots both sides have,
 * and each side's dots that the other side has not seen. A dot the other side has seen but no longer holds was
 * removed or overwritten there, so it goes.
 */
export function joinDots(a: readonly Dot[], ca: Ctx, b: readonly Dot[], cb: Ctx): Dot[] {
  const out: Dot[] = [];
  for (const d of a) if (b.some((x) => sameDot(x, d)) || !has(cb, d)) out.push(d);
  for (const d of b) if (!has(ca, d) && !out.some((x) => sameDot(x, d))) out.push(d);
  return out.sort(compareDots);
}
