// Pricing simulator (design §11.1): hidden-ground-truth oracle implementing ProbeClient.
// Pure TS. Independent of search code: has its own brute force for the true optimum.
import { canonicalSelection, selectionKey } from '../core/selection';
import type { Fen, ProbeClient, ProbeResult, Quote, Selection } from '../core/types';

export interface SimItem {
  lineId: string;
  itemId: string;
  skuId: string | null;
  shopId: string;
  shopName: string;
  title: string;
  unitPrice: Fen;
  qty: number;
  trueWeightKg: number;
  consolidationEligible: boolean;
}

export interface SimShop {
  shopId: string;
  shopName: string;
  /** Domestic freight charged per checkout unless a free rule matches. */
  baseFee: Fen;
  freeAlways?: boolean;
  /** Free when goods net (after 满减) >= this. */
  freeAmount?: Fen;
  /** Free when total quantity >= this. */
  freeCount?: number;
  /** 满减: `off` fen off every `every` fen of gross goods; reduces G, not overhead. */
  discount?: { every: Fen; off: Fen };
}

export interface RateBracket {
  label?: string;
  /** Applies to weights <= maxKg (first matching bracket wins). */
  maxKg: number;
  firstKg: number;
  firstFee: Fen;
  stepKg: number;
  stepFee: Fen;
}

export interface SimConsolidation {
  brackets: readonly RateBracket[];
  /** Selections heavier than this (after packing) are infeasible. */
  weightLimitKg: number;
  /** Multiplier on goods weight for packing material. */
  packingFactor: number;
  /** Fixed packaging weight added per parcel. */
  parcelWeightKg: number;
}

export interface SimCoupon {
  id: string;
  label: string;
  /** Fen off the consolidation fee (capped at the fee). */
  amount: Fen;
  /** Applies when goods net >= this. */
  minGoods: Fen;
}

export interface SimConfig {
  items: readonly SimItem[];
  shops: readonly SimShop[];
  consolidation: SimConsolidation;
  coupons: readonly SimCoupon[];
  /** Deterministic noise in [-amplitude, amplitude] fen on grand total, hashed from (seed, selection). */
  noise?: { seed: number; amplitude?: Fen };
}

export type InjectedFailure = 'blocked' | 'error';
export type InjectHook = (probeIndex: number, sel: Selection) => InjectedFailure | null;

export interface SimOptions {
  clock?: () => number;
  inject?: InjectHook;
}

/** Everything about a subset (by bitmask over config item order) before coupon choice. */
export interface MaskInfo {
  mask: number;
  feasible: boolean;
  reason?: string;
  goodsNet: Fen;
  domesticByShop: Record<string, Fen>;
  domesticTotal: Fen;
  weightKg: number;
  consolidationFee: Fen;
  noise: Fen;
  /** Overhead with no coupon. */
  baseOverhead: Fen;
  /** Coupon saving per coupon (index-aligned with config.coupons); 0 when not applicable. */
  couponSaving: Fen[];
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fee for weight (grams) in a bracket. */
export function bracketFee(b: RateBracket, weightG: number): Fen {
  const firstG = Math.round(b.firstKg * 1000);
  if (weightG <= firstG) return b.firstFee;
  const stepG = Math.round(b.stepKg * 1000);
  return b.firstFee + Math.ceil((weightG - firstG) / stepG) * b.stepFee;
}

export class PricingSimulator implements ProbeClient {
  readonly config: SimConfig;
  /** Item lineIds in config order; bit i of a mask is lineIds[i]. */
  readonly lineIds: readonly string[];
  probeCount = 0;
  inject: InjectHook | undefined;
  private readonly clock: () => number;
  private readonly itemIndex = new Map<string, number>();
  private readonly shopById = new Map<string, SimShop>();
  private readonly cache = new Map<number, MaskInfo>();

  constructor(config: SimConfig, opts: SimOptions = {}) {
    this.config = config;
    this.clock = opts.clock ?? (() => 0);
    this.inject = opts.inject;
    this.lineIds = config.items.map((i) => i.lineId);
    config.items.forEach((it, i) => {
      if (this.itemIndex.has(it.lineId)) throw new Error(`duplicate lineId ${it.lineId}`);
      this.itemIndex.set(it.lineId, i);
      if (!config.shops.some((s) => s.shopId === it.shopId))
        throw new Error(`item ${it.lineId} references unknown shop ${it.shopId}`);
    });
    for (const s of config.shops) this.shopById.set(s.shopId, s);
    if (config.items.length > 20) throw new Error('simulator supports n <= 20');
  }

  get n(): number {
    return this.config.items.length;
  }

  maskOf(sel: readonly string[]): number | null {
    let mask = 0;
    for (const id of sel) {
      const i = this.itemIndex.get(id);
      if (i === undefined) return null;
      mask |= 1 << i;
    }
    return mask;
  }

  lineIdsOf(mask: number): Selection {
    const out: string[] = [];
    for (let i = 0; i < this.n; i++) if (mask & (1 << i)) out.push(this.lineIds[i] as string);
    return canonicalSelection(out);
  }

  /** Ground truth for a subset, memoized. Does not touch probeCount. */
  info(mask: number): MaskInfo {
    const hit = this.cache.get(mask);
    if (hit) return hit;
    const info = this.compute(mask);
    this.cache.set(mask, info);
    return info;
  }

  /** True overhead of a selection (no probeCount increment); null for infeasible/unknown. */
  trueOverhead(sel: readonly string[]): Fen | null {
    const mask = this.maskOf(sel);
    if (mask === null || mask === 0) return null;
    const info = this.info(mask);
    if (!info.feasible) return null;
    return info.baseOverhead - Math.max(0, ...info.couponSaving);
  }

  private compute(mask: number): MaskInfo {
    const { items, consolidation: cons, coupons } = this.config;
    const grossByShop = new Map<string, Fen>();
    const countByShop = new Map<string, number>();
    let weightG = 0;
    let reason: string | undefined;
    for (let i = 0; i < items.length; i++) {
      if (!(mask & (1 << i))) continue;
      const it = items[i] as SimItem;
      grossByShop.set(it.shopId, (grossByShop.get(it.shopId) ?? 0) + it.unitPrice * it.qty);
      countByShop.set(it.shopId, (countByShop.get(it.shopId) ?? 0) + it.qty);
      weightG += Math.round(it.trueWeightKg * 1000) * it.qty;
      if (!it.consolidationEligible && !reason)
        reason = `item ${it.lineId} is not eligible for consolidation`;
    }
    let goodsNet = 0;
    let domesticTotal = 0;
    const domesticByShop: Record<string, Fen> = {};
    for (const [shopId, gross] of grossByShop) {
      const shop = this.shopById.get(shopId) as SimShop;
      const disc = shop.discount ? Math.floor(gross / shop.discount.every) * shop.discount.off : 0;
      const net = gross - disc;
      const count = countByShop.get(shopId) as number;
      const free =
        shop.freeAlways === true ||
        (shop.freeAmount !== undefined && net >= shop.freeAmount) ||
        (shop.freeCount !== undefined && count >= shop.freeCount);
      const dom = free ? 0 : shop.baseFee;
      goodsNet += net;
      domesticTotal += dom;
      domesticByShop[shopId] = dom;
    }
    const packedG =
      Math.round(weightG * cons.packingFactor) + Math.round(cons.parcelWeightKg * 1000);
    const weightKg = packedG / 1000;
    let consolidationFee = 0;
    if (!reason && packedG > Math.round(cons.weightLimitKg * 1000))
      reason = `parcel weight ${weightKg.toFixed(2)} kg exceeds limit ${cons.weightLimitKg} kg`;
    if (!reason) {
      const bracket = cons.brackets.find((b) => packedG <= Math.round(b.maxKg * 1000));
      if (!bracket) reason = `no rate bracket covers ${weightKg.toFixed(2)} kg`;
      else consolidationFee = bracketFee(bracket, packedG);
    }
    let noise = 0;
    if (this.config.noise) {
      const amp = this.config.noise.amplitude ?? 100;
      const key = selectionKey(this.lineIdsOf(mask));
      noise = (fnv1a(`${this.config.noise.seed}|${key}`) % (2 * amp + 1)) - amp;
    }
    return {
      mask,
      feasible: reason === undefined,
      ...(reason !== undefined ? { reason } : {}),
      goodsNet,
      domesticByShop,
      domesticTotal,
      weightKg,
      consolidationFee,
      noise,
      baseOverhead: domesticTotal + consolidationFee + noise,
      couponSaving: coupons.map((c) =>
        reason === undefined && goodsNet >= c.minGoods ? Math.min(c.amount, consolidationFee) : 0,
      ),
    };
  }

  private buildQuote(info: MaskInfo, sel: Selection): Quote {
    const coupons = this.config.coupons;
    let bestIdx = -1;
    info.couponSaving.forEach((s, i) => {
      if (s > 0 && (bestIdx < 0 || s > (info.couponSaving[bestIdx] as number))) bestIdx = i;
    });
    const applied =
      bestIdx >= 0
        ? [
            {
              id: (coupons[bestIdx] as SimCoupon).id,
              label: (coupons[bestIdx] as SimCoupon).label,
              amount: info.couponSaving[bestIdx] as Fen,
            },
          ]
        : [];
    const discount = applied[0]?.amount ?? 0;
    const overhead = info.baseOverhead - discount;
    return {
      key: selectionKey(sel),
      lineIds: sel,
      status: info.feasible ? 'ok' : 'infeasible',
      ...(info.reason !== undefined ? { infeasibleReason: info.reason } : {}),
      goodsNet: info.goodsNet,
      grandTotal: info.goodsNet + overhead,
      overhead,
      domesticByShop: { ...info.domesticByShop },
      consolidationFee: info.consolidationFee,
      shippingDiscounts: 0,
      otherFees: info.noise,
      tax: 0,
      coupons: applied,
      breakdownConsistent: true,
      capturedAt: this.clock(),
      addressId: 'sim-address',
    };
  }

  async probe(sel: Selection): Promise<ProbeResult> {
    const index = this.probeCount++;
    const canon = canonicalSelection(sel);
    const failure = this.inject?.(index, canon);
    if (failure === 'blocked') return { kind: 'blocked', reason: 'captcha' };
    if (failure === 'error') return { kind: 'error', reason: 'injected error' };
    if (canon.length === 0) return { kind: 'error', reason: 'empty selection' };
    const mask = this.maskOf(canon);
    if (mask === null) return { kind: 'error', reason: 'unknown lineId in selection' };
    const info = this.info(mask);
    const quote = this.buildQuote(info, canon);
    return info.feasible
      ? { kind: 'ok', quote, fromCache: false }
      : { kind: 'infeasible', quote, fromCache: false };
  }
}

// ---------------------------------------------------------------------------
// Ground truth (brute force, n <= ~12)

export interface TruePartition {
  masks: number[];
  groups: Selection[];
  /** Σ overhead, with single-use coupons optimally assigned. */
  cost: Fen;
  /** Σ grand total (ΣG + cost). */
  totalT: Fen;
  /** Coupon id used by each group (null = none). */
  couponByGroup: (string | null)[];
}

export interface TrueOptimumA {
  /** Best partition after FR-7.3 tie-break (fewer groups, lower ΣT); null if nothing feasible. */
  optimum: TruePartition | null;
  /** All partitions tied on (cost, k, ΣT). */
  ties: TruePartition[];
  /** Cost of {U}, null if U infeasible. */
  baselineCost: Fen | null;
}

/** Best coupon assignment for groups: each coupon to at most one group, each group uses at most one. */
function assignCoupons(
  sim: PricingSimulator,
  infos: MaskInfo[],
): { saving: Fen; byGroup: (number | null)[] } {
  const m = sim.config.coupons.length;
  const k = infos.length;
  let best = 0;
  let bestBy: (number | null)[] = infos.map(() => null);
  if (m === 0) return { saving: 0, byGroup: bestBy };
  const assign: number[] = new Array<number>(m).fill(-1);
  const rec = (j: number): void => {
    if (j === m) {
      const used: (number | null)[] = infos.map(() => null);
      let total = 0;
      for (let g = 0; g < k; g++) {
        let bg = 0;
        for (let c = 0; c < m; c++) {
          if (assign[c] !== g) continue;
          const s = (infos[g] as MaskInfo).couponSaving[c] as number;
          if (s > bg) {
            bg = s;
            used[g] = c;
          }
        }
        total += bg;
      }
      if (total > best) {
        best = total;
        bestBy = used;
      }
      return;
    }
    for (let g = -1; g < k; g++) {
      assign[j] = g;
      rec(j + 1);
    }
  };
  rec(0);
  return { saving: best, byGroup: bestBy };
}

export function trueOptimumA(sim: PricingSimulator, kMax: number): TrueOptimumA {
  const n = sim.n;
  const full = 2 ** n - 1;
  const U = sim.info(full);
  const baselineCost = U.feasible ? U.baseOverhead - Math.max(0, ...U.couponSaving) : null;
  let best: TruePartition[] = [];
  const groups: number[] = [];

  const better = (a: TruePartition, b: TruePartition): number =>
    a.cost - b.cost || a.masks.length - b.masks.length || a.totalT - b.totalT;

  const leaf = (): void => {
    const infos = groups.map((mk) => sim.info(mk));
    const { saving, byGroup } = assignCoupons(sim, infos);
    let base = 0;
    let goods = 0;
    for (const inf of infos) {
      base += inf.baseOverhead;
      goods += inf.goodsNet;
    }
    const cost = base - saving;
    const p: TruePartition = {
      masks: [...groups],
      groups: groups.map((mk) => sim.lineIdsOf(mk)),
      cost,
      totalT: goods + cost,
      couponByGroup: byGroup.map((c) =>
        c === null ? null : (sim.config.coupons[c] as SimCoupon).id,
      ),
    };
    const first = best[0];
    if (!first) best = [p];
    else {
      const d = better(p, first);
      if (d < 0) best = [p];
      else if (d === 0) best.push(p);
    }
  };

  // Restricted-growth enumeration. Feasibility is monotone under set inclusion
  // (weight, eligibility), so infeasible groups prune the branch.
  const rec = (i: number): void => {
    if (i === n) {
      leaf();
      return;
    }
    const bit = 1 << i;
    for (let g = 0; g < groups.length; g++) {
      const prev = groups[g] as number;
      const merged = prev | bit;
      if (!sim.info(merged).feasible) continue;
      groups[g] = merged;
      rec(i + 1);
      groups[g] = prev;
    }
    if (groups.length < kMax && sim.info(bit).feasible) {
      groups.push(bit);
      rec(i + 1);
      groups.pop();
    }
  };
  if (n > 0) rec(0);
  return { optimum: best[0] ?? null, ties: best, baselineCost };
}

export interface TrueSubsetB {
  mask: number;
  lineIds: Selection;
  goodsNet: Fen;
  overhead: Fen;
  ratio: number;
}

export interface TrueOptimumB {
  optimum: TrueSubsetB | null;
  ties: TrueSubsetB[];
  /** Ratio of U (null if infeasible or below bMin). */
  baselineRatio: number | null;
}

export function trueOptimumB(sim: PricingSimulator, bMin: Fen): TrueOptimumB {
  const full = 2 ** sim.n - 1;
  let best: TrueSubsetB[] = [];
  // compare O1/G1 vs O2/G2 exactly via cross-multiplication (all integers)
  const cmp = (a: TrueSubsetB, b: TrueSubsetB): number =>
    a.overhead * b.goodsNet - b.overhead * a.goodsNet ||
    b.goodsNet - a.goodsNet ||
    a.overhead - b.overhead;
  for (let mask = 1; mask <= full; mask++) {
    const info = sim.info(mask);
    if (!info.feasible || info.goodsNet < bMin || info.goodsNet <= 0) continue;
    const overhead = info.baseOverhead - Math.max(0, ...info.couponSaving);
    const cand: TrueSubsetB = {
      mask,
      lineIds: sim.lineIdsOf(mask),
      goodsNet: info.goodsNet,
      overhead,
      ratio: overhead / info.goodsNet,
    };
    const first = best[0];
    if (!first) best = [cand];
    else {
      const d = cmp(cand, first);
      if (d < 0) best = [cand];
      else if (d === 0) best.push(cand);
    }
  }
  const u = sim.info(full);
  const baselineRatio =
    u.feasible && u.goodsNet >= bMin && u.goodsNet > 0
      ? (u.baseOverhead - Math.max(0, ...u.couponSaving)) / u.goodsNet
      : null;
  return { optimum: best[0] ?? null, ties: best, baselineRatio };
}
