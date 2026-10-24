import { describe, expect, it } from 'vitest';
import { partitions } from '../../src/core/partitions';
import { rankA, rankB } from '../../src/core/rank';
import { objectiveA } from '../../src/core/cost';
import type { Quote } from '../../src/core/types';
import { PricingSimulator, trueOptimumA } from '../../src/sim/simulator';
import { randomCart } from '../../src/sim/randomCart';

function q(o: number, g = 10000, extra: Partial<Quote> = {}): Quote {
  return {
    key: 'k',
    lineIds: [],
    status: 'ok',
    goodsNet: g,
    grandTotal: g + o,
    overhead: o,
    coupons: [],
    breakdownConsistent: true,
    capturedAt: 0,
    addressId: 'a',
    ...extra,
  };
}
const U = ['a', 'b', 'c'];
const infeasible = (): Quote => q(0, 0, { status: 'infeasible' });

describe('rankA', () => {
  it('sorts by cost, then group count, then sum T', () => {
    const m = new Map<number, Quote>([
      [7, q(900)],
      [1, q(300)],
      [6, q(600)], // {a},{bc}: 900, 2 groups
      [2, q(300)],
      [4, q(300)], // {a},{b},{c}: 900, 3 groups
      [3, q(600, 9000)], // {ab},{c}: 900, 2 groups, lower sumT
    ]);
    const r = rankA([[1, 2, 4], [1, 6], [3, 4], [7]], m, U, 10);
    expect(r.map((x) => x.groups.length)).toEqual([1, 2, 2, 3]);
    // among 2-group ties: {ab},{c} sumT = 9000+600+10300 vs {a},{bc}: 10300+10600
    expect(r[1]!.groups.map((g) => g.lineIds)).toEqual([['a', 'b'], ['c']]);
    expect(r[2]!.groups.map((g) => g.lineIds)).toEqual([['a'], ['b', 'c']]);
  });

  it('final tie-break is deterministic canonical key; dedupes', () => {
    const m = new Map<number, Quote>([
      [1, q(100)],
      [6, q(100)],
      [2, q(100)],
      [5, q(100)],
    ]);
    const a = rankA(
      [
        [2, 5],
        [1, 6],
        [6, 1],
      ],
      m,
      U,
      10,
    );
    const b = rankA(
      [
        [1, 6],
        [2, 5],
      ],
      m,
      U,
      10,
    );
    expect(a).toHaveLength(2);
    expect(a).toEqual(b);
    expect(a[0]!.groups[0]!.lineIds).toEqual(['a']);
  });

  it('respects rShow, drops unquoted and infeasible', () => {
    const m = new Map<number, Quote>([
      [7, q(900)],
      [1, q(100)],
      [6, infeasible()],
    ]);
    const r = rankA([[1, 6], [7], [3, 4]], m, U, 5);
    expect(r).toHaveLength(1);
    expect(rankA([[7]], m, U, 0)).toEqual([]);
  });

  it('savings vs baseline; null when baseline infeasible or unquoted', () => {
    const m = new Map<number, Quote>([
      [7, q(900)],
      [1, q(200)],
      [6, q(300)],
    ]);
    const r = rankA([[1, 6], [7]], m, U, 5);
    expect(r.map((x) => x.savingsVsBaseline)).toEqual([400, 0]);
    const m2 = new Map(m);
    m2.set(7, infeasible());
    expect(rankA([[1, 6]], m2, U, 5)[0]!.savingsVsBaseline).toBeNull();
    m2.delete(7);
    expect(rankA([[1, 6]], m2, U, 5)[0]!.savingsVsBaseline).toBeNull();
  });

  it('flags coupon-adjusted', () => {
    const c = [{ id: 'x', label: 'x', amount: 100 }];
    const m = new Map<number, Quote>([
      [1, q(200, 10000, { coupons: c })],
      [6, q(300, 10000, { coupons: c })],
    ]);
    const r = rankA([[1, 6]], m, U, 5);
    expect(r[0]!.couponAdjusted).toBe(true);
    expect(r[0]!.cost).toBe(600);
  });
});

describe('rankB', () => {
  it('sorts by ratio, then larger G, then smaller O, then mask', () => {
    const m = new Map<number, Quote>([
      [1, q(100, 1000)], // 0.1
      [2, q(200, 2000)], // 0.1, larger G
      [3, q(100, 1000)], // identical to 1 -> mask order
      [4, q(50, 1000)], // 0.05 best
      [5, q(300, 2000)], // 0.15
    ]);
    const r = rankB([1, 2, 3, 4, 5], m, U, 0, 10);
    expect(r.map((x) => x.lineIds.join(''))).toEqual(['c', 'b', 'a', 'ab', 'ac']);
  });

  it('larger G wins an exact ratio tie', () => {
    const m = new Map<number, Quote>([
      [1, q(100, 1000)],
      [2, q(300, 3000)],
    ]);
    const r = rankB([1, 2], m, U, 0, 10);
    expect(r[0]!.quote.goodsNet).toBe(3000);
  });

  it('compares ratios exactly via integers (exact tie and large near-tie)', () => {
    // exact tie 1/3 == 33333333/99999999 -> larger G first
    const t = new Map<number, Quote>([
      [1, q(1, 3)],
      [2, q(33333333, 99999999)],
    ]);
    expect(rankB([1, 2], t, U, 0, 5).map((x) => x.quote.goodsNet)).toEqual([99999999, 3]);
    // near-tie at ~9e7 fen: cross products differ by exactly 90000001-ish integers
    const a = q(30000000, 90000001); // 30000000/90000001
    const b = q(29999999, 89999998); // 29999999/89999998
    // a*G_b - b*G_a = 30000000*89999998 - 29999999*90000001 = -90000001+... compute exactly:
    const cross = a.overhead * b.goodsNet - b.overhead * a.goodsNet;
    const near = new Map<number, Quote>([
      [1, a],
      [2, b],
    ]);
    const order = rankB([1, 2], near, U, 0, 5).map((x) => x.quote.overhead);
    expect(order).toEqual(cross < 0 ? [30000000, 29999999] : [29999999, 30000000]);
    expect(Number.isSafeInteger(a.overhead * b.goodsNet)).toBe(true);
  });

  it('filters bMin, infeasible, unquoted; builds savings note', () => {
    const m = new Map<number, Quote>([
      [7, q(1200, 1000)], // ratio 1.20
      [1, q(730, 1000)], // 0.73
      [2, q(10, 500)], // below bMin
      [4, infeasible()],
    ]);
    const r = rankB([1, 2, 4, 7, 6], m, U, 1000, 10);
    expect(r.map((x) => x.quote.overhead)).toEqual([730, 1200]);
    expect(r[0]!.savingsNote).toBe('Baseline ratio 1.20 → 0.73');
    m.set(7, infeasible());
    expect(rankB([1], m, U, 1000, 5)[0]!.savingsNote).toBe('Baseline unavailable');
  });
});

describe('cross-check against simulator ground truth', () => {
  async function quotesFor(sim: PricingSimulator): Promise<Map<number, Quote>> {
    const out = new Map<number, Quote>();
    for (let mask = 1; mask < 2 ** sim.n; mask++) {
      const r = await sim.probe(sim.lineIdsOf(mask));
      if (r.kind === 'ok' || r.kind === 'infeasible') out.set(mask, r.quote);
    }
    return out;
  }

  it('rankA best equals trueOptimumA (no coupons: ==; coupons: >=)', async () => {
    let noCoupon = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const n = 2 + (seed % 5);
      const cfg = randomCart(seed, n);
      const withCoupons = seed % 2 === 0;
      const sim = new PricingSimulator(withCoupons ? cfg : { ...cfg, coupons: [] });
      const quotes = await quotesFor(sim);
      const kMax = 3;
      const truth = trueOptimumA(sim, kMax);
      const cands = [...partitions(n, kMax)];
      const ranked = rankA(cands, quotes, sim.lineIds, 5);
      if (!truth.optimum) {
        expect(ranked).toHaveLength(0);
        continue;
      }
      expect(ranked.length).toBeGreaterThan(0);
      if (!withCoupons || sim.config.coupons.length === 0) {
        noCoupon++;
        expect(ranked[0]!.cost).toBe(truth.optimum.cost);
      } else {
        expect(ranked[0]!.cost).toBeGreaterThanOrEqual(truth.optimum.cost);
      }
      // sanity: reported cost agrees with objectiveA
      const again = objectiveA(
        ranked[0]!.groups.map((g) =>
          sim.lineIds.reduce((acc, id, i) => (g.lineIds.includes(id) ? acc | (1 << i) : acc), 0),
        ),
        quotes,
      );
      expect(again?.cost).toBe(ranked[0]!.cost);
    }
    expect(noCoupon).toBeGreaterThan(20);
  });
});
