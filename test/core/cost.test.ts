import { describe, expect, it } from 'vitest';
import { objectiveA, objectiveB, overhead } from '../../src/core/cost';
import type { Quote } from '../../src/core/types';

function q(
  o: number,
  coupons: { id: string; amount: number }[] = [],
  extra: Partial<Quote> = {},
): Quote {
  return {
    key: 'k',
    lineIds: [],
    status: 'ok',
    goodsNet: 10000,
    grandTotal: 10000 + o,
    overhead: o,
    coupons: coupons.map((c) => ({ ...c, label: c.id })),
    breakdownConsistent: true,
    capturedAt: 0,
    addressId: 'a',
    ...extra,
  };
}

describe('overhead', () => {
  it('is Infinity when infeasible', () => {
    expect(overhead(q(500))).toBe(500);
    expect(overhead(q(0, [], { status: 'infeasible' }))).toBe(Infinity);
  });
});

describe('objectiveA', () => {
  it('sums overhead without coupons', () => {
    const m = new Map([
      [1, q(300)],
      [2, q(400)],
    ]);
    expect(objectiveA([1, 2], m)).toEqual({ cost: 700, couponAdjusted: false, adjustments: [] });
  });

  it('returns null if a group is unquoted', () => {
    expect(objectiveA([1, 2], new Map([[1, q(1)]]))).toBeNull();
  });

  it('accepts a lookup function', () => {
    expect(objectiveA([1], (m) => (m === 1 ? q(5) : undefined))?.cost).toBe(5);
  });

  it('infeasible group gives Infinity', () => {
    const m = new Map([
      [1, q(300)],
      [2, q(0, [], { status: 'infeasible' })],
    ]);
    expect(objectiveA([1, 2], m)?.cost).toBe(Infinity);
  });

  it('coupon in 2 groups, equal amounts: tie keeps lowest index', () => {
    const m = new Map([
      [1, q(300, [{ id: 'c', amount: 500 }])],
      [2, q(400, [{ id: 'c', amount: 500 }])],
    ]);
    const r = objectiveA([1, 2], m)!;
    expect(r.cost).toBe(1200);
    expect(r.couponAdjusted).toBe(true);
    expect(r.adjustments).toEqual([{ couponId: 'c', fromGroup: 1, amount: 500 }]);
  });

  it('unequal amounts: keeps the largest', () => {
    const m = new Map([
      [1, q(300, [{ id: 'c', amount: 200 }])],
      [2, q(400, [{ id: 'c', amount: 500 }])],
    ]);
    const r = objectiveA([1, 2], m)!;
    expect(r.cost).toBe(900);
    expect(r.adjustments).toEqual([{ couponId: 'c', fromGroup: 0, amount: 200 }]);
  });

  it('coupon in 3 groups: adds back the two others', () => {
    const m = new Map([
      [1, q(100, [{ id: 'c', amount: 100 }])],
      [2, q(100, [{ id: 'c', amount: 300 }])],
      [4, q(100, [{ id: 'c', amount: 200 }])],
    ]);
    const r = objectiveA([1, 2, 4], m)!;
    expect(r.cost).toBe(300 + 100 + 200);
    expect(r.adjustments.map((a) => a.fromGroup).sort()).toEqual([0, 2]);
  });

  it('two different coupons are handled independently', () => {
    const m = new Map([
      [
        1,
        q(100, [
          { id: 'a', amount: 50 },
          { id: 'b', amount: 10 },
        ]),
      ],
      [
        2,
        q(100, [
          { id: 'a', amount: 70 },
          { id: 'b', amount: 30 },
        ]),
      ],
      [4, q(100, [{ id: 'b', amount: 20 }])],
    ]);
    const r = objectiveA([1, 2, 4], m)!;
    // a: keep g1 (70), add 50. b: keep g1 (30), add 10 + 20.
    expect(r.cost).toBe(300 + 50 + 10 + 20);
    expect(r.adjustments).toHaveLength(3);
  });

  it('distinct coupons in different groups cause no adjustment', () => {
    const m = new Map([
      [1, q(100, [{ id: 'a', amount: 50 }])],
      [2, q(100, [{ id: 'b', amount: 50 }])],
    ]);
    expect(objectiveA([1, 2], m)?.couponAdjusted).toBe(false);
  });
});

describe('objectiveB', () => {
  const m = new Map([
    [1, q(500, [], { goodsNet: 10000 })],
    [2, q(500, [], { goodsNet: 0 })],
    [3, q(0, [], { status: 'infeasible' })],
  ]);
  it('returns O/G', () => expect(objectiveB(1, m, 5000)).toBe(0.05));
  it('null below bMin', () => expect(objectiveB(1, m, 10001)).toBeNull());
  it('null for G <= 0 even with bMin 0', () => expect(objectiveB(2, m, 0)).toBeNull());
  it('null infeasible / unquoted', () => {
    expect(objectiveB(3, m, 0)).toBeNull();
    expect(objectiveB(9, m, 0)).toBeNull();
  });
});
