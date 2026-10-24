// Ranking (design §8, FR-7.3, FR-8.2). Pure TS.

import { objectiveA, lookupQuote } from './cost';
import type { QuoteLookup } from './cost';
import { lineIdsFromMask } from './selection';
import type { ResultA, ResultB, Fen } from './types';

const keyOf = (masks: readonly number[]): string => [...masks].sort((a, b) => a - b).join(',');

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Compare a,b where either may be Infinity (never both here; infeasible are filtered). */
interface RowA {
  masks: number[];
  cost: Fen;
  sumT: Fen;
  key: string;
  res: ResultA;
}

/**
 * Rank partitions for objective A. Unquoted or infeasible partitions are dropped
 * (only verified results are shown). Order: cost, group count, ΣT, canonical key.
 * Identical partitions are deduped. Returns at most rShow results.
 */
export function rankA(
  candidates: readonly (readonly number[])[],
  lookup: QuoteLookup,
  U: readonly string[],
  rShow: number,
): ResultA[] {
  const full = 2 ** U.length - 1;
  const base = objectiveA([full], lookup);
  const baseline = base && Number.isFinite(base.cost) ? base.cost : null;
  const seen = new Set<string>();
  const rows: RowA[] = [];
  for (const cand of candidates) {
    const key = keyOf(cand);
    if (seen.has(key)) continue;
    seen.add(key);
    const c = objectiveA(cand, lookup);
    if (!c || !Number.isFinite(c.cost)) continue;
    const masks = [...cand].sort((a, b) => (a & -a) - (b & -b));
    let sumT = 0;
    const groups = masks.map((m) => {
      const quote = lookupQuote(lookup, m)!;
      sumT += quote.grandTotal;
      return { lineIds: lineIdsFromMask(U, m), quote };
    });
    rows.push({
      masks,
      cost: c.cost,
      sumT,
      key,
      res: {
        groups,
        cost: c.cost,
        couponAdjusted: c.couponAdjusted,
        savingsVsBaseline: baseline === null ? null : baseline - c.cost,
      },
    });
  }
  rows.sort(
    (a, b) =>
      a.cost - b.cost || a.masks.length - b.masks.length || a.sumT - b.sumT || cmpStr(a.key, b.key),
  );
  return rows.slice(0, Math.max(0, rShow)).map((r) => r.res);
}

/**
 * Rank subsets for objective B. Order: ratio (exact, cross-multiplied integers),
 * larger G, smaller O, canonical mask. Ineligible (unquoted, infeasible, G < bMin) dropped.
 */
export function rankB(
  candidates: readonly number[],
  lookup: QuoteLookup,
  U: readonly string[],
  bMin: Fen,
  rShow: number,
): ResultB[] {
  const full = 2 ** U.length - 1;
  const bq = lookupQuote(lookup, full);
  const baseRatio =
    bq && bq.status === 'ok' && bq.goodsNet > 0 && bq.goodsNet >= bMin
      ? bq.overhead / bq.goodsNet
      : null;
  const rows: { mask: number; res: ResultB }[] = [];
  const seen = new Set<number>();
  for (const mask of candidates) {
    if (seen.has(mask)) continue;
    seen.add(mask);
    const q = lookupQuote(lookup, mask);
    if (!q || q.status !== 'ok' || q.goodsNet <= 0 || q.goodsNet < bMin) continue;
    const ratio = q.overhead / q.goodsNet;
    rows.push({
      mask,
      res: {
        lineIds: lineIdsFromMask(U, mask),
        quote: q,
        ratio,
        savingsNote:
          baseRatio === null
            ? 'Baseline unavailable'
            : `Baseline ratio ${baseRatio.toFixed(2)} → ${ratio.toFixed(2)}`,
      },
    });
  }
  rows.sort((a, b) => {
    const qa = a.res.quote;
    const qb = b.res.quote;
    return (
      qa.overhead * qb.goodsNet - qb.overhead * qa.goodsNet ||
      qb.goodsNet - qa.goodsNet ||
      qa.overhead - qb.overhead ||
      a.mask - b.mask
    );
  });
  return rows.slice(0, Math.max(0, rShow)).map((r) => r.res);
}
