/**
 * Seeded pseudo-random numbers for the simulator. Every random choice in sim/ goes through a `Prng`, so a run is a
 * pure function of its config and seed (the platform's own random source is never used).
 */

/** mulberry32: a small, fast 32-bit generator with good statistical quality for simulation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 32-bit FNV-1a hash of a string; used to derive independent seeds from names. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class Prng {
  private readonly next: () => number;

  constructor(readonly seed: number) {
    this.next = mulberry32(seed);
  }

  /** An independent stream for `name`, e.g. one per client, so that streams do not shift each other. */
  fork(name: string): Prng {
    return new Prng((Math.imul(this.seed ^ 0x9e3779b9, 0x85ebca6b) ^ hashString(name)) >>> 0);
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.next();
  }

  /** Uniform integer in [min, max] (both inclusive). */
  int(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new RangeError(`bad range [${min}, ${max}]`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }

  /** Exponentially distributed value with the given mean (inter-arrival time of a Poisson process). */
  exponential(mean: number): number {
    if (!(mean > 0)) throw new RangeError('mean must be positive');
    return -mean * Math.log(1 - this.next());
  }

  /** Standard normal value (Box-Muller). */
  normal(mean = 0, sd = 1): number {
    const u = 1 - this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** One element of a non-empty list. */
  choice<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('choice from an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /**
   * A key chosen with probability proportional to its weight. Keys are visited in sorted order, so the result does
   * not depend on the property order of the object. Zero weights are never chosen.
   */
  pick<K extends string>(weights: Readonly<Partial<Record<K, number>>>): K {
    const entries = (Object.entries(weights) as [K, number][])
      .filter(([, w]) => w > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    if (entries.length === 0 || !Number.isFinite(total)) throw new RangeError('pick needs at least one positive weight');
    let r = this.next() * total;
    for (const [key, w] of entries) {
      r -= w;
      if (r < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }

  /** A deterministic RFC 4122 version-4 UUID. */
  uuid(): string {
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) {
      let byte = Math.floor(this.next() * 256);
      if (i === 6) byte = (byte & 0x0f) | 0x40;
      if (i === 8) byte = (byte & 0x3f) | 0x80;
      hex.push(byte.toString(16).padStart(2, '0'));
    }
    const s = hex.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}
