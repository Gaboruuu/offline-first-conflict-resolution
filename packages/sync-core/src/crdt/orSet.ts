/**
 * Observed-remove set with add-wins semantics (Shapiro et al. 2011, Specification 15), in the optimised
 * tombstone-free form with a causal context (Bieniusa et al. 2012; Almeida et al. 2018).
 *
 * Every add tags the element with a fresh dot; a remove deletes the dots it has observed. The causal context
 * remembers removed dots, so no per-element tombstone is kept. An add concurrent with a remove survives,
 * because the remover had not observed the add's dot.
 */
import * as causal from './causal';
import type { Ctx, Dot } from './causal';
import type { ReplicaId } from '../model';

export interface OrSet {
  /** element -> its live dots (sorted, never empty). */
  readonly e: Readonly<Record<string, readonly Dot[]>>;
  readonly ctx: Ctx;
}

export const EMPTY: OrSet = Object.freeze({ e: Object.freeze({}), ctx: causal.EMPTY_CTX });

const dotsOf = (s: OrSet, el: string): readonly Dot[] => (Object.prototype.hasOwnProperty.call(s.e, el) ? s.e[el]! : []);

export function add(
  s: OrSet,
  el: string,
  replica: ReplicaId,
  dot: Dot = causal.next(s.ctx, replica),
): { state: OrSet; delta: OrSet } {
  const delta: OrSet = { e: { [el]: [dot] }, ctx: causal.fromDots([...dotsOf(s, el), dot]) };
  return { state: merge(s, delta), delta };
}

export function remove(s: OrSet, el: string): { state: OrSet; delta: OrSet } {
  const delta: OrSet = { e: {}, ctx: causal.fromDots(dotsOf(s, el)) };
  return { state: merge(s, delta), delta };
}

export function merge(a: OrSet, b: OrSet): OrSet {
  const e: Record<string, Dot[]> = {};
  for (const el of [...new Set([...Object.keys(a.e), ...Object.keys(b.e)])].sort()) {
    const dots = causal.joinDots(dotsOf(a, el), a.ctx, dotsOf(b, el), b.ctx);
    if (dots.length > 0) e[el] = dots;
  }
  return { e, ctx: causal.merge(a.ctx, b.ctx) };
}

export function has(s: OrSet, el: string): boolean {
  return dotsOf(s, el).length > 0;
}

/** The elements, sorted. */
export function elements(s: OrSet): string[] {
  return Object.keys(s.e).sort();
}
