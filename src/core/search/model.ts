// Prediction model (design §7.3). INTERNAL ONLY: predictions choose what to probe next and
// are never shown as costs. Pure TS; selections are bitmasks over the item (U) index order.
//
// Money: observed values are integer fen. Predictions for unprobed masks are computed with
// fractional intermediates and returned rounded to integer fen (Infinity = known infeasible).
//
// Documented simplifications / deviations from design §7.3:
//  - Subset-threshold rule only considers observed subgroups with >= 2 items (a cheaper singleton
//    just defines the max-of-singletons base; it is not evidence of a threshold).
//  - Shipping discounts: predictedShippingDiscounts(mask) is 0 for unprobed masks (only exact
//    observed quotes carry them, via the observed-quote shortcut).
//  - Coupons: the model predicts pre-coupon overhead (domestic + consolidation fee). Coupon
//    effects and conflicts are handled by cost.ts on verified quotes only; so for a coupon-
//    affected mask the prediction can exceed the true O by up to the coupon amount.
//  - otherFees / tax are not modeled for unprobed masks.
//  - A singleton that was never probed gets fallback values: fee = mean of known singleton
//    fees, domestic = max known singleton domestic in the same shop (else 0).
//  - Feasibility: only observed-infeasible masks and masks containing an infeasible singleton
//    are Infinity. Overweight supersets of feasible masks are not predicted (no monotonicity
//    assumption); the verify loop catches them with a real probe.
//  - β (marginal) is fitted on a grid 0.40..1.40 step 0.02 by least squares, like α.

import { lookupQuote } from '../cost';
import { createRng } from '../rng';
import { maskIndices } from '../selection';
import { fitFeeModel } from './feeModel';
import type { CartItem, Fen, Quote, RateTable } from '../types';

export type ModelMode = 'rateTable' | 'marginal' | 'latent' | 'overheadOnly';

export interface ModelOptions {
  /** Use the latent-weight fee model (feeModel.ts) when no rate table is given. */
  latent?: boolean;
  /** Seed for the latent model's sampler. */
  seed?: number;
}

export interface PredictionModel {
  /** Predicted (or exact, if quoted) overhead; Infinity if known infeasible. */
  predictO(mask: number): number;
  /** Observed G if quoted, else Σ singleton G (quoted) or unitPrice*qty. */
  predictG(mask: number): Fen;
  /** Latent mode only: per-sample overhead of a mask (Infinity = infeasible in that sample). */
  samplesO?(mask: number): Float64Array;
  /** Latent mode: coupons a mask is expected to qualify for (samplesO is pre-coupon). */
  couponOptions?(mask: number): { id: string; amount: Fen }[];
  readonly mode: ModelMode;
  /** false = "uncalibrated" in the debug view (rate table off-lattice, or no singleton data). */
  readonly calibrated: boolean;
  readonly params: { alpha?: number; beta?: number; F0?: number };
}

/** Fee (fen) for weight kg under a first/step rate table. */
export function rateFn(rt: RateTable, weightKg: number): Fen {
  if (weightKg <= 0) return 0;
  const steps = Math.ceil(Math.max(0, weightKg - rt.firstKg) / rt.stepKg - 1e-9);
  return rt.firstFee + steps * rt.stepFee;
}

/** Tolerance when matching an observed fee to the rate lattice (design: ±¥0.5). */
export const LATTICE_TOL: Fen = 50;

/**
 * Invert rateFn: weight bracket (lo, hi] producing `fee`, or null if the fee is not on the
 * lattice (within LATTICE_TOL).
 */
export function invertRate(rt: RateTable, fee: Fen): { lo: number; hi: number } | null {
  if (Math.abs(fee - rt.firstFee) <= LATTICE_TOL) return { lo: 0, hi: rt.firstKg };
  if (fee < rt.firstFee || rt.stepFee <= 0) return null;
  const k = Math.round((fee - rt.firstFee) / rt.stepFee);
  if (k < 1 || Math.abs(rt.firstFee + k * rt.stepFee - fee) > LATTICE_TOL) return null;
  return { lo: rt.firstKg + (k - 1) * rt.stepKg, hi: rt.firstKg + k * rt.stepKg };
}

const ALPHA_GRID = gridOf(0.6, 1.1, 0.02);
const BETA_GRID = gridOf(0.4, 1.4, 0.02);

function gridOf(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let i = 0; lo + i * step <= hi + 1e-9; i++)
    out.push(Math.round((lo + i * step) * 1e6) / 1e6);
  return out;
}

function bestOnGrid(grid: readonly number[], sqErr: (p: number) => number): number {
  let best = grid[0] as number;
  let bestErr = Infinity;
  for (const p of grid) {
    const e = sqErr(p);
    // strict < keeps the smallest parameter on ties; prefer 1.0 when it ties
    if (
      e < bestErr - 1e-9 ||
      (Math.abs(e - bestErr) <= 1e-9 && Math.abs(p - 1) < Math.abs(best - 1))
    ) {
      best = p;
      bestErr = e;
    }
  }
  return best;
}

const hasBreakdown = (q: Quote): boolean =>
  q.consolidationFee !== undefined && q.domesticByShop !== undefined;

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export function buildModel(
  items: readonly CartItem[],
  quotes: ReadonlyMap<number, Quote>,
  rateTable?: RateTable,
  opts: ModelOptions = {},
): PredictionModel {
  const n = items.length;

  // --- shops ---
  const shopIds = [...new Set(items.map((i) => i.shopId))];
  const shopMask = new Map<string, number>();
  items.forEach((it, i) => shopMask.set(it.shopId, (shopMask.get(it.shopId) ?? 0) | (1 << i)));

  // --- observed data ---
  const okQuotes: [number, Quote][] = [];
  const infeasible = new Set<number>();
  for (const [mask, q] of quotes) {
    if (q.status === 'ok') okQuotes.push([mask, q]);
    else infeasible.add(mask);
  }
  let ineligible = 0;
  for (let i = 0; i < n; i++) if (infeasible.has(1 << i)) ineligible |= 1 << i;

  const overheadOnly = okQuotes.length > 0 && !okQuotes.some(([, q]) => hasBreakdown(q));

  // observed (shop, subgroup) -> domestic fen
  const observed = new Map<string, Map<number, Fen>>();
  if (!overheadOnly) {
    for (const [mask, q] of okQuotes) {
      if (!q.domesticByShop) continue;
      for (const [shopId, dom] of Object.entries(q.domesticByShop)) {
        const sm = shopMask.get(shopId);
        if (sm === undefined) continue;
        const sub = mask & sm;
        if (sub === 0) continue;
        let m = observed.get(shopId);
        if (!m) observed.set(shopId, (m = new Map()));
        m.set(sub, dom);
      }
    }
  }

  // --- singleton data ---
  const knownFee: (number | undefined)[] = new Array<number | undefined>(n).fill(undefined);
  const singletonG: (Fen | undefined)[] = new Array<Fen | undefined>(n).fill(undefined);
  for (let i = 0; i < n; i++) {
    const q = quotes.get(1 << i);
    if (!q || q.status !== 'ok') continue;
    singletonG[i] = q.goodsNet;
    knownFee[i] = overheadOnly ? q.overhead : (q.consolidationFee ?? q.overhead);
  }
  const knownFees = knownFee.filter((f): f is number => f !== undefined);
  const fallbackFee = mean(knownFees);
  const fee = (i: number): number => knownFee[i] ?? fallbackFee;

  // d1[i]: singleton domestic
  const d1: number[] = new Array<number>(n).fill(0);
  const shopD1Max = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const it = items[i] as CartItem;
    const v = observed.get(it.shopId)?.get(1 << i);
    if (v !== undefined) {
      d1[i] = v;
      shopD1Max.set(it.shopId, Math.max(shopD1Max.get(it.shopId) ?? 0, v));
    }
  }
  for (let i = 0; i < n; i++) {
    const it = items[i] as CartItem;
    if (!observed.get(it.shopId)?.has(1 << i)) d1[i] = shopD1Max.get(it.shopId) ?? 0;
  }

  const goodsOf = (mask: number): Fen => {
    let g = 0;
    for (const i of maskIndices(mask)) {
      const it = items[i] as CartItem;
      g += singletonG[i] ?? it.unitPrice * it.qty;
    }
    return g;
  };

  // --- domestic predictor (design §7.3 pseudocode) ---
  const predictDomestic = (shopId: string, T: number): number => {
    if (T === 0) return 0;
    const obs = observed.get(shopId);
    const exact = obs?.get(T);
    if (exact !== undefined) return exact;
    let base = 0;
    for (const i of maskIndices(T)) base = Math.max(base, d1[i] as number);
    if (!obs) return base;
    const all = shopMask.get(shopId) as number;
    const dAll = obs.get(all);
    if (dAll !== undefined && dAll < base && goodsOf(T) >= goodsOf(all)) return dAll;
    let best = base;
    const gT = goodsOf(T);
    for (const [sub, dom] of obs) {
      if (sub & (sub - 1) && (sub & T) === sub && dom < best && gT >= goodsOf(sub)) best = dom;
    }
    return best;
  };

  // --- international predictor ---
  const multi = okQuotes.filter(([m, q]) => (m & (m - 1)) !== 0 && q.status === 'ok');
  const target = (q: Quote): number =>
    overheadOnly ? q.overhead : (q.consolidationFee ?? q.overhead);

  let mode: ModelMode = overheadOnly ? 'overheadOnly' : 'marginal';
  let calibrated = knownFees.length > 0;
  const params: { alpha?: number; beta?: number; F0?: number } = {};
  let predictIntl: (mask: number) => number;
  let fmLatent: NonNullable<ReturnType<typeof fitFeeModel>> | undefined;

  let latentCache: ReturnType<typeof fitFeeModel> | undefined;
  const latentFit = (): ReturnType<typeof fitFeeModel> => {
    if (latentCache !== undefined) return latentCache;
    const obs = okQuotes
      .filter(([, q]) => q.consolidationFee !== undefined)
      .map(([mask, q]) => ({ mask, fee: q.consolidationFee as number }));
    const heavy = [...infeasible].filter((m) => (m & (m - 1)) !== 0 && (m & ineligible) === 0);
    latentCache = fitFeeModel(n, obs, heavy, createRng((opts.seed ?? 0x5eed) >>> 0));
    return latentCache;
  };

  let mids: number[] | null = null;
  if (rateTable && !overheadOnly) {
    if (knownFees.length === 0) {
      calibrated = false;
    } else {
      const ms: number[] = new Array<number>(n).fill(NaN);
      let onLattice = true;
      for (let i = 0; i < n && onLattice; i++) {
        const f = knownFee[i];
        if (f === undefined) continue;
        const br = invertRate(rateTable, f);
        if (!br) onLattice = false;
        else ms[i] = (br.lo + br.hi) / 2;
      }
      if (onLattice) {
        const fb = mean(ms.filter((x) => !Number.isNaN(x)));
        mids = ms.map((x) => (Number.isNaN(x) ? fb : x));
      } else {
        calibrated = false; // off-lattice: fall back to marginal mode
      }
    }
  }

  if (mids && rateTable) {
    mode = 'rateTable';
    const sumMid = (mask: number): number => {
      let s = 0;
      for (const i of maskIndices(mask)) s += mids[i] as number;
      return s;
    };
    const alpha =
      multi.length === 0
        ? 1
        : bestOnGrid(ALPHA_GRID, (a) =>
            multi.reduce((e, [m, q]) => e + (rateFn(rateTable, a * sumMid(m)) - target(q)) ** 2, 0),
          );
    params.alpha = alpha;
    predictIntl = (mask) => rateFn(rateTable, alpha * sumMid(mask));
  } else if (opts.latent && !overheadOnly && knownFees.length > 0 && latentFit()) {
    mode = 'latent';
    const fm = latentFit() as NonNullable<ReturnType<typeof latentFit>>;
    params.F0 = Math.min(...knownFees);
    fmLatent = fm;
    predictIntl = (mask) =>
      mask === 0 ? 0 : fm.pOverweight(mask) >= 0.5 ? Infinity : fm.predictFee(mask);
  } else {
    const F0 = knownFees.length > 0 ? Math.min(...knownFees) : 0;
    const excess = (mask: number): number => {
      let s = 0;
      for (const i of maskIndices(mask)) s += fee(i) - F0;
      return s;
    };
    const beta =
      multi.length === 0
        ? 1
        : bestOnGrid(BETA_GRID, (b) =>
            multi.reduce((e, [m, q]) => e + (F0 + b * excess(m) - target(q)) ** 2, 0),
          );
    params.F0 = F0;
    params.beta = beta;
    predictIntl = (mask) => (mask === 0 ? 0 : F0 + beta * excess(mask));
  }

  const predictO = (mask: number): number => {
    if (mask === 0) return 0;
    const q = lookupQuote(quotes, mask);
    if (q) return q.status === 'ok' ? q.overhead : Infinity;
    if (mask & ineligible) return Infinity;
    let dom = 0;
    if (!overheadOnly)
      for (const s of shopIds) dom += predictDomestic(s, mask & (shopMask.get(s) as number));
    const shippingDiscounts = 0; // not predicted (see header)
    return Math.round(dom + predictIntl(mask) - shippingDiscounts);
  };

  const predictG = (mask: number): Fen => {
    const q = lookupQuote(quotes, mask);
    if (q && q.status === 'ok') return q.goodsNet;
    return goodsOf(mask);
  };

  const sCache = new Map<number, Float64Array>();
  const samplesO = (mask: number): Float64Array => {
    const hit = sCache.get(mask);
    if (hit) return hit;
    const fm = fmLatent as NonNullable<typeof fmLatent>;
    let out: Float64Array;
    const q = lookupQuote(quotes, mask);
    if (q || mask & ineligible) {
      const applied = q ? q.coupons.reduce((a, c) => a + c.amount, 0) : 0;
      out = new Float64Array(fm.samples).fill(
        q && q.status === 'ok' ? q.overhead + applied : Infinity,
      );
    } else {
      let dom = 0;
      for (const s of shopIds) dom += predictDomestic(s, mask & (shopMask.get(s) as number));
      out = fm.feeSamples(mask).slice();
      for (let k = 0; k < out.length; k++) out[k] = (out[k] as number) + dom;
    }
    sCache.set(mask, out);
    return out;
  };

  // --- coupons (latent mode): nominal amount and goods threshold learned from applied coupons ---
  const nominal = new Map<string, number>();
  const minApplied = new Map<string, number>();
  const noCouponGoods: number[] = [];
  for (const [, q] of okQuotes) {
    if (q.coupons.length === 0) noCouponGoods.push(q.goodsNet);
    for (const c of q.coupons) {
      nominal.set(c.id, Math.max(nominal.get(c.id) ?? 0, c.amount));
      minApplied.set(c.id, Math.min(minApplied.get(c.id) ?? Infinity, q.goodsNet));
    }
  }
  const threshold = new Map<string, number>();
  for (const [id, ma] of minApplied) {
    let below = 0;
    for (const g of noCouponGoods) if (g < ma && g > below) below = g;
    threshold.set(id, (below + ma) / 2);
  }
  const couponOptions = (mask: number): { id: string; amount: Fen }[] => {
    const q = lookupQuote(quotes, mask);
    if (q && q.status === 'ok') return q.coupons.map((c) => ({ id: c.id, amount: c.amount }));
    const g = predictG(mask);
    const out: { id: string; amount: Fen }[] = [];
    for (const [id, thr] of threshold)
      if (g >= thr) out.push({ id, amount: nominal.get(id) as number });
    return out;
  };

  return {
    predictO,
    predictG,
    mode,
    calibrated,
    params,
    ...(fmLatent ? { samplesO, couponOptions } : {}),
  };
}
