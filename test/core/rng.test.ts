import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';

describe('rng', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    const sa = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(sa);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(sa);
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
  });
  it('int is inclusive and in range; pick/shuffle behave', () => {
    const r = createRng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(r.int(2, 5));
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
    expect(() => r.int(3, 2)).toThrow();
    expect(() => r.pick([])).toThrow();
    const arr = [1, 2, 3, 4, 5, 6];
    const sh = r.shuffle(arr);
    expect(arr).toEqual([1, 2, 3, 4, 5, 6]);
    expect([...sh].sort()).toEqual(arr);
  });
});
