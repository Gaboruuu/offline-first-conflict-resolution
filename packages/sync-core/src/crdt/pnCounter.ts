/**
 * PN-Counter (Shapiro et al. 2011, Specification 7): one grow-only count of increments `p` and one of
 * decrements `n` per replica. Merge takes the pointwise maximum; the value is sum(p) - sum(n).
 * The delta of an increment holds only the writer's changed entry.
 */
import type { ReplicaId } from '../model';

export interface PnCounter {
  readonly p: Readonly<Record<ReplicaId, number>>;
  readonly n: Readonly<Record<ReplicaId, number>>;
}

export const EMPTY: PnCounter = Object.freeze({ p: Object.freeze({}), n: Object.freeze({}) });

const get = (m: Readonly<Record<ReplicaId, number>>, r: ReplicaId) =>
  Object.prototype.hasOwnProperty.call(m, r) ? m[r]! : 0;

function maxMap(a: Readonly<Record<ReplicaId, number>>, b: Readonly<Record<ReplicaId, number>>) {
  const out: Record<ReplicaId, number> = {};
  for (const r of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) out[r] = Math.max(get(a, r), get(b, r));
  return out;
}

/** Adds `by` (positive or negative, an integer) on behalf of `replica`. */
export function increment(c: PnCounter, replica: ReplicaId, by: number): { state: PnCounter; delta: PnCounter } {
  if (!Number.isSafeInteger(by) || by === 0) throw new RangeError(`invalid increment ${by}`);
  const delta: PnCounter =
    by > 0 ? { p: { [replica]: get(c.p, replica) + by }, n: {} } : { p: {}, n: { [replica]: get(c.n, replica) - by } };
  return { state: merge(c, delta), delta };
}

export function merge(a: PnCounter, b: PnCounter): PnCounter {
  return { p: maxMap(a.p, b.p), n: maxMap(a.n, b.n) };
}

export function value(c: PnCounter): number {
  let sum = 0;
  for (const x of Object.values(c.p)) sum += x;
  for (const x of Object.values(c.n)) sum -= x;
  return sum;
}
