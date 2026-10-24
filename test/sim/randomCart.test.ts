import { describe, expect, it } from 'vitest';
import { randomCart } from '../../src/sim/randomCart';
import { PricingSimulator, trueOptimumA, trueOptimumB } from '../../src/sim/simulator';

describe('randomCart', () => {
  it('is deterministic by seed', () => {
    expect(randomCart(42, 8)).toEqual(randomCart(42, 8));
    expect(JSON.stringify(randomCart(1, 8))).not.toBe(JSON.stringify(randomCart(2, 8)));
  });
  it('produces valid, realistic carts', () => {
    for (let s = 1; s <= 30; s++) {
      const c = randomCart(s, 10);
      expect(c.items).toHaveLength(10);
      for (const it of c.items) {
        expect(it.unitPrice).toBeGreaterThanOrEqual(1500);
        expect(it.unitPrice).toBeLessThan(40100);
        expect(Number.isInteger(it.unitPrice)).toBe(true);
        expect(it.trueWeightKg).toBeGreaterThanOrEqual(0.05);
        expect(it.trueWeightKg).toBeLessThanOrEqual(1.6);
      }
      const sim = new PricingSimulator(c); // validates shops/lineIds
      expect(sim.lineIds).toHaveLength(10);
    }
  });
  it('objective A is non-trivial for a meaningful fraction of n=10 carts', () => {
    let nonTrivial = 0;
    const N = 60;
    for (let s = 1; s <= N; s++) {
      const a = trueOptimumA(new PricingSimulator(randomCart(s, 10)), 3);
      if (a.optimum && a.optimum.groups.length > 1) nonTrivial++;
    }
    expect(nonTrivial / N).toBeGreaterThan(0.2);
    expect(nonTrivial / N).toBeLessThan(0.6);
  });
  it('trueOptimumB runs on random carts', () => {
    const b = trueOptimumB(new PricingSimulator(randomCart(3, 10)), 10000);
    expect(b.optimum).not.toBeNull();
  });
});
