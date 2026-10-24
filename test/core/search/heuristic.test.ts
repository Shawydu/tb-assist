import { describe, expect, it } from 'vitest';
import { driveEngine } from '../../../src/core/search/drive';
import { createEngine } from '../../../src/core/search/engine';
import type { SearchEngine } from '../../../src/core/search/engine';
import { selectionKey } from '../../../src/core/selection';
import type { CartItem, ProbeResult, SearchParams } from '../../../src/core/types';
import { randomCart } from '../../../src/sim/randomCart';
import { PricingSimulator, trueOptimumA, trueOptimumB } from '../../../src/sim/simulator';
import type { SimConfig, SimItem, SimShop } from '../../../src/sim/simulator';

const toItems = (cfg: SimConfig): CartItem[] =>
  cfg.items.map((i) => ({
    lineId: i.lineId,
    itemId: i.itemId,
    skuId: i.skuId,
    shopId: i.shopId,
    shopName: i.shopName,
    title: i.title,
    unitPrice: i.unitPrice,
    qty: i.qty,
    selected: true,
    selectable: true,
  }));

const params = (extra: Partial<SearchParams> = {}): SearchParams => ({
  objective: 'A',
  nExh: 6,
  kMax: 3,
  bMinValue: 20000,
  rShow: 5,
  maxProbes: 80,
  ...extra,
});

const BRACKETS = [{ maxKg: 100, firstKg: 1, firstFee: 3000, stepKg: 0.5, stepFee: 1000 }] as const;

function mkItem(i: number, shopId: string, price: number, kg: number, eligible = true): SimItem {
  return {
    lineId: `L${String(i).padStart(2, '0')}`,
    itemId: `I${i}`,
    skuId: null,
    shopId,
    shopName: shopId,
    title: `item ${i}`,
    unitPrice: price,
    qty: 1,
    trueWeightKg: kg,
    consolidationEligible: eligible,
  };
}

function mkCfg(
  items: SimItem[],
  shops: SimShop[],
  opts: { limit?: number; coupons?: SimConfig['coupons'] } = {},
): SimConfig {
  return {
    items,
    shops,
    consolidation: {
      brackets: BRACKETS,
      weightLimitKg: opts.limit ?? 100,
      packingFactor: 1,
      parcelWeightKg: 0,
    },
    coupons: opts.coupons ?? [],
  };
}

// 8 items in 2 shops; shop1 ships free from 300 yuan, shop2 always charges 20 yuan.
function thresholdCfg(): SimConfig {
  const items = [
    ...[0, 1, 2, 3].map((i) => mkItem(i, 'shop1', 10000, 0.3)),
    ...[4, 5, 6, 7].map((i) => mkItem(i, 'shop2', 8000, 0.3)),
  ];
  return mkCfg(items, [
    { shopId: 'shop1', shopName: 'shop1', baseFee: 2000, freeAmount: 30000 },
    { shopId: 'shop2', shopName: 'shop2', baseFee: 2000 },
  ]);
}

async function run(cfg: SimConfig, p: SearchParams) {
  const sim = new PricingSimulator(cfg);
  const eng = createEngine(toItems(cfg), p);
  const out = await driveEngine(eng, sim, p.maxProbes);
  return { sim, eng, out };
}

describe('heuristic engine scenarios', () => {
  it('keeps a free-shipping shop together (threshold in one shop)', async () => {
    const cfg = thresholdCfg();
    const { out } = await run(cfg, params());
    const truth = trueOptimumA(new PricingSimulator(cfg), 3);
    expect(out.results.A![0]!.cost).toBe(truth.optimum!.cost);
    const shop1 = new Set(['L00', 'L01', 'L02', 'L03']);
    const g = out.results.A![0]!.groups.find((x) => x.lineIds.some((id) => shop1.has(id)))!;
    expect(shop1.size === g.lineIds.filter((id) => shop1.has(id)).length).toBe(true);
  });

  it('handles coupon conflicts across groups without double counting', async () => {
    const cfg = thresholdCfg();
    const cfg2: SimConfig = {
      ...cfg,
      coupons: [{ id: 'C1', label: '10 off', amount: 1000, minGoods: 20000 }],
    };
    const { out } = await run(cfg2, params());
    const truth = trueOptimumA(new PricingSimulator(cfg2), 3);
    for (const r of out.results.A!) {
      // verified cost is never below the true optimum (conservative coupon handling)
      expect(r.cost).toBeGreaterThanOrEqual(truth.optimum!.cost);
    }
    expect(out.results.A![0]!.cost).toBeLessThanOrEqual(truth.optimum!.cost + 1000);
  });

  it('finds a valid split when the full cart is overweight', async () => {
    const items = Array.from({ length: 8 }, (_, i) => mkItem(i, i < 4 ? 's1' : 's2', 5000, 1.5));
    const cfg = mkCfg(
      items,
      [
        { shopId: 's1', shopName: 's1', baseFee: 0 },
        { shopId: 's2', shopName: 's2', baseFee: 0 },
      ],
      { limit: 7 },
    );
    const { out } = await run(cfg, params());
    expect(out.results.A!.length).toBeGreaterThan(0);
    expect(out.results.A![0]!.groups.length).toBeGreaterThanOrEqual(2);
    expect(out.results.A![0]!.savingsVsBaseline).toBeNull();
    const truth = trueOptimumA(new PricingSimulator(cfg), 3);
    expect(out.results.A![0]!.cost).toBe(truth.optimum!.cost);
  });

  it('reports an ineligible singleton and ranks partitions of the rest', async () => {
    const cfg = thresholdCfg();
    const items = cfg.items.map((it, i) =>
      i === 2 ? { ...it, consolidationEligible: false } : it,
    );
    const { out } = await run({ ...cfg, items }, params());
    expect(out.results.ineligible).toEqual(['L02']);
    expect(out.results.A!.length).toBeGreaterThan(0);
    for (const r of out.results.A!)
      for (const g of r.groups) expect(g.lineIds).not.toContain('L02');
    for (const r of out.results.B!) expect(r.lineIds).not.toContain('L02');
  });

  it('finds objective B optima on a simple cart', async () => {
    const cfg = thresholdCfg();
    const { out } = await run(cfg, params({ objective: 'B' }));
    const truth = trueOptimumB(new PricingSimulator(cfg), 20000);
    expect(out.results.B![0]!.ratio).toBeLessThanOrEqual(truth.optimum!.ratio * 1.03);
  });
});

describe('heuristic engine contract', () => {
  const cfg = randomCart(11, 9);
  const items = toItems(cfg);

  it('is idempotent on next(), rejects wrong selections and bad results', async () => {
    const sim = new PricingSimulator(cfg);
    const eng = createEngine(items, params());
    expect(eng.kind).toBe('heuristic');
    const first = eng.next();
    expect(eng.next()).toEqual(first);
    expect(first!.length).toBe(9);
    expect(() => eng.observe([items[0]!.lineId], { kind: 'error', reason: 'x' })).toThrow();
    const r = await sim.probe(items.slice(1).map((i) => i.lineId));
    expect(() =>
      eng.observe(
        items.slice(1).map((i) => i.lineId),
        r,
      ),
    ).toThrow(/pending/);
    expect(() => eng.observe(first!, { kind: 'blocked', reason: 'captcha' })).toThrow();
    expect(eng.results().exact).toBe(false);
  });

  it('never re-proposes quoted masks or the empty set, and respects maxProbes', async () => {
    const sim = new PricingSimulator(cfg);
    const eng = createEngine(items, params({ maxProbes: 30 }));
    const seen = new Set<string>();
    let n = 0;
    while (!eng.done()) {
      const sel = eng.next()!;
      expect(sel.length).toBeGreaterThan(0);
      const k = selectionKey(sel);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      eng.observe(sel, (await sim.probe(sel)) as ProbeResult);
      n++;
    }
    expect(n).toBeLessThanOrEqual(30);
    expect(eng.next()).toBeNull();
  });

  it('cached results do not consume the budget', async () => {
    const sim = new PricingSimulator(cfg);
    const eng = createEngine(items, params({ maxProbes: 3 }));
    let steps = 0;
    while (!eng.done() && steps < 12) {
      const sel = eng.next()!;
      const r = await sim.probe(sel);
      if (r.kind === 'ok' || r.kind === 'infeasible') eng.observe(sel, { ...r, fromCache: true });
      steps++;
    }
    expect(steps).toBeGreaterThan(3);
  });

  async function finish(eng: SearchEngine, sim: PricingSimulator): Promise<string[]> {
    const log: string[] = [];
    while (!eng.done()) {
      const sel = eng.next()!;
      log.push(selectionKey(sel));
      eng.observe(sel, await sim.probe(sel));
    }
    return log;
  }

  it('is deterministic and serialize/restore mid-run continues identically', async () => {
    for (const objective of ['A', 'B'] as const) {
      const p = params({ objective, maxProbes: 40 });
      const full = createEngine(items, p);
      const fullLog = await finish(full, new PricingSimulator(cfg));
      const again = createEngine(items, p);
      expect(await finish(again, new PricingSimulator(cfg))).toEqual(fullLog);

      const a = createEngine(items, p);
      const sim = new PricingSimulator(cfg);
      const head: string[] = [];
      for (let i = 0; i < 20; i++) {
        const sel = a.next()!;
        head.push(selectionKey(sel));
        a.observe(sel, await sim.probe(sel));
      }
      const state = JSON.parse(JSON.stringify(a.serialize()));
      expect(state).toMatchObject({ v: 1, kind: 'heuristic' });
      const b = createEngine(items, p, state);
      expect(b.next()).toEqual(a.next());
      const tail = await finish(b, new PricingSimulator(cfg));
      expect([...head, ...tail]).toEqual(fullLog);
      expect(b.results()).toEqual(full.results());
    }
  });

  it('rejects mismatched saved state', () => {
    const eng = createEngine(items, params());
    const st = eng.serialize();
    expect(() => createEngine(items, params({ kMax: 2 }), st)).toThrow(/params/);
    expect(() => createEngine(items.slice(1), params(), st)).toThrow();
    expect(() => createEngine(items.slice(0, 4), params(), st)).toThrow(/kind/);
  });

  it('createEngine routes by n versus nExh', () => {
    expect(createEngine(toItems(randomCart(1, 6)), params()).kind).toBe('exhaustive');
    expect(createEngine(toItems(randomCart(1, 7)), params()).kind).toBe('heuristic');
  });

  it('tolerates an infeasible full cart (baseline none)', async () => {
    const items8 = Array.from({ length: 7 }, (_, i) => mkItem(i, 's1', 5000, 2));
    const c = mkCfg(items8, [{ shopId: 's1', shopName: 's1', baseFee: 0 }], { limit: 8 });
    const { out } = await run(c, params());
    expect(out.results.A![0]!.savingsVsBaseline).toBeNull();
  });
});
