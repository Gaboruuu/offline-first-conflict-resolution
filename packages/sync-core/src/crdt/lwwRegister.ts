/**
 * Last-writer-wins register (Shapiro et al. 2011, Specification 8) ordered by hybrid logical clock stamps.
 *
 * A write stamps the value with the writer's HLC; merge keeps the register with the greater stamp. Stamps are
 * unique (the replica id is part of them), so two registers with equal stamps hold the same value. The delta of a
 * write is the new register itself.
 */
import { compareHlc, type Hlc } from '../clock/hlc';
import type { ReplicaId } from '../model';

/** Compact form of an HLC for messages and saved state: `[wall, counter, replica]`. */
export type Stamp = readonly [wall: number, counter: number, replica: ReplicaId];

export function toStamp(h: Hlc): Stamp {
  return [h.wall, h.counter, h.replica];
}

export function fromStamp(s: Stamp): Hlc {
  return { wall: s[0], counter: s[1], replica: s[2] };
}

/** Same total order as `compareHlc`. */
export function compareStamp(a: Stamp, b: Stamp): number {
  return compareHlc(fromStamp(a), fromStamp(b));
}

export interface LwwRegister<T> {
  readonly v: T;
  readonly s: Stamp;
}

/** The register after a write; it is also the delta to send. */
export function write<T>(value: T, stamp: Stamp): LwwRegister<T> {
  return { v: value, s: stamp };
}

export function merge<T>(a: LwwRegister<T>, b: LwwRegister<T>): LwwRegister<T> {
  return compareStamp(a.s, b.s) >= 0 ? a : b;
}

export function value<T>(r: LwwRegister<T>): T {
  return r.v;
}
