import { describe, expect, it } from 'vitest';
import { driveEngine } from '../../../src/core/search/drive';
import { createEngine } from '../../../src/core/search/engine';
import type { SearchEngine } from '../../../src/core/search/engine';
import { createTopDownGreedyEngine } from '../../../src/core/search/topDownGreedy';
import { selectionKey } from '../../../src/core/selection';
import type {
  CartItem,
  ProbeClient,
  ProbeResult,
  Quote,
  SearchParams,
  Selection,
} from '../../../src/core/types';
import { randomCart } from '../../../src/sim/randomCart';
import { PricingSimulator, trueOptimumB } from '../../../src/sim/simulator';
import type { SimConfig } from '../../../src/sim/simulator';

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
  objective: 'B',
  strategyB: 'topDownGreedy',
  nExh: 6,
  kMax: 3,
  bMinValue: 20000,
  rShow: 5,
  maxProbes: 80,
  ...extra,
});

describe('topDownGreedy on simulator carts', () => {
  it('never beats-by-worse the baseline, respects budgets and the n(n+1)/2+1 bound', async () => {
    for (let seed = 1; seed <= 100; seed++) {
      const n = 7 + (seed % 6);
      const cfg = randomCart(seed, n);
      const items = toItems(cfg);
      const truth = trueOptimumB(new PricingSimulator(cfg), 20000);
      for (const maxProbes of [10, 20, 80]) {
        const sim = new PricingSimulator(cfg);
        const eng = createEngine(items, params({ maxProbes }));
        expect(eng.kind).toBe('topDownGreedy');
        const out = await driveEngine(eng, sim, maxProbes);
        expect(out.probes).toBeLessThanOrEqual(maxProbes);
        expect(sim.probeCount).toBeLessThanOrEqual(maxProbes);
        expect(eng.done()).toBe(true);
        if (maxProbes === 80) expect(out.probes).toBeLessThanOrEqual((n * (n + 1)) / 2 + 1);
        const top = out.results.B?.[0];
        if (truth.baselineRatio !== null) {
          expect(top).toBeDefined();
          expect(top!.ratio).toBeLessThanOrEqual(truth.baselineRatio);
        }
        if (top && truth.optimum) expect(top.ratio).toBeGreaterThanOrEqual(truth.optimum.ratio);
      }
    }
  });
});

describe('topDownGreedy contract', () => {
  const cfg = randomCart(11, 9);
  const items = toItems(cfg);

  it('is idempotent, rejects wrong selections and bad results', async () => {
    const sim = new PricingSimulator(cfg);
    const eng = createEngine(items, params());
    const first = eng.next();
    expect(eng.next()).toEqual(first);
    expect(first!.length).toBe(9);
    expect(() => eng.observe([items[0]!.lineId], { kind: 'error', reason: 'x' })).toThrow();
    const other = items.slice(1).map((i) => i.lineId);
    await expect(
      Promise.resolve().then(async () => eng.observe(other, await sim.probe(other))),
    ).rejects.toThrow(/pending/);
    expect(() => eng.observe(first!, { kind: 'blocked', reason: 'captcha' })).toThrow();
    expect(eng.results().exact).toBe(false);
  });

  it('never re-proposes a quoted mask', async () => {
    const sim = new PricingSimulator(cfg);
    const eng = createEngine(items, params());
    const seen = new Set<string>();
    while (!eng.done()) {
      const sel = eng.next()!;
      expect(sel.length).toBeGreaterThan(0);
      const k = selectionKey(sel);
      expect(seen.has(k)).toBe(false);
      seen.add(k);
      eng.observe(sel, await sim.probe(sel));
    }
  });

  it('serialize/JSON/restore mid-run gives identical continuation', async () => {
    const run = async (restoreAt: number | null): Promise<{ probes: string[]; res: string }> => {
      const sim = new PricingSimulator(cfg);
      let eng: SearchEngine = createEngine(items, params());
      const probes: string[] = [];
      let step = 0;
      while (!eng.done()) {
        if (step === restoreAt) {
          const st = JSON.parse(JSON.stringify(eng.serialize())) as ReturnType<
            SearchEngine['serialize']
          >;
          expect(st).toMatchObject({ v: 1, kind: 'topDownGreedy' });
          eng = createEngine(items, params(), st);
        }
        const sel = eng.next()!;
        probes.push(selectionKey(sel));
        eng.observe(sel, await sim.probe(sel));
        step++;
      }
      return { probes, res: JSON.stringify(eng.results()) };
    };
    const base = await run(null);
    expect(base.probes.length).toBeGreaterThan(10);
    expect(await run(4)).toEqual(base);
    expect(await run(12)).toEqual(base);
  });

  it('routes by objective, strategy, n and state kind', () => {
    expect(createEngine(items, params()).kind).toBe('topDownGreedy');
    expect(createEngine(items, params({ strategyB: 'heuristic' })).kind).toBe('heuristic');
    expect(createEngine(items, params({ objective: 'A' })).kind).toBe('heuristic');
    const small = items.slice(0, 6);
    expect(createEngine(small, params()).kind).toBe('exhaustive');
    const st = createEngine(items, params()).serialize();
    expect(() => createEngine(items, params({ strategyB: 'heuristic' }), st)).toThrow(
      /does not match/,
    );
    expect(() => createEngine(items, params({ bMinValue: 1 }), st)).toThrow(/params/);
  });
});

describe('topDownGreedy hand-built case', () => {
  // 7 items at 100 yuan; item 0 is heavy (extra 50 yuan overhead), base overhead 30 yuan.
  // U: O=80, G=700. Removing item 0: O=30, G=600 (0.05) wins over removing others (O=80, G=600).
  // Then from {1..6}: every removal gives O=30, G=500 (0.06) > 0.05, so stop.
  const items: CartItem[] = Array.from({ length: 7 }, (_, i) => ({
    lineId: `L${i}`,
    itemId: `I${i}`,
    skuId: null,
    shopId: 's',
    shopName: 's',
    title: `t${i}`,
    unitPrice: 10000,
    qty: 1,
    selected: true,
    selectable: true,
  }));
  const client: ProbeClient & { log: string[] } = {
    log: [],
    async probe(sel: Selection): Promise<ProbeResult> {
      this.log.push(sel.join(','));
      const g = sel.length * 10000;
      const o = 3000 + (sel.includes('L0') ? 5000 : 0);
      const quote: Quote = {
        key: selectionKey(sel),
        lineIds: [...sel],
        status: 'ok',
        goodsNet: g,
        grandTotal: g + o,
        overhead: o,
        coupons: [],
        breakdownConsistent: true,
        capturedAt: 0,
        addressId: 'a',
      };
      return { kind: 'ok', quote, fromCache: false };
    },
  };

  it('follows the expected path', async () => {
    const eng = createEngine(items, params({ bMinValue: 20000 }));
    const out = await driveEngine(eng, client, 80);
    // U, then 7 removals, then 6 removals from {1..6}
    expect(out.probes).toBe(14);
    expect(client.log[0]).toBe('L0,L1,L2,L3,L4,L5,L6');
    expect(client.log[1]).toBe('L1,L2,L3,L4,L5,L6'); // remove L0 first
    expect(client.log[8]).toBe('L2,L3,L4,L5,L6'); // then remove L1 from {L1..L6}
    const top = out.results.B![0]!;
    expect([...top.lineIds]).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
    expect(top.ratio).toBeCloseTo(0.05, 10);
  });

  it('skips candidates whose gross value is below bMin', async () => {
    const c2 = { ...client, log: [] as string[] };
    const eng = createTopDownGreedyEngine(items.slice(0, 3), params({ bMinValue: 25000 }));
    const out = await driveEngine(eng, c2, 80);
    expect(out.probes).toBe(1); // U only: every pair is worth 20000 < 25000
  });
});

describe('topDownGreedy vs true optimum (logged)', () => {
  it('reports hit rate and mean probes at n = 10', async () => {
    let hit = 0;
    let within = 0;
    let total = 0;
    let probes = 0;
    const N = 50;
    for (let seed = 1; seed <= N; seed++) {
      const cfg = randomCart(1000 + seed, 10);
      const truth = trueOptimumB(new PricingSimulator(cfg), 20000);
      if (!truth.optimum) continue;
      const sim = new PricingSimulator(cfg);
      const eng = createEngine(toItems(cfg), params({ bMinValue: 20000, maxProbes: 80 }));
      const out = await driveEngine(eng, sim, 80);
      probes += out.probes;
      total++;
      const top = out.results.B?.[0];
      if (top && top.ratio <= truth.optimum.ratio) hit++;
      if (top && top.ratio <= truth.optimum.ratio * 1.03) within++;
    }
    console.log(
      `topDownGreedy B n=10: hit ${hit}/${total} (${((100 * hit) / total).toFixed(0)}%), within3% ${within}/${total} (${((100 * within) / total).toFixed(0)}%), mean probes ${(probes / total).toFixed(1)}`,
    );
    expect(total).toBeGreaterThan(0);
  });
});
