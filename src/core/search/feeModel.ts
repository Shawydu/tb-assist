// Latent-weight model of the consolidation fee (design §7.3, "latent mode"). INTERNAL ONLY.
//
// Without a rate table we still know the fee lattice from the observed fees: the smallest
// positive gap between distinct fees is one weight step. Each observed quote then says that
// the sum of its items' (unknown) weights, measured in steps, lies in one bracket:
//     level l >= 1:  sum x_i in (d + l - 1, d + l]        level 0:  sum x_i in (0, d]
// where d is the size of the first-weight bracket in steps (unknown, fitted from a grid).
// We draw weight vectors consistent with all observations (projection + Gibbs sweeps) and
// predict the fee of an unprobed mask as the mean fee over the samples. Uses quotes only.

import type { Rng } from '../rng';
import type { Fen } from '../types';

export interface FeeObs {
  mask: number;
  fee: Fen;
}

export interface FeeModel {
  /** Mean predicted consolidation fee (fen) of a mask. */
  predictFee(mask: number): number;
  /** Predicted probability that the mask exceeds the (observed) weight limit. */
  pOverweight(mask: number): number;
  /** Per-sample fee of a mask (Infinity where that sample exceeds the weight limit). */
  feeSamples(mask: number): Float64Array;
  readonly d: number;
  readonly step: Fen;
  readonly samples: number;
}

const D_GRID = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];
/** Per-extra-item weight saving in step units (a parcel's packaging weight is paid once). */
const P_GRID = [0, 0.1, 0.2, 0.3];
export const SAMPLES = 48;
const TOL = 50; // fen

interface Cons {
  bits: number[];
  lo: number;
  hi: number;
}

const popcount = (x: number): number => {
  let c = 0;
  for (let m = x; m; m &= m - 1) c++;
  return c;
};

const bitsOf = (mask: number): number[] => {
  const out: number[] = [];
  for (let i = 0; mask >>> i; i++) if (mask & (1 << i)) out.push(i);
  return out;
};

export function fitFeeModel(
  n: number,
  obs: readonly FeeObs[],
  heavy: readonly number[],
  rng: Rng,
): FeeModel | null {
  if (obs.length === 0) return null;
  const fees = [...new Set(obs.map((o) => o.fee))].sort((a, b) => a - b);
  const F0 = fees[0] as number;
  let step = Infinity;
  // Heavier channels may change the step, so the step comes from the cheapest half of the fees.
  const lowFees = fees.slice(0, Math.max(2, Math.ceil(fees.length / 2)));
  for (let i = 1; i < lowFees.length; i++) {
    const g = (lowFees[i] as number) - (lowFees[i - 1] as number);
    if (g > TOL && g < step) step = g;
  }
  if (!Number.isFinite(step)) return null;
  const BIG = 60; // level of a fee that is off the light-channel lattice
  const level = (fee: Fen): number => {
    const q = (fee - F0) / step;
    const r = Math.max(0, Math.round(q));
    return Math.abs(q - r) * step > TOL ? BIG : r;
  };

  // per-item singleton data (every in-scope item must have a singleton)
  const single: (number | undefined)[] = new Array<number | undefined>(n).fill(undefined);
  for (const o of obs)
    if ((o.mask & (o.mask - 1)) === 0) single[31 - Math.clz32(o.mask)] = level(o.fee);
  const inScope = obs.reduce((m, o) => m | o.mask, 0);
  for (const i of bitsOf(inScope)) if (single[i] === undefined) return null;
  const multi = obs.filter((o) => o.mask & (o.mask - 1));

  const levels = obs.map((o) => level(o.fee));
  const maxLevel = Math.max(0, ...levels.filter((l) => l < BIG));

  /** Samples consistent with all quotes; quotes with level > lc are only loosely constrained. */
  const fit = (d: number, p: number, lc: number, count: number, sweeps: number): number[][] => {
    const lo = new Array<number>(n).fill(0);
    const hi = new Array<number>(n).fill(0);
    const bound = (l: number): [number, number] =>
      l === 0 ? [0.02, d] : l <= lc ? [d + l - 1, d + l] : [d + lc - 1, d + l];
    for (const i of bitsOf(inScope)) {
      const [a0, b0] = bound(single[i] as number);
      lo[i] = a0;
      hi[i] = b0;
    }
    const cons: Cons[] = multi.map((o) => {
      const [a0, b0] = bound(level(o.fee));
      const adj = (popcount(o.mask) - 1) * p;
      return { bits: bitsOf(o.mask), lo: a0 + adj, hi: b0 + adj };
    });
    const byItem: Cons[][] = Array.from({ length: n }, () => []);
    for (const c of cons) for (const i of c.bits) (byItem[i] as Cons[]).push(c);
    const out: number[][] = [];
    for (let attempt = 0; attempt < count + 3 && out.length < count; attempt++) {
      const x = new Array<number>(n).fill(0);
      for (const i of bitsOf(inScope))
        x[i] = (lo[i] as number) + rng.next() * ((hi[i] as number) - (lo[i] as number));
      let ok = false;
      for (let it = 0; it < 60 && !ok; it++) {
        ok = true;
        for (const c of cons) {
          let s = 0;
          for (const i of c.bits) s += x[i] as number;
          const k = c.bits.length;
          if (s <= c.lo + 1e-6) {
            ok = false;
            const dlt = (c.lo + 0.01 - s) / k;
            for (const i of c.bits) x[i] = Math.min(hi[i] as number, (x[i] as number) + dlt);
          } else if (s > c.hi) {
            ok = false;
            const dlt = (s - c.hi + 0.01) / k;
            for (const i of c.bits)
              x[i] = Math.max((lo[i] as number) + 1e-3, (x[i] as number) - dlt);
          }
        }
      }
      if (!ok) continue;
      let good = true;
      for (const c of cons) {
        let s = 0;
        for (const i of c.bits) s += x[i] as number;
        if (!(s > c.lo && s <= c.hi + 1e-9)) good = false;
      }
      if (!good) continue;
      for (let sw = 0; sw < sweeps; sw++) {
        for (const i of bitsOf(inScope)) {
          let a = lo[i] as number;
          let b = hi[i] as number;
          for (const c of byItem[i] as Cons[]) {
            let rest = 0;
            for (const j of c.bits) if (j !== i) rest += x[j] as number;
            a = Math.max(a, c.lo - rest + 1e-6);
            b = Math.min(b, c.hi - rest);
          }
          if (b > a) x[i] = a + rng.next() * (b - a);
        }
      }
      out.push(x);
    }
    return out;
  };

  const feasibleDs = (lc: number): [number, number][] => {
    const out: [number, number][] = [];
    for (const d of D_GRID)
      for (const p of P_GRID) if (fit(d, p, lc, 1, 0).length >= 1) out.push([d, p]);
    return out;
  };
  // largest trusted level that still admits a consistent weight vector
  let lc = maxLevel;
  let feasible = feasibleDs(lc);
  if (feasible.length === 0) {
    let lo = 0;
    let hi = maxLevel; // infeasible
    feasible = feasibleDs(0);
    if (feasible.length === 0) return null;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      const f = feasibleDs(mid);
      if (f.length > 0) {
        lo = mid;
        feasible = f;
      } else hi = mid;
    }
    lc = lo;
  }
  let cd = 0;
  let cp = 0;
  for (const [a, b] of feasible) {
    cd += a / feasible.length;
    cp += b / feasible.length;
  }
  let [d, P] = feasible[0] as [number, number];
  let bestDist = Infinity;
  for (const [a, b] of feasible) {
    const dist = ((a - cd) / 0.25) ** 2 + ((b - cp) / 0.1) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      d = a;
      P = b;
    }
  }
  const xs = fit(d, P, lc, SAMPLES, 4);
  if (xs.length < 8) return null;
  for (let k = 0; xs.length < SAMPLES; k++) xs.push(xs[k] as number[]);
  const K = xs.length;

  // weight limit: smallest sum among observed-infeasible (heavy) masks, per sample
  const h1 = Math.ceil(n / 2);
  const loSum: Float64Array[] = [];
  const hiSum: Float64Array[] = [];
  for (const x of xs) {
    const lt = new Float64Array(1 << h1);
    for (let m = 1; m < 1 << h1; m++)
      lt[m] = (lt[m & (m - 1)] as number) + (x[31 - Math.clz32(m & -m)] as number);
    const ht = new Float64Array(1 << (n - h1));
    for (let m = 1; m < 1 << (n - h1); m++)
      ht[m] = (ht[m & (m - 1)] as number) + (x[h1 + 31 - Math.clz32(m & -m)] as number);
    loSum.push(lt);
    hiSum.push(ht);
  }
  const sumOf = (k: number, mask: number): number =>
    (loSum[k] as Float64Array)[mask & ((1 << h1) - 1)]! +
    (hiSum[k] as Float64Array)[mask >>> h1]! -
    (popcount(mask) - 1) * P;
  const limit = xs.map((_, k) => {
    let m = Infinity;
    for (const h of heavy) m = Math.min(m, sumOf(k, h));
    if (!Number.isFinite(m)) return m;
    let f = 0;
    for (const o of obs) f = Math.max(f, sumOf(k, o.mask));
    return (m + Math.min(f, m)) / 2; // limit lies between max feasible and min infeasible sum
  });

  // fee as a function of the (weight) sum: exact lattice up to d + lc, then monotone
  // interpolation through the loosely constrained (higher tier) quotes.
  const top = d + lc;
  const tail: [number, number][] = [[top, F0 + lc * step]];
  for (const o of obs) {
    if (level(o.fee) <= lc) continue;
    let t = 0;
    for (let k = 0; k < K; k++) t += sumOf(k, o.mask);
    tail.push([t / K, o.fee]);
  }
  tail.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < tail.length; i++) {
    const prev = tail[i - 1] as [number, number];
    const cur = tail[i] as [number, number];
    if (cur[1] < prev[1]) cur[1] = prev[1];
  }
  const feeOfSum = (s: number): number => {
    if (s <= d) return F0;
    if (s <= top) return F0 + Math.ceil(s - d - 1e-9) * step;
    for (let i = 1; i < tail.length; i++) {
      const a = tail[i - 1] as [number, number];
      const b = tail[i] as [number, number];
      if (s <= b[0])
        return b[0] > a[0] ? a[1] + ((b[1] - a[1]) * (s - a[0])) / (b[0] - a[0]) : b[1];
    }
    const last = tail[tail.length - 1] as [number, number];
    const prev = tail.length > 1 ? (tail[tail.length - 2] as [number, number]) : null;
    const slope = prev && last[0] > prev[0] ? (last[1] - prev[1]) / (last[0] - prev[0]) : step;
    return last[1] + Math.max(step, slope) * (s - last[0]);
  };

  const cache = new Map<number, number>();
  const pcache = new Map<number, number>();
  const scache = new Map<number, Float64Array>();
  return {
    d,
    step,
    samples: K,
    predictFee(mask: number): number {
      const hit = cache.get(mask);
      if (hit !== undefined) return hit;
      let t = 0;
      for (let k = 0; k < K; k++) t += feeOfSum(sumOf(k, mask));
      const v = t / K;
      cache.set(mask, v);
      return v;
    },
    feeSamples(mask: number): Float64Array {
      const hit = scache.get(mask);
      if (hit) return hit;
      const out = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        const sm = sumOf(k, mask);
        out[k] = sm >= (limit[k] as number) ? Infinity : feeOfSum(sm);
      }
      scache.set(mask, out);
      return out;
    },
    pOverweight(mask: number): number {
      if (heavy.length === 0) return 0;
      const hit = pcache.get(mask);
      if (hit !== undefined) return hit;
      let c = 0;
      for (let k = 0; k < K; k++) if (sumOf(k, mask) >= (limit[k] as number)) c++;
      const v = c / K;
      pcache.set(mask, v);
      return v;
    },
  };
}
