import { describe, expect, it } from 'vitest';
import {
  countPartitions,
  partitions,
  partitionsOfMasks,
  stirling2,
} from '../../src/core/partitions';

describe('stirling2', () => {
  it('matches known values', () => {
    expect(stirling2(0, 0)).toBe(1);
    expect(stirling2(4, 2)).toBe(7);
    expect(stirling2(5, 3)).toBe(25);
    expect(stirling2(7, 3)).toBe(301);
    expect(stirling2(3, 0)).toBe(0);
    expect(stirling2(3, 4)).toBe(0);
  });
});

describe('partitions', () => {
  for (let n = 1; n <= 7; n++) {
    for (let kMax = 1; kMax <= 4; kMax++) {
      it(`n=${n} kMax=${kMax}: count, disjoint, covering, distinct`, () => {
        let expected = 0;
        for (let k = 1; k <= Math.min(kMax, n); k++) expected += stirling2(n, k);
        const full = 2 ** n - 1;
        const seen = new Set<string>();
        let count = 0;
        for (const p of partitions(n, kMax)) {
          count++;
          expect(p.length).toBeLessThanOrEqual(kMax);
          let acc = 0;
          for (const b of p) {
            expect(b).toBeGreaterThan(0);
            expect(acc & b).toBe(0);
            acc |= b;
          }
          expect(acc).toBe(full);
          const lows = p.map((b) => b & -b);
          expect(lows).toEqual([...lows].sort((a, b) => a - b));
          seen.add(p.join(','));
        }
        expect(count).toBe(expected);
        expect(seen.size).toBe(expected);
        expect(countPartitions(n, kMax)).toBe(expected);
      });
    }
  }

  it('Bell(6) = 203 with large kMax', () => {
    expect(countPartitions(6, 6)).toBe(203);
    expect([...partitions(6, 6)].length).toBe(203);
  });

  it('works over arbitrary disjoint masks', () => {
    const out = [...partitionsOfMasks([0b0011, 0b0100, 0b1000], 3)];
    expect(out.length).toBe(5);
    expect(() => [...partitionsOfMasks([1, 1], 2)]).toThrow();
  });

  it('empty input yields nothing', () => {
    expect([...partitionsOfMasks([], 3)]).toEqual([]);
  });
});
