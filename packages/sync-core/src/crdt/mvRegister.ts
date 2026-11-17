/**
 * Multi-value register (Shapiro et al. 2011, Specification 10) in its dot-based form (Almeida et al. 2018).
 *
 * Each version is a value tagged with the dot of its write and the writer's HLC stamp. A write replaces every
 * version the writer has seen; concurrent writes survive side by side as siblings. The hybrid strategy shows the
 * sibling with the greatest stamp and surfaces the others as a conflict; a resolution is an ordinary write, which
 * dominates every sibling it has seen.
 */
import { compareStamp, type Stamp } from './lwwRegister';
import * as causal from './causal';
import type { Ctx, Dot } from './causal';
import type { ReplicaId } from '../model';
import { deepEqual } from '../util';

export interface Version<T> {
  readonly v: T;
  readonly d: Dot;
  readonly s: Stamp;
}

export interface MvRegister<T> {
  /** Sorted by dot. */
  readonly versions: readonly Version<T>[];
  readonly ctx: Ctx;
}

export const EMPTY: MvRegister<never> = Object.freeze({ versions: Object.freeze([]), ctx: causal.EMPTY_CTX });

const byDot = <T>(a: Version<T>, b: Version<T>) => causal.compareDots(a.d, b.d);

/**
 * Join of the versions of two registers under the given contexts. The hybrid strategy calls it with the causal
 * context of the whole record, which all fields of a record share.
 */
export function joinVersions<T>(a: readonly Version<T>[], ca: Ctx, b: readonly Version<T>[], cb: Ctx): Version<T>[] {
  const keep = causal.joinDots(
    a.map((x) => x.d),
    ca,
    b.map((x) => x.d),
    cb,
  );
  const all = [...a, ...b];
  return keep.map((d) => all.find((x) => causal.sameDot(x.d, d))!).sort(byDot);
}

/** A write of `value` by `replica` at HLC `stamp`, with dot `dot` (by default the replica's next dot). */
export function write<T>(
  r: MvRegister<T>,
  value: T,
  replica: ReplicaId,
  stamp: Stamp,
  dot: Dot = causal.next(r.ctx, replica),
): { state: MvRegister<T>; delta: MvRegister<T> } {
  const delta: MvRegister<T> = {
    versions: [{ v: value, d: dot, s: stamp }],
    ctx: causal.fromDots([...r.versions.map((x) => x.d), dot]),
  };
  return { state: merge(r, delta), delta };
}

export function merge<T>(a: MvRegister<T>, b: MvRegister<T>): MvRegister<T> {
  return { versions: joinVersions(a.versions, a.ctx, b.versions, b.ctx), ctx: causal.merge(a.ctx, b.ctx) };
}

/** The distinct values, each with the latest version that holds it, sorted by stamp. */
export function candidates<T>(versions: readonly Version<T>[]): Version<T>[] {
  const latest = [...versions].sort((x, y) => compareStamp(y.s, x.s));
  const out: Version<T>[] = [];
  for (const x of latest) if (!out.some((o) => deepEqual(o.v, x.v))) out.push(x);
  return out.sort((x, y) => compareStamp(x.s, y.s));
}

/** The provisional visible version: the one with the greatest stamp. Undefined for an empty register. */
export function winner<T>(versions: readonly Version<T>[]): Version<T> | undefined {
  let best: Version<T> | undefined;
  for (const x of versions) if (!best || compareStamp(x.s, best.s) > 0) best = x;
  return best;
}
