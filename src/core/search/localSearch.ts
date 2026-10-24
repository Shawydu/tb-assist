// Candidate generation by local search (design §7.6). Pure TS; bitmasks over item index order.
// Scores come from a prediction function (exact for quoted masks); they only choose what to probe.

import type { Rng } from '../rng';
import type { Fen } from '../types';

export interface SearchCtx {
  /** Mask of items in scope (eligible). All candidates are subsets of it. */
  eligible: number;
  /** One mask per shop (already intersected with `eligible`, non-empty). */
  shopMasks: readonly number[];
  /** Predicted overhead, Infinity if known infeasible. */
  predictO(mask: number): number;
  /** Predicted goods net. */
  predictG(mask: number): Fen;
  /** Optional posterior samples of overhead per mask (Infinity = infeasible in that sample). */
  samplesO?(mask: number): Float64Array;
  /** With samplesO: coupons the mask is expected to qualify for; samplesO is then pre-coupon. */
  couponOptions?(mask: number): { id: string; amount: Fen }[];
  /** Best verified cost (A) / ratio (B) so far; Infinity if none. Enables expected-improvement ranking. */
  best?: number;
  kMax: number;
  bMin: Fen;
  rng: Rng;
  /** Defaults: topN 50, restarts 20. */
  topN?: number;
  restarts?: number;
}

export interface PartitionCandidate {
  /** Canonical: blocks sorted by lowest set bit. */
  masks: number[];
  /** Predicted Σ overhead (pre-coupon). Finite. */
  score: number;
}

export interface SubsetCandidate {
  mask: number;
  /** Predicted O/G. Finite. */
  score: number;
}

const EPS = 1e-9;
const MAX_CLIMB_STEPS = 200;

const low = (x: number): number => x & -x;

export function canonicalPartition(masks: readonly number[]): number[] {
  return masks.filter((m) => m !== 0).sort((a, b) => low(a) - low(b));
}

const keyOfPartition = (masks: readonly number[]): string => masks.join(',');

/** Bounded pool of the best distinct states, keyed by canonical key. */
class Pool<T> {
  private readonly map = new Map<string, { score: number; value: T }>();
  private cutoff = Infinity;
  constructor(private readonly top: number) {}

  /** Cheap pre-check before building a key. */
  mayAdd(score: number): boolean {
    return Number.isFinite(score) && score <= this.cutoff;
  }

  add(key: string, score: number, value: T): void {
    if (!this.mayAdd(score) || this.map.has(key)) return;
    this.map.set(key, { score, value });
    if (this.map.size > this.top * 4) this.trim();
  }

  private trim(): void {
    const rows = this.sorted().slice(0, this.top);
    this.map.clear();
    for (const r of rows) this.map.set(r.key, { score: r.score, value: r.value });
    this.cutoff =
      rows.length >= this.top ? (rows[rows.length - 1] as { score: number }).score : Infinity;
  }

  private sorted(): { key: string; score: number; value: T }[] {
    return [...this.map]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => a.score - b.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  best(): { key: string; score: number; value: T }[] {
    return this.sorted().slice(0, this.top);
  }
}

function memo(f: (m: number) => number): (m: number) => number {
  const cache = new Map<number, number>();
  return (m) => {
    let v = cache.get(m);
    if (v === undefined) {
      v = f(m);
      cache.set(m, v);
    }
    return v;
  };
}

function bitsOf(mask: number): number[] {
  const out: number[] = [];
  for (let m = mask; m; m &= m - 1) out.push(low(m));
  return out;
}

// ---------------------------------------------------------------------------
// Objective A

export function candidatesA(
  ctx: SearchCtx,
  extraSeeds: readonly (readonly number[])[] = [],
): PartitionCandidate[] {
  const { eligible, kMax, rng } = ctx;
  if (eligible === 0 || kMax < 1) return [];
  const topN = ctx.topN ?? 50;
  const restarts = ctx.restarts ?? 20;
  const blockScore = memo(ctx.predictO);
  const gScore = memo(ctx.predictG);
  const items = bitsOf(eligible);
  const pool = new Pool<number[]>(topN);

  const score = (p: readonly number[]): number => {
    let s = 0;
    for (const m of p) {
      s += blockScore(m);
      if (s === Infinity) return s;
    }
    return s;
  };
  const record = (p: number[], s: number): void => {
    if (pool.mayAdd(s)) {
      const c = canonicalPartition(p);
      pool.add(keyOfPartition(c), s, c);
    }
  };

  // Neighbor visitor; callbacks receive a fresh non-canonical array.
  const forEachNeighbor = (cur: readonly number[], visit: (nb: number[]) => void): void => {
    const k = cur.length;
    for (let g = 0; g < k; g++) {
      const bg = cur[g] as number;
      const single = (bg & (bg - 1)) === 0;
      for (const it of bitsOf(bg)) {
        for (let h = 0; h < k; h++) {
          if (h === g) continue;
          const nb = cur.slice();
          nb[g] = bg & ~it;
          nb[h] = (cur[h] as number) | it;
          visit(nb.filter((m) => m !== 0));
        }
        if (!single && k < kMax) {
          const nb = cur.slice();
          nb[g] = bg & ~it;
          nb.push(it);
          visit(nb);
        }
        for (let h = g + 1; h < k; h++) {
          const bh = cur[h] as number;
          for (const jt of bitsOf(bh)) {
            const nb = cur.slice();
            nb[g] = (bg & ~it) | jt;
            nb[h] = (bh & ~jt) | it;
            visit(nb);
          }
        }
      }
      if (k < kMax) {
        for (const sm of ctx.shopMasks) {
          const part = bg & sm;
          if (part === 0 || part === bg) continue;
          const nb = cur.slice();
          nb[g] = bg & ~part;
          nb.push(part);
          visit(nb);
        }
      }
      for (let h = g + 1; h < k; h++) {
        const nb = cur.filter((_, idx) => idx !== g && idx !== h);
        nb.push(bg | (cur[h] as number));
        visit(nb);
      }
    }
  };

  const climb = (start: readonly number[]): void => {
    let cur = canonicalPartition(start);
    let curScore = score(cur);
    record(cur, curScore);
    for (let step = 0; step < MAX_CLIMB_STEPS; step++) {
      let best: number[] | null = null;
      let bestScore = curScore;
      forEachNeighbor(cur, (nb) => {
        const s = score(nb);
        record(nb, s);
        if (s < bestScore - EPS) {
          best = nb;
          bestScore = s;
        }
      });
      if (!best) break;
      cur = canonicalPartition(best);
      curScore = bestScore;
    }
  };

  // --- seeds ---
  const seeds: number[][] = [[eligible]];
  const shopGroups = ctx.shopMasks.map((m) => m & eligible).filter((m) => m !== 0);
  if (shopGroups.length > 1) {
    const merged = shopGroups.slice();
    while (merged.length > kMax) {
      merged.sort((a, b) => gScore(a) - gScore(b) || low(a) - low(b));
      const a = merged.shift() as number;
      const b = merged.shift() as number;
      merged.push(a | b);
    }
    seeds.push(merged);
  }
  // best 2-split: single item vs rest, and shop-subset splits (when few shops)
  if (kMax >= 2 && items.length >= 2) {
    let bestSplit: number[] | null = null;
    let bestSplitScore = Infinity;
    const trySplit = (a: number): void => {
      const b = eligible & ~a;
      if (a === 0 || b === 0) return;
      const s = blockScore(a) + blockScore(b);
      if (s < bestSplitScore) {
        bestSplitScore = s;
        bestSplit = [a, b];
      }
    };
    for (const it of items) trySplit(it);
    if (shopGroups.length >= 2 && shopGroups.length <= 10) {
      const last = shopGroups.length - 1; // fix the last shop on side b to halve the space
      for (let sub = 1; sub < 2 ** last; sub++) {
        let a = 0;
        for (let s = 0; s < last; s++) if (sub & (1 << s)) a |= shopGroups[s] as number;
        trySplit(a);
      }
    }
    if (bestSplit) seeds.push(bestSplit);
  }
  for (const s of extraSeeds) if (s.length > 0 && s.length <= kMax) seeds.push([...s]);
  for (const s of seeds) climb(s);

  // --- random restarts ---
  const randomStart = (): number[] => {
    const k = rng.int(1, Math.min(kMax, items.length));
    const blocks = new Array<number>(k).fill(0);
    for (const it of items) blocks[rng.int(0, k - 1)]! |= it;
    return blocks.filter((m) => m !== 0);
  };
  const perturbed = (): number[] => {
    const base = seeds[rng.int(0, seeds.length - 1)] as number[];
    let cur = base.slice();
    for (let t = rng.int(1, 3); t > 0; t--) {
      const it = rng.pick(items);
      const g = cur.findIndex((b) => (b & it) !== 0);
      const dest = rng.int(0, cur.length < kMax ? cur.length : cur.length - 1);
      cur[g] = (cur[g] as number) & ~it;
      if (dest === cur.length) cur.push(it);
      else cur[dest] = (cur[dest] as number) | it;
      cur = cur.filter((m) => m !== 0);
    }
    return cur;
  };
  for (let r = 0; r < restarts; r++) climb(r % 2 === 0 ? randomStart() : perturbed());

  return pool.best().map((r) => ({ masks: r.value, score: r.score }));
}

// ---------------------------------------------------------------------------
// Objective B

export function candidatesB(ctx: SearchCtx, extraSeeds: readonly number[] = []): SubsetCandidate[] {
  const { eligible, rng, bMin } = ctx;
  if (eligible === 0) return [];
  const topN = ctx.topN ?? 50;
  const restarts = ctx.restarts ?? 20;
  const oScore = memo(ctx.predictO);
  const gScore = memo(ctx.predictG);
  const items = bitsOf(eligible);
  const pool = new Pool<number>(topN);

  const valid = (m: number): boolean => m !== 0 && gScore(m) > 0 && gScore(m) >= bMin;
  const score = (m: number): number => {
    if (!valid(m)) return Infinity;
    const o = oScore(m);
    return Number.isFinite(o) ? o / gScore(m) : Infinity;
  };
  const record = (m: number, s: number): void => {
    if (pool.mayAdd(s)) pool.add(String(m), s, m);
  };

  const forEachNeighbor = (m: number, visit: (nb: number) => void): void => {
    const inside = bitsOf(m);
    const outside = bitsOf(eligible & ~m);
    for (const o of outside) visit(m | o);
    if (inside.length > 1) for (const i of inside) visit(m & ~i);
    for (const i of inside) for (const o of outside) visit((m & ~i) | o);
    for (const sm of ctx.shopMasks) {
      const add = m | sm;
      if (add !== m) visit(add);
      const rem = m & ~sm;
      if (rem !== m && rem !== 0) visit(rem);
    }
  };

  const climb = (start: number): void => {
    let cur = start;
    let curScore = score(cur);
    record(cur, curScore);
    if (!Number.isFinite(curScore)) return;
    for (let step = 0; step < MAX_CLIMB_STEPS; step++) {
      let best = -1;
      let bestScore = curScore;
      forEachNeighbor(cur, (nb) => {
        const s = score(nb);
        record(nb, s);
        if (s < bestScore - EPS) {
          best = nb;
          bestScore = s;
        }
      });
      if (best < 0) break;
      cur = best;
      curScore = bestScore;
    }
  };

  const seeds: number[] = [eligible];
  const shopGroups = ctx.shopMasks.map((m) => m & eligible).filter((m) => m !== 0);
  for (const s of shopGroups) seeds.push(s);
  // whole shops by predicted R = O/G, added greedily (every prefix is a seed)
  const byR = shopGroups
    .map((m) => ({ m, r: gScore(m) > 0 ? oScore(m) / gScore(m) : Infinity }))
    .filter((x) => Number.isFinite(x.r))
    .sort((a, b) => a.r - b.r || low(a.m) - low(b.m));
  let acc = 0;
  for (const { m } of byR) {
    acc |= m;
    seeds.push(acc);
  }
  for (const s of extraSeeds) seeds.push(s & eligible);
  for (const s of seeds) climb(s);

  const randomStart = (): number => {
    let m = 0;
    for (const it of rng.shuffle(items)) {
      if (valid(m) && !rng.chance(0.6)) break;
      m |= it;
    }
    return m;
  };
  for (let r = 0; r < restarts; r++) climb(randomStart());

  return pool.best().map((r) => ({ mask: r.value, score: r.score }));
}
