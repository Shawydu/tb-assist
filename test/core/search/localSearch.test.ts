import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { candidatesA, candidatesB } from '../../../src/core/search/localSearch';
import type { SearchCtx } from '../../../src/core/search/localSearch';

const pc = (x: number): number => {
  let c = 0;
  for (let m = x; m; m &= m - 1) c++;
  return c;
};

// 8 items, 2 shops (bits 0-3, 4-7). Overhead: 1000 per group + 300 per item cross-shop penalty.
function ctx(over: Partial<SearchCtx> = {}): SearchCtx {
  const shopA = 0b1111;
  const shopB = 0b11110000;
  return {
    eligible: 0xff,
    shopMasks: [shopA, shopB],
    predictO: (m) => 1000 + (m & shopA && m & shopB ? 3000 : 0) + pc(m) * 10,
    predictG: (m) => pc(m) * 5000,
    kMax: 3,
    bMin: 0,
    rng: createRng(7),
    ...over,
  };
}

describe('candidatesA', () => {
  it('returns canonical, distinct, kMax-bounded partitions of the eligible set', () => {
    const cs = candidatesA(ctx({ kMax: 2 }));
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.length).toBeLessThanOrEqual(50);
    const keys = new Set<string>();
    for (const c of cs) {
      expect(c.masks.length).toBeLessThanOrEqual(2);
      expect(c.masks.reduce((a, b) => a | b, 0)).toBe(0xff);
      expect(c.masks.reduce((a, b) => a + pc(b), 0)).toBe(8);
      const lows = c.masks.map((m) => m & -m);
      expect(lows).toEqual([...lows].sort((a, b) => a - b));
      keys.add(c.masks.join(','));
    }
    expect(keys.size).toBe(cs.length);
    for (let i = 1; i < cs.length; i++)
      expect(cs[i]!.score).toBeGreaterThanOrEqual(cs[i - 1]!.score);
  });

  it('finds the by-shop split and includes the {U} seed', () => {
    const cs = candidatesA(ctx());
    expect(cs[0]!.masks).toEqual([0b1111, 0b11110000]);
    expect(cs.some((c) => c.masks.length === 1)).toBe(true);
  });

  it('respects a restricted eligible set and extra seeds', () => {
    const cs = candidatesA(ctx({ eligible: 0b01111110 }), [[0b110, 0b01111000]]);
    for (const c of cs) expect(c.masks.reduce((a, b) => a | b, 0)).toBe(0b01111110);
    expect(cs.some((c) => c.masks.join() === '6,120')).toBe(true);
  });

  it('is deterministic for a given seed and excludes infeasible partitions', () => {
    const a = candidatesA(ctx());
    expect(candidatesA(ctx())).toEqual(a);
    const bad = candidatesA(ctx({ predictO: (m) => (m & 1 && pc(m) > 3 ? Infinity : 1000) }));
    for (const c of bad) expect(Number.isFinite(c.score)).toBe(true);
  });
});

describe('candidatesB', () => {
  it('only returns subsets with G >= bMin, distinct, sorted by ratio', () => {
    const cs = candidatesB(ctx({ bMin: 20000 }));
    expect(cs.length).toBeGreaterThan(0);
    expect(new Set(cs.map((c) => c.mask)).size).toBe(cs.length);
    for (const c of cs) {
      expect(pc(c.mask) * 5000).toBeGreaterThanOrEqual(20000);
      expect(c.mask & ~0xff).toBe(0);
    }
    for (let i = 1; i < cs.length; i++)
      expect(cs[i]!.score).toBeGreaterThanOrEqual(cs[i - 1]!.score);
  });

  it('finds the best single-shop subset and includes seeds', () => {
    const cs = candidatesB(ctx({ bMin: 0 }), [0b101]);
    expect(cs[0]!.mask === 0b1111 || cs[0]!.mask === 0b11110000).toBe(true);
    expect(cs.some((c) => c.mask === 0xff)).toBe(true);
    expect(cs.some((c) => c.mask === 0b101)).toBe(true);
  });

  it('returns nothing when no subset reaches bMin', () => {
    expect(candidatesB(ctx({ bMin: 1_000_000 }))).toEqual([]);
  });
});
