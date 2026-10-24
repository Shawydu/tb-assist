// Small seeded PRNG (mulberry32). Pure TS; deterministic for a given seed.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniformly pick one element (throws on empty). */
  pick<T>(arr: readonly T[]): T;
  /** Returns a new shuffled copy (Fisher-Yates); input untouched. */
  shuffle<T>(arr: readonly T[]): T[];
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number): number => {
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || hi < lo)
      throw new Error(`int(${lo}, ${hi}): invalid range`);
    return lo + Math.floor(next() * (hi - lo + 1));
  };
  return {
    next,
    int,
    chance: (p) => next() < p,
    pick: <T>(arr: readonly T[]): T => {
      if (arr.length === 0) throw new Error('pick from empty array');
      return arr[int(0, arr.length - 1)] as T;
    },
    shuffle: <T>(arr: readonly T[]): T[] => {
      const out = [...arr];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
  };
}
