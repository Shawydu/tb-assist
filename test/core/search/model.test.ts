import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { buildModel, invertRate, rateFn } from '../../../src/core/search/model';
import type { PredictionModel } from '../../../src/core/search/model';
import type { CartItem, Quote, RateTable } from '../../../src/core/types';
import { randomCart } from '../../../src/sim/randomCart';
import { PricingSimulator } from '../../../src/sim/simulator';
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

async function probeMasks(sim: PricingSimulator, masks: number[]): Promise<Map<number, Quote>> {
  const quotes = new Map<number, Quote>();
  for (const m of masks) {
    const r = await sim.probe(sim.lineIdsOf(m));
    if (r.kind === 'ok' || r.kind === 'infeasible') quotes.set(m, r.quote);
  }
  return quotes;
}

/** Heuristic pre-verify phases (design §7.2): U, singletons, per-shop groups. */
function preVerifyMasks(cfg: SimConfig): number[] {
  const n = cfg.items.length;
  const masks = [2 ** n - 1];
  for (let i = 0; i < n; i++) masks.push(1 << i);
  const byShop = new Map<string, number>();
  cfg.items.forEach((it, i) => byShop.set(it.shopId, (byShop.get(it.shopId) ?? 0) | (1 << i)));
  for (const m of byShop.values()) if ((m & (m - 1)) !== 0 && m !== 2 ** n - 1) masks.push(m);
  return masks;
}

/** Light bracket of the simulator's tiered table, as the user-configured RateTable. */
function simRateTable(cfg: SimConfig): RateTable {
  const b = cfg.consolidation.brackets[0];
  if (!b) throw new Error('no bracket');
  return { firstKg: b.firstKg, firstFee: b.firstFee, stepKg: b.stepKg, stepFee: b.stepFee };
}

const RT: RateTable = { firstKg: 1, firstFee: 4000, stepKg: 0.5, stepFee: 1500 };

function mkQuote(over: Partial<Quote> & { lineIds: string[] }): Quote {
  const { lineIds, ...rest } = over;
  return {
    key: JSON.stringify(lineIds),
    lineIds,
    status: 'ok',
    goodsNet: 10000,
    grandTotal: 10000,
    overhead: 0,
    coupons: [],
    breakdownConsistent: true,
    capturedAt: 0,
    addressId: 'a',
    ...rest,
  };
}

function mkItem(i: number, shopId: string, unitPrice = 10000): CartItem {
  return {
    lineId: `L${i}`,
    itemId: `I${i}`,
    skuId: null,
    shopId,
    shopName: shopId,
    title: `t${i}`,
    unitPrice,
    qty: 1,
    selected: true,
    selectable: true,
  };
}

describe('rateFn / invertRate', () => {
  it('computes first + step fees', () => {
    expect(rateFn(RT, 0)).toBe(0);
    expect(rateFn(RT, 0.3)).toBe(4000);
    expect(rateFn(RT, 1)).toBe(4000);
    expect(rateFn(RT, 1.01)).toBe(5500);
    expect(rateFn(RT, 1.5)).toBe(5500);
    expect(rateFn(RT, 2.2)).toBe(4000 + 3 * 1500);
  });

  it('inverts to a weight bracket', () => {
    expect(invertRate(RT, 4000)).toEqual({ lo: 0, hi: 1 });
    expect(invertRate(RT, 5500)).toEqual({ lo: 1, hi: 1.5 });
    expect(invertRate(RT, 8500)).toEqual({ lo: 2, hi: 2.5 });
    for (const w of [0.2, 1.3, 2.4, 3.9]) {
      const br = invertRate(RT, rateFn(RT, w));
      expect(br).not.toBeNull();
      expect(w).toBeGreaterThan((br as { lo: number }).lo - 1e-9);
      expect(w).toBeLessThanOrEqual((br as { hi: number }).hi + 1e-9);
    }
  });

  it('tolerates +-50 fen and rejects off-lattice fees', () => {
    expect(invertRate(RT, 5540)).toEqual({ lo: 1, hi: 1.5 });
    expect(invertRate(RT, 5000)).toBeNull();
    expect(invertRate(RT, 3000)).toBeNull();
  });
});

describe('simulator data: exact reproduction', () => {
  it('predictO equals the quote overhead for every probed mask', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const cfg = randomCart(seed, 8);
      const sim = new PricingSimulator(cfg);
      const items = toItems(cfg);
      const masks = [...preVerifyMasks(cfg), 0b101, 0b1011, 0b11110];
      const quotes = await probeMasks(sim, masks);
      for (const rt of [undefined, simRateTable(cfg)]) {
        const model = buildModel(items, quotes, rt);
        for (const [m, q] of quotes) {
          expect(model.predictO(m)).toBe(q.status === 'ok' ? q.overhead : Infinity);
          if (q.status === 'ok') expect(model.predictG(m)).toBe(q.goodsNet);
        }
      }
    }
  });

  it('predictG sums singleton goods when unquoted, falls back to unitPrice*qty', async () => {
    const cfg = randomCart(3, 6);
    const sim = new PricingSimulator(cfg);
    const items = toItems(cfg);
    const quotes = await probeMasks(sim, [1, 2]);
    const model = buildModel(items, quotes);
    const g = (i: number): number => (items[i] as CartItem).unitPrice * (items[i] as CartItem).qty;
    expect(model.predictG(0b11)).toBe(
      (quotes.get(1) as Quote).goodsNet + (quotes.get(2) as Quote).goodsNet,
    );
    expect(model.predictG(0b1100)).toBe(g(2) + g(3));
  });
});

describe('international fee fitting', () => {
  it('recovers a known alpha on synthetic data', () => {
    // true weights 0.35 kg each; singleton fee = firstFee (mid 0.5 kg). True alpha = 0.7
    // against mid 0.5: W(S) = 0.7 * |S| * 0.5 = 0.35|S|.
    const items = [0, 1, 2, 3, 4, 5].map((i) => mkItem(i, 's1'));
    const quotes = new Map<number, Quote>();
    const trueAlpha = 0.7;
    const fee = (k: number): number => rateFn(RT, trueAlpha * k * 0.5);
    for (let i = 0; i < 6; i++) {
      quotes.set(
        1 << i,
        mkQuote({
          lineIds: [`L${i}`],
          consolidationFee: fee(1),
          domesticByShop: { s1: 0 },
          overhead: fee(1),
        }),
      );
    }
    // k=2..6 verified quotes: weights 0.7, 1.05, 1.4, 1.75, 2.1 -> distinct fees
    for (const k of [2, 4, 5, 6]) {
      const mask = (1 << k) - 1;
      quotes.set(
        mask,
        mkQuote({
          lineIds: [],
          consolidationFee: fee(k),
          domesticByShop: { s1: 0 },
          overhead: fee(k),
        }),
      );
    }
    const model = buildModel(items, quotes, RT);
    expect(model.mode).toBe('rateTable');
    expect(model.calibrated).toBe(true);
    expect(model.params.alpha).toBeGreaterThanOrEqual(0.66);
    expect(model.params.alpha).toBeLessThanOrEqual(0.76);
    expect(model.predictO(0b101)).toBe(fee(2)); // unprobed pair predicted from fitted alpha
    expect(model.predictO(0b1011)).toBe(fee(3));
  });

  it('falls back to marginal + uncalibrated when a singleton fee is off the lattice', () => {
    const items = [0, 1, 2].map((i) => mkItem(i, 's1'));
    const quotes = new Map<number, Quote>();
    const fees = [4000, 5500, 5000]; // 5000 is off the lattice
    fees.forEach((f, i) =>
      quotes.set(
        1 << i,
        mkQuote({
          lineIds: [`L${i}`],
          consolidationFee: f,
          domesticByShop: { s1: 0 },
          overhead: f,
        }),
      ),
    );
    const model = buildModel(items, quotes, RT);
    expect(model.mode).toBe('marginal');
    expect(model.calibrated).toBe(false);
    expect(model.params.F0).toBe(4000);
  });

  it('marginal mode: first-weight fee is paid once per group', () => {
    const items = [0, 1, 2].map((i) => mkItem(i, 's1'));
    const quotes = new Map<number, Quote>();
    [4000, 5500, 7000].forEach((f, i) =>
      quotes.set(
        1 << i,
        mkQuote({
          lineIds: [`L${i}`],
          consolidationFee: f,
          domesticByShop: { s1: 0 },
          overhead: f,
        }),
      ),
    );
    const model = buildModel(items, quotes);
    expect(model.mode).toBe('marginal');
    expect(model.calibrated).toBe(true);
    expect(model.params).toMatchObject({ F0: 4000, beta: 1 });
    expect(model.predictO(0b110)).toBe(4000 + 1500 + 3000);
    expect(model.predictO(0b111)).toBe(4000 + 0 + 1500 + 3000);
  });

  it('fits beta on verified multi-item quotes', () => {
    const items = [0, 1, 2, 3].map((i) => mkItem(i, 's1'));
    const quotes = new Map<number, Quote>();
    [4000, 6000, 6000, 6000].forEach((f, i) =>
      quotes.set(
        1 << i,
        mkQuote({
          lineIds: [`L${i}`],
          consolidationFee: f,
          domesticByShop: { s1: 0 },
          overhead: f,
        }),
      ),
    );
    // true multi-item fees are 0.6 * excess: {1,2,3}: 4000 + 0.6*6000 = 7600
    quotes.set(
      0b1111,
      mkQuote({ lineIds: [], consolidationFee: 7600, domesticByShop: { s1: 0 }, overhead: 7600 }),
    );
    const model = buildModel(items, quotes);
    expect(model.params.beta).toBeCloseTo(0.6, 1);
    expect(model.predictO(0b0111)).toBeGreaterThan(4000);
    expect(model.predictO(0b0111)).toBeLessThan(4000 + 2 * 2000 + 1);
  });
});

describe('domestic predictor', () => {
  const single = (i: number, shop: string, dom: number, fee = 4000): Quote =>
    mkQuote({
      lineIds: [`L${i}`],
      consolidationFee: fee,
      domesticByShop: { [shop]: dom },
      overhead: dom + fee,
    });

  it('charges the max singleton freight once per order', () => {
    const items = [mkItem(0, 's1'), mkItem(1, 's1'), mkItem(2, 's2')];
    const quotes = new Map<number, Quote>([
      [1, single(0, 's1', 800)],
      [2, single(1, 's1', 1000)],
      [4, single(2, 's2', 500)],
    ]);
    const model = buildModel(items, quotes);
    // F0 = 4000, fees all 4000 -> intl 4000 for any mask
    expect(model.predictO(0b011)).toBe(1000 + 4000);
    expect(model.predictO(0b111)).toBe(1000 + 500 + 4000);
  });

  it('applies the full-shop free-shipping threshold (by amount)', () => {
    const items = [mkItem(0, 's1', 6000), mkItem(1, 's1', 6000), mkItem(2, 's1', 6000)];
    const quotes = new Map<number, Quote>([
      [1, single(0, 's1', 1000)],
      [2, single(1, 's1', 1000)],
      [4, single(2, 's1', 1000)],
      [
        7,
        mkQuote({ lineIds: [], consolidationFee: 4000, domesticByShop: { s1: 0 }, overhead: 4000 }),
      ],
    ]);
    const model = buildModel(items, quotes);
    expect(model.predictO(0b111)).toBe(4000); // observed
    // subsets are below the full-shop goods: no threshold inferred -> base freight
    expect(model.predictO(0b011)).toBe(1000 + 4000);
  });

  it('applies the subset threshold rule from an observed smaller group', () => {
    const items = [mkItem(0, 's1'), mkItem(1, 's1'), mkItem(2, 's1'), mkItem(3, 's1')];
    const quotes = new Map<number, Quote>([
      [1, single(0, 's1', 1000)],
      [2, single(1, 's1', 1000)],
      [4, single(2, 's1', 1000)],
      [8, single(3, 's1', 1000)],
      [
        0b0011,
        mkQuote({ lineIds: [], consolidationFee: 4000, domesticByShop: { s1: 0 }, overhead: 4000 }),
      ],
    ]);
    const model = buildModel(items, quotes);
    expect(model.predictO(0b0111)).toBe(4000); // contains the free {0,1} subgroup
    expect(model.predictO(0b1100)).toBe(1000 + 4000); // no free subgroup inside
  });

  it('infers free shipping by count on simulator-like data', () => {
    const items = [0, 1, 2].map((i) => mkItem(i, 's1', 3000));
    const quotes = new Map<number, Quote>([
      [1, single(0, 's1', 800)],
      [2, single(1, 's1', 800)],
      [4, single(2, 's1', 800)],
      [
        0b110,
        mkQuote({ lineIds: [], consolidationFee: 4000, domesticByShop: { s1: 0 }, overhead: 4000 }),
      ],
    ]);
    const model = buildModel(items, quotes);
    expect(model.predictO(0b111)).toBe(4000);
    expect(model.predictO(0b101)).toBe(800 + 4000);
  });
});

describe('overhead-only mode (no breakdown)', () => {
  it('works from overhead alone when breakdown fields are stripped', async () => {
    const cfg = randomCart(11, 8);
    const sim = new PricingSimulator(cfg);
    const items = toItems(cfg);
    const full = await probeMasks(sim, [...preVerifyMasks(cfg), 0b111, 0b1001]);
    const stripped = new Map<number, Quote>();
    for (const [m, q] of full) {
      const copy: Quote = { ...q };
      delete copy.domesticByShop;
      delete copy.consolidationFee;
      delete copy.shippingDiscounts;
      delete copy.otherFees;
      delete copy.tax;
      stripped.set(m, copy);
    }
    const model = buildModel(items, stripped, simRateTable(cfg));
    expect(model.mode).toBe('overheadOnly');
    for (const [m, q] of stripped) {
      expect(model.predictO(m)).toBe(q.status === 'ok' ? q.overhead : Infinity);
    }
    const pred = model.predictO(0b110000);
    expect(Number.isFinite(pred)).toBe(true);
  });
});

describe('infeasible handling', () => {
  it('Infinity for observed infeasible masks and masks containing an infeasible singleton', () => {
    const items = [0, 1, 2].map((i) => mkItem(i, 's1'));
    const quotes = new Map<number, Quote>([
      [
        1,
        mkQuote({
          lineIds: ['L0'],
          consolidationFee: 4000,
          domesticByShop: { s1: 0 },
          overhead: 4000,
        }),
      ],
      [2, mkQuote({ lineIds: ['L1'], status: 'infeasible', overhead: 0 })],
      [
        4,
        mkQuote({
          lineIds: ['L2'],
          consolidationFee: 4000,
          domesticByShop: { s1: 0 },
          overhead: 4000,
        }),
      ],
      [5, mkQuote({ lineIds: ['L0', 'L2'], status: 'infeasible', overhead: 0 })],
    ]);
    const model = buildModel(items, quotes);
    expect(model.predictO(2)).toBe(Infinity);
    expect(model.predictO(0b011)).toBe(Infinity);
    expect(model.predictO(0b110)).toBe(Infinity);
    expect(model.predictO(5)).toBe(Infinity);
    expect(Number.isFinite(model.predictO(1))).toBe(true);
  });

  it('handles an empty observation set without throwing', () => {
    const items = [0, 1].map((i) => mkItem(i, 's1'));
    const model = buildModel(items, new Map(), RT);
    expect(model.calibrated).toBe(false);
    expect(Number.isFinite(model.predictO(0b11))).toBe(true);
    expect(model.predictG(0b11)).toBe(20000);
  });
});

describe('accuracy report', () => {
  it('reports median / p90 absolute error of predictO on unprobed multi-item masks', async () => {
    const stats: Record<'marginal' | 'rateTable', { abs: number[]; pct: number[] }> = {
      marginal: { abs: [], pct: [] },
      rateTable: { abs: [], pct: [] },
    };
    const modes: Record<string, number> = {};
    for (let seed = 1; seed <= 100; seed++) {
      const cfg = randomCart(1000 + seed, 10);
      const sim = new PricingSimulator(cfg);
      const items = toItems(cfg);
      const probed = preVerifyMasks(cfg);
      const quotes = await probeMasks(sim, probed);
      const rng = createRng(seed);
      const targets: number[] = [];
      while (targets.length < 50) {
        const m = rng.int(1, 2 ** 10 - 1);
        if ((m & (m - 1)) === 0 || quotes.has(m) || !sim.info(m).feasible) continue;
        targets.push(m);
      }
      const variants: [keyof typeof stats, PredictionModel][] = [
        ['marginal', buildModel(items, quotes)],
        ['rateTable', buildModel(items, quotes, simRateTable(cfg))],
      ];
      for (const [name, model] of variants) {
        if (name === 'rateTable') modes[model.mode] = (modes[model.mode] ?? 0) + 1;
        for (const m of targets) {
          const truth = sim.trueOverhead(sim.lineIdsOf(m)) as number;
          const pred = model.predictO(m);
          expect(Number.isFinite(pred)).toBe(true);
          stats[name].abs.push(Math.abs(pred - truth));
          stats[name].pct.push((Math.abs(pred - truth) / Math.max(truth, 1)) * 100);
        }
      }
    }
    const q = (xs: number[], p: number): number => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
    };
    for (const name of ['marginal', 'rateTable'] as const) {
      const { abs, pct } = stats[name];
      console.log(
        `[T6 accuracy] ${name}: median abs ${q(abs, 0.5)} fen (${q(pct, 0.5).toFixed(1)}%), ` +
          `p90 abs ${q(abs, 0.9)} fen (${q(pct, 0.9).toFixed(1)}%), n=${abs.length}`,
      );
      expect(Number.isFinite(q(abs, 0.5))).toBe(true);
      expect(Number.isFinite(q(abs, 0.9))).toBe(true);
    }
    console.log(`[T6 accuracy] rate-table carts by resulting mode: ${JSON.stringify(modes)}`);
  });
});
