import { describe, expect, it } from 'vitest';
import { PricingSimulator, trueOptimumA, trueOptimumB } from '../../src/sim/simulator';
import type { RateBracket, SimConfig, SimItem, SimShop } from '../../src/sim/simulator';
import type { Quote } from '../../src/core/types';

const y = (x: number) => x * 100;

function item(
  lineId: string,
  shopId: string,
  price: number,
  kg: number,
  extra: Partial<SimItem> = {},
): SimItem {
  return {
    lineId,
    itemId: `i-${lineId}`,
    skuId: null,
    shopId,
    shopName: shopId,
    title: lineId,
    unitPrice: y(price),
    qty: 1,
    trueWeightKg: kg,
    consolidationEligible: true,
    ...extra,
  };
}

const BRACKETS: RateBracket[] = [
  { maxKg: 2, firstKg: 1, firstFee: y(40), stepKg: 0.5, stepFee: y(20) },
  { maxKg: 3, firstKg: 1, firstFee: y(70), stepKg: 0.5, stepFee: y(30) },
];

function cfg(over: Partial<SimConfig> & { items: SimItem[]; shops: SimShop[] }): SimConfig {
  return {
    consolidation: { brackets: BRACKETS, weightLimitKg: 3, packingFactor: 1, parcelWeightKg: 0 },
    coupons: [],
    ...over,
  };
}

async function quote(sim: PricingSimulator, ...ids: string[]): Promise<Quote> {
  const r = await sim.probe(ids);
  if (r.kind !== 'ok' && r.kind !== 'infeasible') throw new Error(`unexpected ${r.kind}`);
  return r.quote;
}

// Hand-computed n=3 example (see comments for arithmetic).
// shopA: base ¥10, free when goods >= ¥100. shopB: base ¥8, free when qty >= 2.
const shopA: SimShop = { shopId: 'A', shopName: 'A', baseFee: y(10), freeAmount: y(100) };
const shopB: SimShop = { shopId: 'B', shopName: 'B', baseFee: y(8), freeCount: 2 };
const hand = () =>
  cfg({
    shops: [shopA, shopB],
    items: [item('a1', 'A', 60, 1), item('a2', 'A', 50, 1), item('b1', 'B', 30, 0.5)],
  });

describe('freight', () => {
  it('free shipping by amount', async () => {
    const sim = new PricingSimulator(hand());
    expect((await quote(sim, 'a1')).domesticByShop).toEqual({ A: y(10) });
    expect((await quote(sim, 'a1', 'a2')).domesticByShop).toEqual({ A: 0 }); // 110 >= 100
  });
  it('free shipping by count (sum of qty)', async () => {
    const c = hand();
    const items = [...c.items];
    items[2] = item('b1', 'B', 30, 0.5, { qty: 2 });
    const sim = new PricingSimulator({ ...c, items });
    expect((await quote(sim, 'b1')).domesticByShop).toEqual({ B: 0 });
    const sim1 = new PricingSimulator(hand());
    expect((await quote(sim1, 'b1')).domesticByShop).toEqual({ B: y(8) });
  });
  it('always-free shop', async () => {
    const sim = new PricingSimulator(
      cfg({
        shops: [{ shopId: 'A', shopName: 'A', baseFee: y(15), freeAlways: true }],
        items: [item('a1', 'A', 20, 1)],
      }),
    );
    expect((await quote(sim, 'a1')).domesticByShop).toEqual({ A: 0 });
  });
  it('满减 reduces goodsNet, not overhead', async () => {
    const shop: SimShop = { ...shopA, discount: { every: y(100), off: y(10) } };
    const sim = new PricingSimulator(cfg({ shops: [shop], items: [item('a1', 'A', 250, 1)] }));
    const q = await quote(sim, 'a1');
    expect(q.goodsNet).toBe(y(230)); // 250 - 2*10
    // domestic free (net 230 >= 100); fee 40
    expect(q.overhead).toBe(y(40));
    expect(q.grandTotal).toBe(y(270));
    expect(q.grandTotal - q.goodsNet).toBe(q.overhead);
  });
});

describe('consolidation pricing', () => {
  it('first-weight and step pricing, tier selection', async () => {
    const sim = new PricingSimulator(hand());
    const fee = async (...ids: string[]) => (await quote(sim, ...ids)).consolidationFee;
    expect(await fee('b1')).toBe(y(40)); // 0.5 kg <= first kg
    expect(await fee('a1')).toBe(y(40)); // exactly 1 kg
    expect(await fee('a1', 'b1')).toBe(y(60)); // 1.5 kg -> 1 step
    expect(await fee('a1', 'a2')).toBe(y(80)); // 2.0 kg -> 2 steps, still bracket 1
    expect(await fee('a1', 'a2', 'b1')).toBe(y(160)); // 2.5 kg -> bracket 2: 70 + 3*30
  });
  it('packing factor and parcel weight add to weight', async () => {
    const c = hand();
    const sim = new PricingSimulator({
      ...c,
      consolidation: { ...c.consolidation, packingFactor: 1.1, parcelWeightKg: 0.05 },
    });
    // 1.0*1.1 + 0.05 = 1.15 kg -> 1 step
    expect((await quote(sim, 'a1')).consolidationFee).toBe(y(60));
  });
  it('weight limit makes selection infeasible with a reason', async () => {
    const c = hand();
    const sim = new PricingSimulator({
      ...c,
      consolidation: { ...c.consolidation, weightLimitKg: 2.2 },
    });
    const r = await sim.probe(['a1', 'a2', 'b1']);
    expect(r.kind).toBe('infeasible');
    if (r.kind === 'infeasible') {
      expect(r.quote.status).toBe('infeasible');
      expect(r.quote.infeasibleReason).toMatch(/exceeds limit/);
    }
    expect((await sim.probe(['a1', 'a2'])).kind).toBe('ok');
  });
  it('consolidation-ineligible item makes selection infeasible', async () => {
    const c = hand();
    const items = [...c.items];
    items[2] = item('b1', 'B', 30, 0.5, { consolidationEligible: false });
    const sim = new PricingSimulator({ ...c, items });
    const r = await sim.probe(['a1', 'b1']);
    expect(r.kind).toBe('infeasible');
    if (r.kind === 'infeasible') expect(r.quote.infeasibleReason).toMatch(/not eligible/);
    expect((await sim.probe(['a1'])).kind).toBe('ok');
    expect(trueOptimumA(sim, 3).optimum).toBeNull();
    // B can still exclude the ineligible item
    expect(trueOptimumB(sim, y(100)).optimum?.lineIds).toEqual(['a1', 'a2']);
  });
});

describe('probe behavior', () => {
  it('returns a full consistent quote and counts probes', async () => {
    let t = 1000;
    const sim = new PricingSimulator(hand(), { clock: () => t++ });
    const q = await quote(sim, 'b1', 'a1'); // order independent
    expect(q.lineIds).toEqual(['a1', 'b1']);
    expect(q.goodsNet).toBe(y(90));
    expect(q.overhead).toBe(y(78)); // dom 10+8, fee 60
    expect(q.grandTotal).toBe(y(168));
    expect(q.breakdownConsistent).toBe(true);
    expect(q.addressId).toBe('sim-address');
    expect(q.capturedAt).toBe(1000);
    expect(sim.probeCount).toBe(1);
    const r = await sim.probe(['a1', 'b1']);
    expect(r.kind === 'ok' && r.fromCache).toBe(false);
    expect(sim.probeCount).toBe(2);
    expect(sim.trueOverhead(['a1', 'b1'])).toBe(y(78));
    expect(sim.probeCount).toBe(2);
  });
  it('errors on empty or unknown selections', async () => {
    const sim = new PricingSimulator(hand());
    expect((await sim.probe([])).kind).toBe('error');
    expect((await sim.probe(['nope'])).kind).toBe('error');
  });
  it('failure injection', async () => {
    const sim = new PricingSimulator(hand(), {
      inject: (i) => (i === 1 ? 'blocked' : i === 2 ? 'error' : null),
    });
    expect((await sim.probe(['a1'])).kind).toBe('ok');
    expect((await sim.probe(['a1'])).kind).toBe('blocked');
    expect((await sim.probe(['a1'])).kind).toBe('error');
    expect((await sim.probe(['a1'])).kind).toBe('ok');
    expect(sim.probeCount).toBe(4);
  });
});

describe('coupons', () => {
  // two always-free-shipping items, 1 kg each; fee: 1 kg=40, 2 kg=80. coupon ¥20 off when goods >= ¥50.
  const couponCfg = (limit: number) =>
    cfg({
      shops: [{ shopId: 'A', shopName: 'A', baseFee: 0, freeAlways: true }],
      items: [item('x', 'A', 60, 1), item('z', 'A', 70, 1)],
      consolidation: {
        brackets: BRACKETS,
        weightLimitKg: limit,
        packingFactor: 1,
        parcelWeightKg: 0,
      },
      coupons: [{ id: 'C1', label: '¥20 off fee', amount: y(20), minGoods: y(50) }],
    });
  it('every eligible coupon applies independently in each single checkout', async () => {
    const sim = new PricingSimulator(couponCfg(3));
    for (const id of ['x', 'z']) {
      const q = await quote(sim, id);
      expect(q.coupons).toEqual([{ id: 'C1', label: '¥20 off fee', amount: y(20) }]);
      expect(q.overhead).toBe(y(20));
    }
    expect((await quote(sim, 'x', 'z')).overhead).toBe(y(60)); // 80 - 20
  });
  it('trueOptimumA spends a single-use coupon only once', () => {
    const sim = new PricingSimulator(couponCfg(1.5)); // U infeasible, so partition is forced
    const a = trueOptimumA(sim, 3);
    expect(a.baselineCost).toBeNull();
    expect(a.optimum?.cost).toBe(y(60)); // 20 + 40, not 20 + 20
    expect(a.optimum?.couponByGroup.filter((c) => c !== null)).toEqual(['C1']);
  });
  it('picks the largest coupon when several apply; one per checkout', async () => {
    const c = couponCfg(3);
    const sim = new PricingSimulator({
      ...c,
      coupons: [...c.coupons, { id: 'C2', label: '¥30 off', amount: y(30), minGoods: y(50) }],
    });
    const q = await quote(sim, 'x');
    expect(q.coupons.map((k) => k.id)).toEqual(['C2']);
    expect(q.overhead).toBe(y(10));
    // forced split: each coupon used once, on different groups: 40-30 + 40-20 = 30
    const forced = new PricingSimulator({
      ...sim.config,
      consolidation: { ...sim.config.consolidation, weightLimitKg: 1.5 },
    });
    expect(trueOptimumA(forced, 3).optimum?.cost).toBe(y(30));
  });
  it('coupon not applied below minGoods and capped at the fee', async () => {
    const c = couponCfg(3);
    const sim = new PricingSimulator({
      ...c,
      coupons: [{ id: 'C1', label: 'big', amount: y(500), minGoods: y(65) }],
    });
    expect((await quote(sim, 'x')).coupons).toEqual([]);
    expect((await quote(sim, 'z')).coupons[0]?.amount).toBe(y(40));
    expect((await quote(sim, 'z')).overhead).toBe(0);
  });
});

describe('noise mode', () => {
  const noisy = (seed: number) => new PricingSimulator({ ...hand(), noise: { seed } });
  it('is deterministic per selection and bounded by ±¥1', async () => {
    const sim = noisy(5);
    const a = await quote(sim, 'a1', 'b1');
    const b = await quote(sim, 'b1', 'a1');
    expect(b.grandTotal).toBe(a.grandTotal);
    expect(Math.abs(a.otherFees ?? 999)).toBeLessThanOrEqual(100);
    expect(a.grandTotal - a.goodsNet).toBe(a.overhead);
    expect(a.overhead).toBe(y(78) + (a.otherFees ?? 0));
    expect((await quote(noisy(5), 'a1', 'b1')).grandTotal).toBe(a.grandTotal);
    const diffs = new Set<number>();
    for (let s = 0; s < 20; s++) diffs.add((await quote(noisy(s), 'a1', 'b1')).otherFees ?? 0);
    expect(diffs.size).toBeGreaterThan(3);
  });
  it('ground truth includes the same noise', async () => {
    const sim = noisy(9);
    expect(sim.trueOverhead(['a2'])).toBe((await quote(sim, 'a2')).overhead);
  });
});

describe('ground truth (hand-computed n=3)', () => {
  // Overheads O = domestic + fee:
  //  a1 50, a2 50, b1 48, a1a2 80, a1b1 78, a2b1 78, U 8+160=168.
  it('trueOptimumA', () => {
    const sim = new PricingSimulator(hand());
    const a = trueOptimumA(sim, 3);
    expect(a.baselineCost).toBe(y(168));
    expect(a.optimum?.cost).toBe(y(128));
    expect(a.optimum?.groups.length).toBe(2);
    // three 2-group partitions tie at 128 (a1a2|b1, a1b1|a2, a2b1|a1); ΣT equal too
    expect(
      a.ties
        .map((p) =>
          p.groups
            .map((g) => g.join('+'))
            .sort()
            .join('|'),
        )
        .sort(),
    ).toEqual(['a1+a2|b1', 'a1+b1|a2', 'a1|a2+b1']);
    expect(trueOptimumA(sim, 1).optimum?.cost).toBe(y(168));
    expect(trueOptimumA(sim, 1).optimum?.groups).toEqual([['a1', 'a2', 'b1']]);
    expect(trueOptimumA(sim, 2).optimum?.cost).toBe(y(128));
    expect(trueOptimumA(sim, 3).ties.every((p) => p.cost !== y(148))).toBe(true); // 3 singletons = 148, worse
  });
  it('FR-7.3 tie-break prefers fewer groups, then lower total T', () => {
    // Free shipping everywhere, fee 40 per 1 kg item and 80 for two: splitting costs 80 = same as U,
    // so U (1 group) must win over {x|z}.
    const sim = new PricingSimulator(
      cfg({
        shops: [{ shopId: 'A', shopName: 'A', baseFee: 0, freeAlways: true }],
        items: [item('x', 'A', 60, 1), item('z', 'A', 70, 1)],
      }),
    );
    const a = trueOptimumA(sim, 3);
    expect(a.optimum?.groups).toEqual([['x', 'z']]);
    expect(a.ties.length).toBe(1);
  });
  it('trueOptimumB', () => {
    const sim = new PricingSimulator(hand());
    const b = trueOptimumB(sim, y(100));
    expect(b.optimum?.lineIds).toEqual(['a1', 'a2']);
    expect(b.optimum?.goodsNet).toBe(y(110));
    expect(b.optimum?.overhead).toBe(y(80));
    expect(b.optimum?.ratio).toBeCloseTo(80 / 110, 12);
    expect(b.baselineRatio).toBeCloseTo(168 / 140, 12);
    // bMin above every subset except U
    expect(trueOptimumB(sim, y(140)).optimum?.lineIds).toEqual(['a1', 'a2', 'b1']);
    expect(trueOptimumB(sim, y(141)).optimum).toBeNull();
    // looser floor still picks a1a2 (80/110 beats 78/90, 78/80, 50/60)
    expect(trueOptimumB(sim, y(50)).optimum?.lineIds).toEqual(['a1', 'a2']);
  });
  it('FR-8.2 tie-break: larger G first', () => {
    // two items with identical ratio: 40/60 vs 80/120 (same fee structure) -> larger G wins.
    const sim = new PricingSimulator(
      cfg({
        shops: [{ shopId: 'A', shopName: 'A', baseFee: 0, freeAlways: true }],
        items: [item('p', 'A', 60, 1), item('q', 'A', 60, 1)],
      }),
    );
    // p: 40/60, pq: 80/120 -> equal ratio, larger G wins
    expect(trueOptimumB(sim, y(10)).optimum?.lineIds).toEqual(['p', 'q']);
  });
});
