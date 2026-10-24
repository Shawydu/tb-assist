import { describe, expect, it } from 'vitest';
import { objectiveA } from '../../../src/core/cost';
import { partitions } from '../../../src/core/partitions';
import { createRng } from '../../../src/core/rng';
import { driveEngine } from '../../../src/core/search/drive';
import { createEngine } from '../../../src/core/search/engine';
import type { EngineState } from '../../../src/core/search/engine';
import { probeOrder } from '../../../src/core/search/exhaustive';
import { lineIdsFromMask, selectionKey } from '../../../src/core/selection';
import type { CartItem, Quote, SearchParams } from '../../../src/core/types';
import { randomCart } from '../../../src/sim/randomCart';
import { PricingSimulator, trueOptimumA, trueOptimumB } from '../../../src/sim/simulator';
import type { SimConfig } from '../../../src/sim/simulator';

function toItems(cfg: SimConfig): CartItem[] {
  return cfg.items.map((i) => ({
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
}

function mkParams(
  kMax: number,
  bMinValue: number,
  extra: Partial<SearchParams> = {},
): SearchParams {
  return {
    objective: 'A',
    nExh: 6,
    kMax,
    bMinValue,
    rShow: 5,
    maxProbes: 200,
    ...extra,
  };
}

const B_MINS = [0, 5000, 20000, 60000];

async function bruteForceA(sim: PricingSimulator, kMax: number): Promise<number | null> {
  const n = sim.n;
  const quotes = new Map<number, Quote>();
  for (let m = 1; m < 2 ** n; m++) {
    const r = await sim.probe(sim.lineIdsOf(m));
    if (r.kind === 'ok' || r.kind === 'infeasible') quotes.set(m, r.quote);
  }
  let best: number | null = null;
  for (const p of partitions(n, kMax)) {
    const c = objectiveA(p, quotes);
    if (c && Number.isFinite(c.cost) && (best === null || c.cost < best)) best = c.cost;
  }
  return best;
}

describe('probeOrder', () => {
  it('full set, singletons, then by popcount ascending', () => {
    expect(probeOrder(3)).toEqual([7, 1, 2, 4, 3, 5, 6]);
    expect(probeOrder(1)).toEqual([1]);
    expect(probeOrder(2)).toEqual([3, 1, 2]);
    const o = probeOrder(5);
    expect(o).toHaveLength(31);
    expect(new Set(o).size).toBe(31);
  });

  it('engine proposes selections in that order', async () => {
    const cfg = randomCart(11, 4);
    const sim = new PricingSimulator(cfg);
    const eng = createEngine(toItems(cfg), mkParams(2, 0));
    const seen: string[] = [];
    for (let s = eng.next(); s; s = eng.next()) {
      seen.push(selectionKey(s));
      const r = await sim.probe(s);
      if (r.kind !== 'ok' && r.kind !== 'infeasible') throw new Error('unexpected');
      eng.observe(s, r);
    }
    expect(seen).toEqual(probeOrder(4).map((m) => selectionKey(lineIdsFromMask(sim.lineIds, m))));
    expect(eng.done()).toBe(true);
    expect(eng.next()).toBeNull();
  });
});

describe('SearchEngine contract', () => {
  it('next() is idempotent until observe()', async () => {
    const cfg = randomCart(3, 4);
    const sim = new PricingSimulator(cfg);
    const eng = createEngine(toItems(cfg), mkParams(2, 0));
    const a = eng.next();
    expect(eng.next()).toEqual(a);
    const r = await sim.probe(a!);
    if (r.kind !== 'ok' && r.kind !== 'infeasible') throw new Error('unexpected');
    eng.observe(a!, r);
    expect(eng.next()).not.toEqual(a);
  });

  it('observe throws for the wrong selection and for non ok/infeasible results', async () => {
    const cfg = randomCart(3, 4);
    const sim = new PricingSimulator(cfg);
    const eng = createEngine(toItems(cfg), mkParams(2, 0));
    const pending = eng.next()!;
    const other = [sim.lineIds[0]!];
    const r = await sim.probe(other);
    if (r.kind !== 'ok' && r.kind !== 'infeasible') throw new Error('unexpected');
    expect(() => eng.observe(other, r)).toThrow(/pending/);
    expect(() => eng.observe(pending, { kind: 'error', reason: 'x' })).toThrow();
    expect(() => eng.observe(pending, { kind: 'blocked', reason: 'captcha' })).toThrow();
    expect(() => eng.observe(['nope'], r)).toThrow();
    // nothing was consumed
    expect(eng.next()).toEqual(pending);
  });

  it('exact=false when budget-capped, true after full run; partial results mid-run', async () => {
    const cfg = randomCart(21, 4);
    const sim = new PricingSimulator(cfg);
    const eng = createEngine(toItems(cfg), mkParams(3, 0));
    expect(eng.results().exact).toBe(false);
    expect(eng.results().A).toEqual([]);
    const out = await driveEngine(eng, sim, 6);
    expect(out.stop).toBe('budget');
    expect(out.probes).toBe(6);
    expect(out.results.exact).toBe(false);
    // U + 4 singletons are probed: partition into singletons must be rankable if feasible
    const A = out.results.A!;
    expect(A.length).toBeGreaterThan(0);
    for (const r of A) for (const g of r.groups) expect(g.quote.status).toBe('ok');
    const done = await driveEngine(eng, sim, 100);
    expect(done.stop).toBe('done');
    expect(done.results.exact).toBe(true);
  });

  it('rejects bad input, unsupported n and mismatched saved state', async () => {
    const cfg = randomCart(5, 4);
    const items = toItems(cfg);
    expect(() => createEngine([], mkParams(2, 0))).toThrow();
    expect(() => createEngine(items, mkParams(0, 0))).toThrow(/kMax/);
    expect(() => createEngine(items, mkParams(2, -1))).toThrow(/bMinValue/);
    expect(() => createEngine(items, mkParams(2, 0, { nExh: 9 }))).toThrow(/nExh/);
    expect(() => createEngine(items, mkParams(2, 0, { maxProbes: 0 }))).toThrow(/maxProbes/);
    const big = toItems(randomCart(5, 8));
    expect(createEngine(big, mkParams(2, 0)).kind).toBe('heuristic');
    const eng = createEngine(items, mkParams(2, 0));
    const st = eng.serialize();
    expect(() => createEngine(items.slice(1), mkParams(2, 0), st)).toThrow();
    expect(() => createEngine(items, mkParams(3, 0), st)).toThrow(/params/);
    const swapped = [items[1]!, items[0]!, ...items.slice(2)];
    expect(() => createEngine(swapped, mkParams(2, 0), st)).toThrow(/items/);
  });
});

describe('exhaustive engine vs brute force (300 random carts, n 1..6)', () => {
  it('A and B match ground truth', async () => {
    const t0 = Date.now();
    const rng = createRng(4242);
    let withCoupons = 0;
    let noAnswer = 0;
    for (let c = 0; c < 300; c++) {
      const n = 1 + (c % 6);
      const cfg = randomCart(1000 + c, n);
      const kMax = rng.int(1, 4);
      const bMin = rng.pick(B_MINS);
      const sim = new PricingSimulator(cfg);
      const params = mkParams(kMax, bMin);
      const eng = createEngine(toItems(cfg), params);
      const out = await driveEngine(eng, sim, 1000);
      const label = `cart ${c} (n=${n}, kMax=${kMax}, bMin=${bMin})`;
      expect(out.stop, label).toBe('done');
      expect(out.probes, label).toBe(2 ** n - 1);
      expect(out.results.exact, label).toBe(true);

      const trueA = trueOptimumA(sim, kMax);
      const A = out.results.A!;
      if (trueA.optimum === null) {
        expect(A, label).toEqual([]);
        noAnswer++;
      } else {
        expect(A.length, label).toBeGreaterThan(0);
        const bf = await bruteForceA(new PricingSimulator(cfg), kMax);
        expect(A[0]!.cost, label).toBe(bf);
        if (cfg.coupons.length === 0) {
          expect(A[0]!.cost, label).toBe(trueA.optimum.cost);
        } else {
          withCoupons++;
          expect(A[0]!.cost, label).toBeGreaterThanOrEqual(trueA.optimum.cost);
        }
      }

      const trueB = trueOptimumB(sim, bMin);
      const B = out.results.B!;
      if (trueB.optimum === null) {
        expect(B, label).toEqual([]);
      } else {
        expect(B.length, label).toBeGreaterThan(0);
        expect(B[0]!.ratio, label).toBe(trueB.optimum.ratio);
        expect(B[0]!.quote.goodsNet, label).toBe(trueB.optimum.goodsNet);
        expect(B[0]!.quote.overhead, label).toBe(trueB.optimum.overhead);
        if (cfg.coupons.length === 0) {
          const ties = trueB.ties.map((t) => selectionKey(t.lineIds));
          expect(ties, label).toContain(selectionKey(B[0]!.lineIds));
        }
      }
    }
    console.log(
      `300-cart exhaustive test: ${Date.now() - t0} ms (coupon carts: ${withCoupons}, no-answer: ${noAnswer})`,
    );
  }, 120_000);
});

describe('serialize / restore', () => {
  it('resumed run equals an uninterrupted run', async () => {
    const rng = createRng(77);
    for (let c = 0; c < 60; c++) {
      const n = 2 + (c % 5);
      const cfg = randomCart(5000 + c, n);
      const params = mkParams(rng.int(1, 4), rng.pick(B_MINS));
      const items = toItems(cfg);

      const simFull = new PricingSimulator(cfg);
      const full = await driveEngine(createEngine(items, params), simFull, 1000);

      const sim = new PricingSimulator(cfg);
      const eng1 = createEngine(items, params);
      const stopAt = rng.int(0, 2 ** n - 1);
      const part = await driveEngine(eng1, sim, stopAt);
      const state = JSON.parse(JSON.stringify(eng1.serialize())) as EngineState;
      expect(state).toEqual(eng1.serialize());
      const eng2 = createEngine(items, params, state);
      expect(eng2.results()).toEqual(eng1.results());
      expect(eng2.next()).toEqual(eng1.next());
      const rest = await driveEngine(eng2, sim, 1000);
      expect(rest.results, `cart ${c}`).toEqual(full.results);
      expect(part.probes + rest.probes, `cart ${c}`).toBe(full.probes);
    }
  });
});

describe('driveEngine failure handling', () => {
  it('stops immediately on blocked', async () => {
    const cfg = randomCart(8, 4);
    const sim = new PricingSimulator(cfg, { inject: (i) => (i === 2 ? 'blocked' : null) });
    const out = await driveEngine(createEngine(toItems(cfg), mkParams(2, 0)), sim, 100);
    expect(out.stop).toBe('blocked');
    expect(out.probes).toBe(3);
    expect(sim.probeCount).toBe(3);
  });

  it('stops after 2 consecutive errors', async () => {
    const cfg = randomCart(8, 4);
    const sim = new PricingSimulator(cfg, { inject: (i) => (i === 1 || i === 2 ? 'error' : null) });
    const out = await driveEngine(createEngine(toItems(cfg), mkParams(2, 0)), sim, 100);
    expect(out.stop).toBe('errors');
    expect(out.probes).toBe(3);
  });

  it('error then ok continues and re-asks the same selection', async () => {
    const cfg = randomCart(8, 3);
    const sim = new PricingSimulator(cfg, {
      inject: (i) => (i === 1 || i === 4 ? 'error' : null),
    });
    const out = await driveEngine(createEngine(toItems(cfg), mkParams(2, 0)), sim, 100);
    expect(out.stop).toBe('done');
    expect(out.results.exact).toBe(true);
    expect(out.probes).toBe(7 + 2);
  });
});
