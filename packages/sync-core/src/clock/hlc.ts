import type { ReplicaId } from '../model';

/**
 * Hybrid logical clock (Kulkarni, Demirbas, Madappa, Avva, Leone: "Logical Physical Clocks",
 * OPODIS 2014, Figure 5). `wall` is l (the largest physical time seen, in ms), `counter` is c.
 * The replica id is not part of the published algorithm; it breaks ties so that the order is total.
 */
export interface Hlc {
  readonly wall: number;
  readonly counter: number;
  readonly replica: ReplicaId;
}

/** The clock of a replica that has not seen any event yet. */
export function initialHlc(replica: ReplicaId): Hlc {
  return { wall: 0, counter: 0, replica };
}

function physical(now: number): number {
  if (!Number.isFinite(now) || now < 0) throw new RangeError(`invalid physical time ${now}`);
  return Math.floor(now);
}

/**
 * Timestamp for a local or send event. `now` is the replica's physical clock (pt in the paper); it may
 * be skewed or go backwards, the result is still strictly greater than `local`.
 *   l' = l; l = max(l', pt); c = (l = l') ? c + 1 : 0
 */
export function send(local: Hlc, now: number): Hlc {
  const wall = Math.max(local.wall, physical(now));
  const counter = wall === local.wall ? local.counter + 1 : 0;
  return { wall, counter, replica: local.replica };
}

/**
 * Timestamp for receiving a message stamped `remote`. Strictly greater than both `local` and `remote`.
 *   l' = l; l = max(l', l_m, pt)
 *   c = l = l' = l_m ? max(c, c_m) + 1 : l = l' ? c + 1 : l = l_m ? c_m + 1 : 0
 */
export function receive(local: Hlc, remote: Hlc, now: number): Hlc {
  const wall = Math.max(local.wall, remote.wall, physical(now));
  let counter: number;
  if (wall === local.wall && wall === remote.wall) counter = Math.max(local.counter, remote.counter) + 1;
  else if (wall === local.wall) counter = local.counter + 1;
  else if (wall === remote.wall) counter = remote.counter + 1;
  else counter = 0;
  return { wall, counter, replica: local.replica };
}

/** Total order: (wall, counter, replica). Replica ids compare by UTF-16 code units. */
export function compareHlc(a: Hlc, b: Hlc): number {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.replica !== b.replica) return a.replica < b.replica ? -1 : 1;
  return 0;
}

export function maxHlc(a: Hlc, b: Hlc): Hlc {
  return compareHlc(a, b) >= 0 ? a : b;
}

const WALL_DIGITS = 15;
const COUNTER_DIGITS = 10;

/**
 * Fixed-width string form for storage, e.g. `001763060400000-0000000003-c1`.
 * Comparing two strings gives the same order as `compareHlc`.
 */
export function hlcToString(h: Hlc): string {
  if (!Number.isSafeInteger(h.wall) || h.wall < 0 || String(h.wall).length > WALL_DIGITS) {
    throw new RangeError(`wall out of range: ${h.wall}`);
  }
  if (!Number.isSafeInteger(h.counter) || h.counter < 0 || String(h.counter).length > COUNTER_DIGITS) {
    throw new RangeError(`counter out of range: ${h.counter}`);
  }
  return `${String(h.wall).padStart(WALL_DIGITS, '0')}-${String(h.counter).padStart(COUNTER_DIGITS, '0')}-${h.replica}`;
}

const HLC_STRING = new RegExp(`^(\\d{${WALL_DIGITS}})-(\\d{${COUNTER_DIGITS}})-(.*)$`, 's');

export function hlcFromString(text: string): Hlc {
  const m = HLC_STRING.exec(text);
  if (!m) throw new SyntaxError(`invalid HLC string: ${text}`);
  return { wall: Number(m[1]), counter: Number(m[2]), replica: m[3]! };
}
