import { describe, expect, it } from 'vitest';
import {
  canonicalSelection,
  fullMask,
  iterBits,
  lineIdsFromMask,
  maskFromLineIds,
  maskIndices,
  popcount,
  selectionKey,
} from '../../src/core/selection';

const U = ['d', 'a', 'c', 'b'];

describe('selection', () => {
  it('canonicalSelection sorts and dedupes', () => {
    expect(canonicalSelection(['b', 'a', 'b'])).toEqual(['a', 'b']);
    expect(canonicalSelection([])).toEqual([]);
  });
  it('selectionKey is order independent and stable', () => {
    expect(selectionKey(['b', 'a'])).toBe(selectionKey(['a', 'b', 'a']));
    expect(selectionKey(['a'])).not.toBe(selectionKey(['b']));
    expect(selectionKey(['a,b'])).not.toBe(selectionKey(['a', 'b']));
  });
  it('mask <-> ids round-trip over all masks', () => {
    for (let m = 0; m <= fullMask(4); m++) {
      const ids = lineIdsFromMask(U, m);
      expect(ids).toEqual([...ids].sort());
      expect(maskFromLineIds(U, ids)).toBe(m);
    }
  });
  it('uses U index order for bits', () => {
    expect(maskFromLineIds(U, ['d'])).toBe(1);
    expect(maskFromLineIds(U, ['b'])).toBe(8);
    expect(lineIdsFromMask(U, 0b0110)).toEqual(['a', 'c']);
  });
  it('fullMask, popcount, indices', () => {
    expect(fullMask(0)).toBe(0);
    expect(fullMask(10)).toBe(1023);
    expect(fullMask(20)).toBe(1048575);
    expect(popcount(0b101101)).toBe(4);
    expect(popcount(fullMask(20))).toBe(20);
    expect(maskIndices(0b101001)).toEqual([0, 3, 5]);
    expect([...iterBits(0b110)]).toEqual([1, 2]);
    expect(maskIndices(0)).toEqual([]);
  });
  it('throws on unknown ids, n > 20, bad masks', () => {
    expect(() => maskFromLineIds(U, ['zzz'])).toThrow(/unknown lineId/);
    const big = Array.from({ length: 21 }, (_, i) => `x${i}`);
    expect(() => maskFromLineIds(big, [])).toThrow();
    expect(() => lineIdsFromMask(big, 0)).toThrow();
    expect(() => fullMask(21)).toThrow();
    expect(() => lineIdsFromMask(U, 16)).toThrow();
    expect(() => lineIdsFromMask(U, -1)).toThrow();
    expect(() => maskFromLineIds(['a', 'a'], ['a'])).toThrow(/duplicate/);
  });
  it('handles n = 20', () => {
    const u = Array.from({ length: 20 }, (_, i) => `l${String(i).padStart(2, '0')}`);
    const m = fullMask(20);
    expect(lineIdsFromMask(u, m)).toHaveLength(20);
    expect(maskFromLineIds(u, u)).toBe(m);
  });
});
