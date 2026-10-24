// Heuristic engine (design §7.2, §7.4), used when n > N_EXH. Pure TS.
//
// The engine is a deterministic function of (items, params, seed, observed quotes in order):
// next() is derived from the quotes alone (the local-search RNG is re-seeded from the seed and
// the number of observed quotes), so serialize/restore just stores the quotes.
//
// Deviations / choices (see CHANGELOG T7):
//  - After the singletons, if some items are ineligible the reduced set E is probed as a
//    baseline for the in-scope partitions (before the shop groups).
//  - Any mask that is a superset of an observed-infeasible mask is treated as infeasible by the
//    search (feasibility is monotone: eligibility, weight limit). The prediction model itself is
//    unchanged.
//  - Verified A results are found by exact enumeration of partitions of E whose blocks are all
//    quoted (feasible), not by the candidate pool, so results() never depends on the heuristic.

import { objectiveA } from '../cost';
import { rankA, rankB } from '../rank';
import { createRng } from '../rng';
import { lineIdsFromMask, maskFromLineIds, selectionKey } from '../selection';
import type { CartItem, ProbeResult, Quote, SearchParams, Selection } from '../types';
import type { EngineResults, SearchEngine } from './engine';
import { EXH_CAND_MAX_N, exhaustiveA, exhaustiveB } from './exhaustiveCands';
import { candidatesA, candidatesB } from './localSearch';
import type { SearchCtx } from './localSearch';
import { SAMPLES } from './feeModel';
import { buildModel } from './model';

export interface HeuristicState {
  v: 1;
  kind: 'heuristic';
  /** Item lineIds in the order the masks index into. */
  lineIds: string[];
  objective: SearchParams['objective'];
  kMax: number;
  bMinValue: number;
  rShow: number;
  seed: number;
  /** Observed quotes in probe order; cached = served from the quote cache (no budget used). */
  observed: { quote: Quote; cached: boolean }[];
}

const LOCAL_TOP_N = 50;
const EXH_TOP_N = 300;
// A partitions grow as Bell-like numbers; larger n falls back to local search
const EXH_CAND_MAX_N_A = 10;
/** Finite stand-in for a model-predicted infeasible block when nothing else can be ranked. */
const SOFT_PENALTY = 1e8;
const ENUM_NODE_CAP = 200_000;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const low = (x: number): number => x & -x;
const popcount = (x: number): number => {
  let c = 0;
  for (let m = x; m; m &= m - 1) c++;
  return c;
};

/** All partitions of `target` into <= kMax blocks drawn from `blocks` (quoted, feasible masks). */
function quotedPartitions(target: number, blocks: readonly number[], kMax: number): number[][] {
  const byLow = new Map<number, number[]>();
  for (const b of blocks) {
    if ((b & ~target) !== 0) continue;
    const l = low(b);
    const arr = byLow.get(l);
    if (arr) arr.push(b);
    else byLow.set(l, [b]);
  }
  const out: number[][] = [];
  const cur: number[] = [];
  let nodes = 0;
  const rec = (covered: number): void => {
    if (nodes++ > ENUM_NODE_CAP) return;
    if (covered === target) {
      out.push(cur.slice());
      return;
    }
    if (cur.length >= kMax) return;
    const l = low(target & ~covered);
    for (const b of byLow.get(l) ?? []) {
      if (b & covered) continue;
      cur.push(b);
      rec(covered | b);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

export function createHeuristicEngine(
  items: readonly CartItem[],
  params: SearchParams,
  saved?: HeuristicState,
): SearchEngine {
  const U = items.map((i) => i.lineId);
  const n = U.length;
  const full = 2 ** n - 1;
  const seed = saved?.seed ?? params.seed ?? fnv1a(U.join('\u0000'));
  const quotes = new Map<number, Quote>();
  const observed: { quote: Quote; cached: boolean }[] = [];
  let used = 0;

  const shopMaskAll: number[] = [];
  {
    const byShop = new Map<string, number>();
    items.forEach((it, i) => byShop.set(it.shopId, (byShop.get(it.shopId) ?? 0) | (1 << i)));
    shopMaskAll.push(...byShop.values());
  }

  let resultsCache: EngineResults | null = null;
  let rowsCache: { A: ReturnType<typeof rankA>; B: ReturnType<typeof rankB> } | null = null;
  let pendingCache: number | null | undefined;

  const record = (mask: number, q: Quote, cached: boolean): void => {
    quotes.set(mask, q);
    observed.push({ quote: q, cached });
    if (!cached) used++;
    resultsCache = null;
    rowsCache = null;
    pendingCache = undefined;
  };

  if (saved) {
    if (saved.v !== 1 || saved.kind !== 'heuristic') throw new Error('unsupported engine state');
    if (saved.lineIds.length !== n || saved.lineIds.some((id, i) => id !== U[i]))
      throw new Error('saved engine state does not match cart items');
    if (
      saved.objective !== params.objective ||
      saved.kMax !== params.kMax ||
      saved.bMinValue !== params.bMinValue ||
      saved.rShow !== params.rShow
    )
      throw new Error('saved engine state does not match search params');
    if (!Array.isArray(saved.observed)) throw new Error('saved engine state has invalid quotes');
    for (const [i, o] of saved.observed.entries()) {
      let mask: number;
      try {
        mask = maskFromLineIds(U, o.quote.lineIds);
      } catch {
        throw new Error(`saved quote ${i} refers to unknown items`);
      }
      if (mask === 0 || quotes.has(mask))
        throw new Error(`saved quote ${i} is empty or duplicates an earlier one`);
      record(mask, o.quote, o.cached);
    }
  }

  // ---- derived knowledge ----
  const infeasibleMasks = (): number[] => {
    const out: number[] = [];
    for (const [m, q] of quotes) if (q.status !== 'ok') out.push(m);
    return out;
  };
  const eligibleMask = (): number => {
    let e = full;
    for (let i = 0; i < n; i++) {
      const q = quotes.get(1 << i);
      if (q && q.status !== 'ok') e &= ~(1 << i);
    }
    return e;
  };

  const computeRows = (): { A: ReturnType<typeof rankA>; B: ReturnType<typeof rankB> } => {
    if (rowsCache) return rowsCache;
    const rShow = Math.max(1, params.rShow);
    const E = eligibleMask();
    const okMasks = [...quotes].filter(([, q]) => q.status === 'ok').map(([m]) => m);
    const parts = E === 0 ? [] : quotedPartitions(E, okMasks, params.kMax);
    const finite = parts.filter((p) => {
      const c = objectiveA(p, quotes);
      return c !== null && Number.isFinite(c.cost);
    });
    rowsCache = {
      A: rankA(finite, quotes, U, rShow),
      B: rankB(okMasks, quotes, U, params.bMinValue, rShow),
    };
    return rowsCache;
  };

  const ineligibleIds = (): string[] => {
    const e = eligibleMask();
    return U.filter((_, i) => (e & (1 << i)) === 0);
  };

  // ---- next selection ----
  const phaseNext = (): number | null | undefined => {
    if (!quotes.has(full)) return full;
    for (let i = 0; i < n; i++) if (!quotes.has(1 << i)) return 1 << i;
    const E = eligibleMask();
    if (E === 0) return null;
    if (E !== full && !quotes.has(E)) return E;
    for (const sm of shopMaskAll) {
      const m = sm & E;
      if (popcount(m) >= 2 && !quotes.has(m)) return m;
    }
    return undefined; // phases finished
  };

  const verifyNext = (): number | null => {
    const E = eligibleMask();
    const model = buildModel(items, quotes, params.rateTable, {
      latent: true,
      seed: (seed ^ Math.imul(observed.length + 1, 0x85ebca6b)) >>> 0,
    });
    const bad = infeasibleMasks();
    const infeasible = (m: number): boolean => bad.some((b) => (m & b) === b);
    const predictO = (m: number): number => (infeasible(m) ? Infinity : model.predictO(m));
    const rows = computeRows();
    const infSamples = new Map<number, Float64Array>();
    const samplesO = (m: number): Float64Array => {
      if (!infeasible(m)) return (model.samplesO as (m: number) => Float64Array)(m);
      let a = infSamples.get(m);
      if (!a) infSamples.set(m, (a = new Float64Array(SAMPLES).fill(Infinity)));
      return a;
    };
    const sdOf = (m: number): number => {
      if (!model.samplesO) return 0;
      const a = samplesO(m);
      let mu = 0;
      for (const v of a) mu += v;
      mu /= a.length;
      let v2 = 0;
      for (const v of a) v2 += (v - mu) ** 2;
      return Math.sqrt(v2 / a.length);
    };
    const ctx: SearchCtx = {
      eligible: E,
      shopMasks: shopMaskAll.map((m) => m & E).filter((m) => m !== 0),
      predictO,
      predictG: model.predictG,
      ...(model.samplesO ? { samplesO } : {}),
      ...(model.couponOptions ? { couponOptions: model.couponOptions } : {}),
      best:
        params.objective === 'A' ? (rows.A[0]?.cost ?? Infinity) : (rows.B[0]?.ratio ?? Infinity),
      kMax: params.kMax,
      bMin: params.bMinValue,
      rng: createRng((seed ^ Math.imul(observed.length + 1, 0x9e3779b1)) >>> 0),
      topN: LOCAL_TOP_N,
    };
    const exh = popcount(E) <= EXH_CAND_MAX_N;
    const exhA = popcount(E) <= EXH_CAND_MAX_N_A;

    if (params.objective === 'A') {
      const extra = rows.A.slice(0, 3).map((r) =>
        r.groups.map((g) => maskFromLineIds(U, g.lineIds)),
      );
      const pickFrom = (cands: { masks: number[] }[]): number | null => {
        for (const c of cands) {
          const unprobed = c.masks.filter((m) => !quotes.has(m));
          if (unprobed.length === 0) continue;
          let pick = unprobed[0] as number;
          let pickO = model.samplesO ? sdOf(pick) : predictO(pick);
          for (const m of unprobed) {
            const o = model.samplesO ? sdOf(m) : predictO(m);
            if (o > pickO || (o === pickO && m < pick)) {
              pick = m;
              pickO = o;
            }
          }
          return pick;
        }
        return null;
      };
      const first = pickFrom(exhA ? exhaustiveA(ctx, EXH_TOP_N) : candidatesA(ctx, extra));
      if (first !== null || !exh) return first;
      // local search ran dry (all candidates probed or infeasible): widen to the full enumeration
      if (!exhA) {
        const wide = pickFrom(exhaustiveA(ctx, EXH_TOP_N));
        if (wide !== null) return wide;
      }
      // every partition looks infeasible to the model (e.g. a spurious over-weight estimate):
      // keep probing, ranking by a soft penalty so verification can still make progress
      if (!model.samplesO) return null;
      const soft = new Map<number, Float64Array>();
      const softSamples = (m: number): Float64Array => {
        let a = soft.get(m);
        if (!a) {
          a = Float64Array.from(samplesO(m));
          if (!infeasible(m))
            for (let k = 0; k < a.length; k++) if (a[k] === Infinity) a[k] = SOFT_PENALTY;
          soft.set(m, a);
        }
        return a;
      };
      return pickFrom(exhaustiveA({ ...ctx, samplesO: softSamples, best: Infinity }, EXH_TOP_N));
    }

    const cands = exh
      ? exhaustiveB(ctx, EXH_TOP_N)
      : candidatesB(
          ctx,
          rows.B.slice(0, 3).map((r) => maskFromLineIds(U, r.lineIds)),
        );
    for (const c of cands) {
      if (quotes.has(c.mask)) continue;
      return c.mask;
    }
    return null;
  };

  const pending = (): number | null => {
    if (pendingCache !== undefined) return pendingCache;
    let p: number | null;
    if (used >= params.maxProbes) p = null;
    else {
      const ph = phaseNext();
      p = ph === undefined ? verifyNext() : ph;
    }
    pendingCache = p;
    return p;
  };

  return {
    kind: 'heuristic',
    next(): Selection | null {
      const m = pending();
      return m === null ? null : lineIdsFromMask(U, m);
    },
    observe(sel: Selection, r: ProbeResult): void {
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
      record(m, r.quote, r.fromCache);
    },
    done(): boolean {
      return pending() === null;
    },
    results(): EngineResults {
      if (resultsCache) return resultsCache;
      const rows = computeRows();
      resultsCache = {
        exact: false,
        A: rows.A.slice(0, params.rShow),
        B: rows.B.slice(0, params.rShow),
        ineligible: ineligibleIds(),
      };
      return resultsCache;
    },
    serialize(): HeuristicState {
      return {
        v: 1,
        kind: 'heuristic',
        lineIds: [...U],
        objective: params.objective,
        kMax: params.kMax,
        bMinValue: params.bMinValue,
        rShow: params.rShow,
        seed,
        observed: JSON.parse(JSON.stringify(observed)) as HeuristicState['observed'],
      };
    },
  };
}
