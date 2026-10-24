// Exhaustive engine (design §7.1, FR-10.1). Pure TS.

import { objectiveA } from '../cost';
import { partitions } from '../partitions';
import { rankA, rankB } from '../rank';
import { fullMask, lineIdsFromMask, maskFromLineIds, popcount, selectionKey } from '../selection';
import type { CartItem, ProbeResult, Quote, SearchParams, Selection } from '../types';
import type { EngineResults, SearchEngine } from './engine';

export interface ExhaustiveState {
  v: 1;
  kind: 'exhaustive';
  /** Item lineIds in the order the masks index into. */
  lineIds: string[];
  nExh: number;
  kMax: number;
  bMinValue: number;
  rShow: number;
  /** Observed quotes in probe order; entry i is for probeOrder(n)[i]. */
  quotes: Quote[];
}

/** Full set first, then singletons, then the rest by popcount ascending (tie: mask ascending). */
export function probeOrder(n: number): number[] {
  const full = fullMask(n);
  const rest: number[] = [];
  for (let m = 1; m < full; m++) if (popcount(m) >= 2) rest.push(m);
  rest.sort((a, b) => popcount(a) - popcount(b) || a - b);
  const singles: number[] = [];
  for (let i = 0; i < n; i++) if (n > 1) singles.push(1 << i);
  return [full, ...singles, ...rest];
}

export function createExhaustiveEngine(
  items: readonly CartItem[],
  params: SearchParams,
  saved?: ExhaustiveState,
): SearchEngine {
  const U = items.map((i) => i.lineId);
  const n = U.length;
  const order = probeOrder(n);
  const quotes = new Map<number, Quote>();
  const observed: Quote[] = [];

  const observeQuote = (mask: number, q: Quote): void => {
    quotes.set(mask, q);
    observed.push(q);
  };

  if (saved) {
    if (saved.v !== 1 || saved.kind !== 'exhaustive') throw new Error('unsupported engine state');
    if (saved.lineIds.length !== n || saved.lineIds.some((id, i) => id !== U[i]))
      throw new Error('saved engine state does not match cart items');
    if (
      saved.nExh !== params.nExh ||
      saved.kMax !== params.kMax ||
      saved.bMinValue !== params.bMinValue ||
      saved.rShow !== params.rShow
    )
      throw new Error('saved engine state does not match search params');
    if (!Array.isArray(saved.quotes) || saved.quotes.length > order.length)
      throw new Error('saved engine state has invalid quotes');
    saved.quotes.forEach((q, i) => {
      const mask = order[i] as number;
      if (selectionKey(q.lineIds) !== selectionKey(lineIdsFromMask(U, mask)))
        throw new Error(`saved quote ${i} does not match expected selection`);
      observeQuote(mask, q);
    });
  }

  const pendingMask = (): number | null => order[observed.length] ?? null;

  return {
    kind: 'exhaustive',
    next(): Selection | null {
      const m = pendingMask();
      return m === null ? null : lineIdsFromMask(U, m);
    },
    observe(sel: Selection, r: ProbeResult): void {
      if (r.kind !== 'ok' && r.kind !== 'infeasible')
        throw new Error(`cannot observe result of kind ${r.kind}`);
      const m = pendingMask();
      if (m === null) throw new Error('observe called but engine is done');
      let given: number;
      try {
        given = maskFromLineIds(U, sel);
      } catch {
        throw new Error('observed selection is not the pending one');
      }
      if (given !== m) throw new Error('observed selection is not the pending one');
      if (r.quote.status !== r.kind) throw new Error('result kind does not match quote status');
      observeQuote(m, r.quote);
    },
    done(): boolean {
      return pendingMask() === null;
    },
    results(): EngineResults {
      const candA: number[][] = [];
      for (const p of partitions(n, params.kMax)) {
        const c = objectiveA(p, quotes);
        if (c && Number.isFinite(c.cost)) candA.push(p);
      }
      return {
        exact: quotes.size === order.length,
        A: rankA(candA, quotes, U, params.rShow),
        B: rankB([...quotes.keys()], quotes, U, params.bMinValue, params.rShow),
      };
    },
    serialize(): ExhaustiveState {
      return {
        v: 1,
        kind: 'exhaustive',
        lineIds: [...U],
        nExh: params.nExh,
        kMax: params.kMax,
        bMinValue: params.bMinValue,
        rShow: params.rShow,
        quotes: JSON.parse(JSON.stringify(observed)) as Quote[],
      };
    },
  };
}
