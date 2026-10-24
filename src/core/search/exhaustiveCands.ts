// Exhaustive candidate ranking over predictions (design §7.6, small n). Pure TS.
// Scores every partition (A) / subset (B) of the eligible items with the prediction model and
// returns the best `topN`. Used instead of hill climbing while the space is small.

import type { PartitionCandidate, SearchCtx, SubsetCandidate } from './localSearch';

/** Largest n (eligible items) for which exhaustive ranking is used. S(12, <=3) ~ 89k. */
export const EXH_CAND_MAX_N = 12;

class TopN<T> {
  private buf: { score: number; v: T }[] = [];
  private cutoff = Infinity;
  constructor(private readonly n: number) {}
  add(score: number, v: () => T): void {
    if (!(score <= this.cutoff) || !Number.isFinite(score)) return;
    this.buf.push({ score, v: v() });
    if (this.buf.length > this.n * 4) this.trim();
  }
  private trim(): void {
    this.buf.sort((a, b) => a.score - b.score);
    this.buf.length = Math.min(this.buf.length, this.n);
    if (this.buf.length >= this.n) this.cutoff = (this.buf[this.n - 1] as { score: number }).score;
  }
  result(): { score: number; v: T }[] {
    this.buf.sort((a, b) => a.score - b.score);
    return this.buf.slice(0, this.n);
  }
}

/** Expected improvement of `cost` samples over `best` (mean of max(0, best - cost)). */
function eiScore(costs: Float64Array, best: number): number {
  const K = costs.length;
  let ei = 0;
  let mean = 0;
  let fin = 0;
  for (let k = 0; k < K; k++) {
    const c = costs[k] as number;
    if (c === Infinity) continue;
    fin++;
    mean += c;
    if (c < best) ei += best - c;
  }
  if (fin === 0) return Infinity;
  mean /= fin;
  // lower is better; mean breaks ties and orders candidates when nothing is expected to improve
  return -ei / K + (mean / 1e9) * (1 + (K - fin) / K) + (K - fin) * 1e3;
}

function exhaustiveAEI(ctx: SearchCtx, topN: number): PartitionCandidate[] {
  const E = ctx.eligible;
  const sm = ctx.samplesO as (m: number) => Float64Array;
  const best = ctx.best ?? Infinity;
  const K = sm(E).length;
  const top = new TopN<number[]>(topN);
  const tmp = new Float64Array(K);
  const low = E & -E;
  const score = (blocks: number[]): void => {
    for (let k = 0; k < K; k++) {
      let c = 0;
      for (const b of blocks) c += sm(b)[k] as number;
      tmp[k] = c;
    }
    const sc = Number.isFinite(best) ? eiScore(tmp, best) : meanScore(tmp);
    top.add(sc, () => blocks);
  };
  score([E]);
  if (ctx.kMax >= 2) {
    const rest = E ^ low;
    for (let s1 = rest; ; s1 = (s1 - 1) & rest) {
      if (s1 !== rest) {
        const b1 = low | s1;
        const b2 = E ^ b1;
        score([b1, b2]);
        if (ctx.kMax >= 3) {
          const low2 = b2 & -b2;
          const rest2 = b2 ^ low2;
          for (let s2 = rest2; ; s2 = (s2 - 1) & rest2) {
            if (s2 !== rest2) score([b1, low2 | s2, b2 ^ (low2 | s2)]);
            if (s2 === 0) break;
          }
        }
      }
      if (s1 === 0) break;
    }
  }
  return top.result().map((r) => ({ masks: r.v, score: r.score }));
}

function meanScore(costs: Float64Array): number {
  let m = 0;
  for (const c of costs) {
    if (c === Infinity) return Infinity;
    m += c;
  }
  return m / costs.length;
}

export function exhaustiveA(ctx: SearchCtx, topN: number): PartitionCandidate[] {
  const E = ctx.eligible;
  if (E === 0) return [];
  if (ctx.samplesO) return exhaustiveAEI(ctx, topN);
  const cost = new Map<number, number>();
  const c = (m: number): number => {
    let v = cost.get(m);
    if (v === undefined) {
      v = ctx.predictO(m);
      cost.set(m, v);
    }
    return v;
  };
  const top = new TopN<number[]>(topN);
  const low = E & -E;
  top.add(c(E), () => [E]);
  if (ctx.kMax >= 2) {
    const rest = E ^ low;
    for (let s1 = rest; ; s1 = (s1 - 1) & rest) {
      if (s1 !== rest) {
        const b1 = low | s1;
        const b2 = E ^ b1;
        const sc = c(b1) + c(b2);
        top.add(sc, () => [b1, b2]);
        if (ctx.kMax >= 3 && Number.isFinite(c(b1))) {
          const low2 = b2 & -b2;
          const rest2 = b2 ^ low2;
          for (let s2 = rest2; ; s2 = (s2 - 1) & rest2) {
            if (s2 !== rest2) {
              const b2a = low2 | s2;
              const b3 = b2 ^ b2a;
              const sc3 = c(b1) + c(b2a) + c(b3);
              top.add(sc3, () => [b1, b2a, b3]);
            }
            if (s2 === 0) break;
          }
        }
      }
      if (s1 === 0) break;
    }
  }
  return top.result().map((r) => ({ masks: r.v, score: r.score }));
}

export function exhaustiveB(ctx: SearchCtx, topN: number): SubsetCandidate[] {
  const E = ctx.eligible;
  const top = new TopN<number>(topN);
  if (ctx.samplesO) {
    const best = ctx.best ?? Infinity;
    const tmp = new Float64Array(ctx.samplesO(E).length);
    for (let m = E; m > 0; m = (m - 1) & E) {
      const g = ctx.predictG(m);
      if (!(g > 0) || g < ctx.bMin) continue;
      const so = ctx.samplesO(m);
      const sav = ctx.couponOptions
        ? ctx.couponOptions(m).reduce((a, c) => Math.max(a, c.amount), 0)
        : 0;
      for (let k = 0; k < tmp.length; k++) tmp[k] = ((so[k] as number) - sav) / g;
      const sc = Number.isFinite(best) ? eiScore(tmp, best) : meanScore(tmp);
      top.add(sc, () => m);
    }
    return top.result().map((r) => ({ mask: r.v, score: r.score }));
  }
  for (let m = E; m > 0; m = (m - 1) & E) {
    const g = ctx.predictG(m);
    if (!(g > 0) || g < ctx.bMin) continue;
    const o = ctx.predictO(m);
    if (!Number.isFinite(o)) continue;
    top.add(o / g, () => m);
  }
  return top.result().map((r) => ({ mask: r.v, score: r.score }));
}
