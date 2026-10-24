import type { Selection } from './types';

export const MAX_N = 20;

function checkN(n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_N)
    throw new Error(`n must be 0..${MAX_N}, got ${n}`);
}

/** Sorted, deduped lineIds (code-unit order, locale independent). */
export function canonicalSelection(ids: readonly string[]): Selection {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Stable string key for a selection (order/duplicate independent). */
export function selectionKey(sel: readonly string[]): string {
  return JSON.stringify(canonicalSelection(sel));
}

export function fullMask(n: number): number {
  checkN(n);
  return 2 ** n - 1;
}

export function popcount(mask: number): number {
  let m = mask >>> 0;
  let c = 0;
  while (m) {
    m &= m - 1;
    c++;
  }
  return c;
}

/** Indices of set bits, ascending. */
export function maskIndices(mask: number): number[] {
  const out: number[] = [];
  for (let i = 0, m = mask >>> 0; m; i++, m >>>= 1) if (m & 1) out.push(i);
  return out;
}

/** Iterate set-bit indices ascending. */
export function* iterBits(mask: number): Generator<number, void, undefined> {
  for (const i of maskIndices(mask)) yield i;
}

export function maskFromLineIds(U: readonly string[], ids: readonly string[]): number {
  checkN(U.length);
  const index = new Map<string, number>();
  U.forEach((id, i) => {
    if (index.has(id)) throw new Error(`duplicate lineId in U: ${id}`);
    index.set(id, i);
  });
  let mask = 0;
  for (const id of ids) {
    const i = index.get(id);
    if (i === undefined) throw new Error(`unknown lineId: ${id}`);
    mask |= 1 << i;
  }
  return mask;
}

export function lineIdsFromMask(U: readonly string[], mask: number): Selection {
  checkN(U.length);
  if (!Number.isInteger(mask) || mask < 0 || mask > fullMask(U.length)) {
    throw new Error(`mask ${mask} out of range for n=${U.length}`);
  }
  return canonicalSelection(maskIndices(mask).map((i) => U[i] as string));
}
