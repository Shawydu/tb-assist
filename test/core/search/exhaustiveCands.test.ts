import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { exhaustiveA, exhaustiveB } from '../../../src/core/search/exhaustiveCands';
import type { SearchCtx } from '../../../src/core/search/localSearch';

// Overhead = 100 per block + 10 per item; merging blocks is therefore always cheaper.
const popcount = (x: number): number => x.toString(2).replace(/0/g, '').length;
const ctx = (over: Partial<SearchCtx> = {}): SearchCtx => ({
  eligible: 0b1111,
  shopMasks: [0b0011, 0b1100],
  predictO: (m) => (m === 0b1111 ? Infinity : 100 + 10 * popcount(m)),
  predictG: (m) => 1000 * popcount(m),
  kMax: 3,
  bMin: 2000,
  rng: createRng(1),
  ...over,
});

describe('exhaustiveA', () => {
  it('returns the cheapest feasible partitions first, covering the eligible set', () => {
    const c = exhaustiveA(ctx(), 5);
    expect(c.length).toBeGreaterThan(0);
    expect(c[0]!.masks).toHaveLength(2); // full mask is infeasible, so 2 blocks beat 3
    for (const p of c) {
      expect(p.masks.reduce((a, b) => a | b, 0)).toBe(0b1111);
      expect(Number.isFinite(p.score)).toBe(true);
    }
    for (let i = 1; i < c.length; i++) expect(c[i]!.score).toBeGreaterThanOrEqual(c[i - 1]!.score);
  });

  it('returns nothing for an empty scope', () => {
    expect(exhaustiveA(ctx({ eligible: 0 }), 5)).toEqual([]);
  });
});

describe('exhaustiveB', () => {
  it('only proposes subsets that reach bMin, ranked by O/G', () => {
    const c = exhaustiveB(ctx(), 4);
    expect(c.length).toBeGreaterThan(0);
    for (const s of c) expect(popcount(s.mask)).toBeGreaterThanOrEqual(2);
    expect(c[0]!.score).toBeLessThanOrEqual(c[c.length - 1]!.score);
  });
});
