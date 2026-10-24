// Set-partition enumeration via restricted-growth strings (design §7.1 step 3). Pure TS.

import { MAX_N } from './selection';

/** Stirling number of the second kind S(n,k). */
export function stirling2(n: number, k: number): number {
  if (n < 0 || k < 0) return 0;
  if (n === 0) return k === 0 ? 1 : 0;
  if (k === 0 || k > n) return 0;
  let row = [1]; // S(0,*)
  for (let i = 1; i <= n; i++) {
    const next = new Array<number>(Math.min(i, k) + 1).fill(0);
    for (let j = 1; j <= Math.min(i, k); j++) {
      next[j] = (row[j - 1] ?? 0) + j * (row[j] ?? 0);
    }
    row = next;
  }
  return row[k] ?? 0;
}

/** Number of partitions of an n-set into 1..kMax blocks (n=0 -> 1 empty partition only if kMax>=0). */
export function countPartitions(n: number, kMax: number): number {
  if (n === 0) return 1;
  let total = 0;
  for (let k = 1; k <= Math.min(kMax, n); k++) total += stirling2(n, k);
  return total;
}

/**
 * Enumerate partitions of the given element masks (pairwise disjoint, non-zero) into
 * 1..kMax blocks. Each block is the OR of its element masks. Canonical form: blocks
 * sorted by lowest set bit. Yields a fresh array each time. Empty `elements` yields nothing.
 */
export function* partitionsOfMasks(
  elements: readonly number[],
  kMax: number,
): Generator<number[], void, undefined> {
  const m = elements.length;
  if (m === 0 || kMax < 1) return;
  let seen = 0;
  for (const e of elements) {
    if (!Number.isInteger(e) || e <= 0) throw new Error(`invalid element mask ${e}`);
    if ((seen & e) !== 0) throw new Error('element masks must be disjoint');
    seen |= e;
  }
  const blocks: number[] = [];
  const lowBit = (x: number): number => x & -x;
  function* rec(i: number): Generator<number[], void, undefined> {
    if (i === m) {
      yield [...blocks].sort((a, b) => lowBit(a) - lowBit(b));
      return;
    }
    const e = elements[i] as number;
    for (let g = 0; g < blocks.length; g++) {
      const prev = blocks[g] as number;
      blocks[g] = prev | e;
      yield* rec(i + 1);
      blocks[g] = prev;
    }
    if (blocks.length < kMax) {
      blocks.push(e);
      yield* rec(i + 1);
      blocks.pop();
    }
  }
  yield* rec(0);
}

/** Partitions of {0..n-1} (as bitmasks) into 1..kMax blocks. */
export function partitions(n: number, kMax: number): Generator<number[], void, undefined> {
  if (!Number.isInteger(n) || n < 0 || n > MAX_N) throw new Error(`n must be 0..${MAX_N}`);
  return partitionsOfMasks(
    Array.from({ length: n }, (_, i) => 1 << i),
    kMax,
  );
}
