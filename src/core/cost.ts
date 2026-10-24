// Cost functions (design §7.5). Pure TS; money is integer fen.

import type { Fen, Quote } from './types';

export type QuoteLookup = ReadonlyMap<number, Quote> | ((mask: number) => Quote | undefined);

export function lookupQuote(lookup: QuoteLookup, mask: number): Quote | undefined {
  return typeof lookup === 'function' ? lookup(mask) : lookup.get(mask);
}

/** O(S); Infinity when infeasible. */
export function overhead(q: Quote): Fen {
  return q.status === 'ok' ? q.overhead : Infinity;
}

export interface CouponAdjustment {
  couponId: string;
  /** Index (in the partition's block order) of the group the coupon is taken from. */
  fromGroup: number;
  amount: Fen;
}

export interface CostA {
  cost: Fen; // may be Infinity
  couponAdjusted: boolean;
  adjustments: CouponAdjustment[];
}

/**
 * FR-9.2 coupon adjustment. For each coupon id used by >= 2 groups, keep it on the
 * group with the largest amount (ties: lowest group index) and add the amount back
 * to the cost of every other group.
 *
 * This is conservative: the true optimum might assign coupons differently (e.g. a
 * group could have used a different coupon instead). The simulator's trueOptimumA
 * brute-forces the assignment, so its cost is <= this one. That matches the spec.
 *
 * `groupCoupons[j]` lists the coupons of group j's quote.
 */
export function couponAdjust(groupCoupons: readonly Quote['coupons'][]): {
  addBack: Fen;
  adjustments: CouponAdjustment[];
} {
  // coupon id -> per-group amount (max if a quote lists the same id twice)
  const byId = new Map<string, Map<number, Fen>>();
  groupCoupons.forEach((cs, j) => {
    for (const c of cs) {
      let m = byId.get(c.id);
      if (!m) byId.set(c.id, (m = new Map()));
      m.set(j, Math.max(m.get(j) ?? 0, c.amount));
    }
  });
  const adjustments: CouponAdjustment[] = [];
  let addBack = 0;
  for (const [couponId, groups] of byId) {
    if (groups.size < 2) continue;
    const js = [...groups.keys()].sort((a, b) => a - b);
    let keeper = js[0] as number;
    for (const j of js) if ((groups.get(j) as number) > (groups.get(keeper) as number)) keeper = j;
    for (const j of js) {
      if (j === keeper) continue;
      const amount = groups.get(j) as number;
      addBack += amount;
      adjustments.push({ couponId, fromGroup: j, amount });
    }
  }
  return { addBack, adjustments };
}

/** Objective A cost of a partition; null if any group has no quote. */
export function objectiveA(partition: readonly number[], lookup: QuoteLookup): CostA | null {
  const quotes: Quote[] = [];
  for (const mask of partition) {
    const q = lookupQuote(lookup, mask);
    if (!q) return null;
    quotes.push(q);
  }
  if (quotes.some((q) => q.status !== 'ok')) {
    return { cost: Infinity, couponAdjusted: false, adjustments: [] };
  }
  const { addBack, adjustments } = couponAdjust(quotes.map((q) => q.coupons));
  const base = quotes.reduce((s, q) => s + q.overhead, 0);
  return { cost: base + addBack, couponAdjusted: adjustments.length > 0, adjustments };
}

/** Objective B ratio O/G; null if unquoted, infeasible, G <= 0 or G < bMin. */
export function objectiveB(mask: number, lookup: QuoteLookup, bMin: Fen): number | null {
  const q = lookupQuote(lookup, mask);
  if (!q || q.status !== 'ok') return null;
  if (q.goodsNet <= 0 || q.goodsNet < bMin) return null;
  return q.overhead / q.goodsNet;
}
