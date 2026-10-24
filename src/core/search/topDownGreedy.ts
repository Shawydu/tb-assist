// Top-down greedy engine (design §7.7, FR-10.5), objective B only. Pure TS.
//
// Start from S = U; each round probes S\{i} for every i in S (in item order) and moves to the
// best one while it strictly improves R = O/G. The next probe is a deterministic function of the
// observed quotes, so serialize/restore just stores them (same approach as the heuristic engine).
//
// Choices (see CHANGELOG T8):
//  - Candidates whose gross cart value (sum unitPrice * qty, an upper bound of G) is below
//    bMinValue are skipped without probing. Candidates already quoted cost no probe.
//  - R(S) = Infinity when S is infeasible or has G < bMin, so any eligible removal improves.
//  - Ties follow FR-8.2: ratio, larger G, smaller O, then lower mask.
//  - results() reports B from all verified quotes, A from partitions made only of quoted blocks.

import { objectiveA } from '../cost';
import { rankA, rankB } from '../rank';
import { fullMask, lineIdsFromMask, maskFromLineIds, selectionKey } from '../selection';
import type { CartItem, ProbeResult, Quote, SearchParams, Selection } from '../types';
import type { EngineResults, SearchEngine } from './engine';

export interface TopDownGreedyState {
  v: 1;
  kind: 'topDownGreedy';
  /** Item lineIds in the order the masks index into. */
  lineIds: string[];
  kMax: number;
  bMinValue: number;
  rShow: number;
  /** Observed quotes in probe order; cached = served from the quote cache (no budget used). */
  observed: { quote: Quote; cached: boolean }[];
}

export function createTopDownGreedyEngine(
  items: readonly CartItem[],
  params: SearchParams,
  saved?: TopDownGreedyState,
): SearchEngine {
  const U = items.map((i) => i.lineId);
  const n = U.length;
  const full = fullMask(n);
  const bMin = params.bMinValue;
  const gross = items.map((i) => i.unitPrice * i.qty);
  const grossOf = (m: number): number => {
    let s = 0;
    for (let i = 0; i < n; i++) if (m & (1 << i)) s += gross[i] as number;
    return s;
  };

  const quotes = new Map<number, Quote>();
  const observed: { quote: Quote; cached: boolean }[] = [];
  let used = 0;
  let pendingCache: number | null | undefined;
  let resultsCache: EngineResults | undefined;

  const record = (m: number, q: Quote, cached: boolean): void => {
    quotes.set(m, q);
    observed.push({ quote: q, cached });
    if (!cached) used += 1;
    pendingCache = undefined;
    resultsCache = undefined;
  };

  /** Eligible (feasible, G >= bMin, G > 0) quote or undefined. */
  const eligible = (m: number): Quote | undefined => {
    const q = quotes.get(m);
    return q && q.status === 'ok' && q.goodsNet > 0 && q.goodsNet >= bMin ? q : undefined;
  };
  /** a strictly better than b under FR-8.2 (exact cross-multiplication). */
  const better = (a: { m: number; q: Quote }, b: { m: number; q: Quote }): boolean => {
    const c =
      a.q.overhead * b.q.goodsNet - b.q.overhead * a.q.goodsNet ||
      b.q.goodsNet - a.q.goodsNet ||
      a.q.overhead - b.q.overhead ||
      a.m - b.m;
    return c < 0;
  };

  /** Next mask to probe from the quotes alone; null when finished. */
  const compute = (): number | null => {
    if (used >= params.maxProbes) return null;
    if (!quotes.has(full)) return full;
    let S = full;
    for (;;) {
      if ((S & (S - 1)) === 0) return null; // single item left
      const cands: number[] = [];
      for (let i = 0; i < n; i++) {
        if (!(S & (1 << i))) continue;
        const c = S & ~(1 << i);
        if (grossOf(c) < bMin) continue;
        cands.push(c);
      }
      for (const c of cands) if (!quotes.has(c)) return c;
      let best: { m: number; q: Quote } | undefined;
      for (const m of cands) {
        const q = eligible(m);
        if (q && (!best || better({ m, q }, best))) best = { m, q };
      }
      if (!best) return null;
      const sq = eligible(S);
      if (sq && !better(best, { m: S, q: sq })) return null;
      S = best.m;
    }
  };

  const pending = (): number | null => {
    if (pendingCache === undefined) pendingCache = compute();
    return pendingCache;
  };

  const check = (sel: Selection, r: ProbeResult): { m: number; q: Quote; cached: boolean } => {
    if (r.kind !== 'ok' && r.kind !== 'infeasible')
      throw new Error(`cannot observe result of kind ${r.kind}`);
    const m = pending();
    if (m === null) throw new Error('observe called but engine is done');
    let given: number;
    try {
      given = maskFromLineIds(U, sel);
    } catch {
      throw new Error('observed selection is not the pending one');
    }
    if (given !== m) throw new Error('observed selection is not the pending one');
    if (r.quote.status !== r.kind) throw new Error('result kind does not match quote status');
    if (selectionKey(r.quote.lineIds) !== selectionKey(sel))
      throw new Error('quote does not match the observed selection');
    return { m, q: r.quote, cached: r.fromCache };
  };

  if (saved) {
    if (saved.v !== 1 || saved.kind !== 'topDownGreedy')
      throw new Error('unsupported engine state');
    if (saved.lineIds.length !== n || saved.lineIds.some((id, i) => id !== U[i]))
      throw new Error('saved engine state does not match cart items');
    if (
      saved.kMax !== params.kMax ||
      saved.bMinValue !== params.bMinValue ||
      saved.rShow !== params.rShow
    )
      throw new Error('saved engine state does not match search params');
    if (!Array.isArray(saved.observed)) throw new Error('saved engine state has invalid quotes');
    for (const o of saved.observed) {
      const r: ProbeResult = { kind: o.quote.status, quote: o.quote, fromCache: o.cached };
      const { m, q, cached } = check(o.quote.lineIds, r);
      record(m, q, cached);
    }
  }

  /** Partitions of U with <= kMax blocks, all blocks quoted. */
  const quotedPartitions = (): number[][] => {
    const masks = [...quotes.keys()].sort((a, b) => a - b);
    const out: number[][] = [];
    const rec = (rest: number, acc: number[]): void => {
      if (rest === 0) {
        out.push([...acc]);
        return;
      }
      if (acc.length >= params.kMax) return;
      const low = rest & -rest;
      for (const m of masks) if (m & low && (m & rest) === m) rec(rest & ~m, [...acc, m]);
    };
    rec(full, []);
    return out;
  };

  return {
    kind: 'topDownGreedy',
    next(): Selection | null {
      const m = pending();
      return m === null ? null : lineIdsFromMask(U, m);
    },
    observe(sel: Selection, r: ProbeResult): void {
      const { m, q, cached } = check(sel, r);
      record(m, q, cached);
    },
    done(): boolean {
      return pending() === null;
    },
    results(): EngineResults {
      if (!resultsCache) {
        const candA = quotedPartitions().filter((p) => {
          const c = objectiveA(p, quotes);
          return c !== null && Number.isFinite(c.cost);
        });
        resultsCache = {
          exact: false,
          A: rankA(candA, quotes, U, params.rShow),
          B: rankB([...quotes.keys()], quotes, U, bMin, params.rShow),
        };
      }
      return resultsCache;
    },
    serialize(): TopDownGreedyState {
      return {
        v: 1,
        kind: 'topDownGreedy',
        lineIds: [...U],
        kMax: params.kMax,
        bMinValue: params.bMinValue,
        rShow: params.rShow,
        observed: JSON.parse(JSON.stringify(observed)) as TopDownGreedyState['observed'],
      };
    },
  };
}
