// Seeded random cart generator (design §11.1). Deterministic per (seed, n, shops).
import { createRng } from '../core/rng';
import type { Fen } from '../core/types';
import type { RateBracket, SimConfig, SimCoupon, SimItem, SimShop } from './simulator';

const yuan = (y: number): Fen => Math.round(y * 100);

type Category = 'clothes' | 'shoes' | 'accessory';

const WEIGHT_RANGE: Record<Category, [number, number]> = {
  clothes: [0.2, 1.2],
  shoes: [0.8, 1.6],
  accessory: [0.05, 0.3],
};

/** `shops` is the number of shops (default: about n/3, min 2). */
export function randomCart(seed: number, n: number, shops?: number): SimConfig {
  const rng = createRng(seed);
  const shopCount = Math.max(1, Math.min(n, shops ?? Math.max(2, Math.round(n / 3))));

  const shopList: SimShop[] = [];
  for (let s = 0; s < shopCount; s++) {
    const shop: SimShop = {
      shopId: `shop${s + 1}`,
      shopName: `Shop ${s + 1}`,
      baseFee: yuan(rng.pick([0, 5, 6, 8, 10, 12, 15])),
    };
    const kind = rng.int(0, 9);
    if (kind <= 1) shop.freeAlways = true;
    else if (kind <= 4) shop.freeAmount = yuan(rng.pick([69, 99, 129, 199]));
    else if (kind <= 6) shop.freeCount = rng.pick([2, 3]);
    else if (kind === 7) {
      shop.freeAmount = yuan(rng.pick([99, 149]));
      shop.freeCount = 3;
    }
    if (rng.chance(0.2))
      shop.discount = { every: yuan(rng.pick([100, 200])), off: yuan(rng.pick([10, 20, 30])) };
    shopList.push(shop);
  }

  const anyIneligible = rng.chance(0.04);
  const ineligibleIdx = anyIneligible ? rng.int(0, n - 1) : -1;
  const items: SimItem[] = [];
  for (let i = 0; i < n; i++) {
    const cat: Category = rng.pick(['clothes', 'clothes', 'clothes', 'shoes', 'accessory']);
    const [lo, hi] = WEIGHT_RANGE[cat];
    const shop = shopList[i < shopCount ? i : rng.int(0, shopCount - 1)] as SimShop;
    const price = cat === 'accessory' ? rng.int(15, 120) : rng.int(30, 400);
    items.push({
      lineId: `L${String(i + 1).padStart(2, '0')}`,
      itemId: `I${seed}_${i + 1}`,
      skuId: `S${seed}_${i + 1}`,
      shopId: shop.shopId,
      shopName: shop.shopName,
      title: `${cat} item ${i + 1}`,
      unitPrice: yuan(price) + rng.int(0, 99),
      qty: rng.chance(0.85) ? 1 : rng.int(2, 3),
      trueWeightKg: Math.round((lo + rng.next() * (hi - lo)) * 100) / 100,
      consolidationEligible: i !== ineligibleIdx,
    });
  }
  // Items were generated in order; shuffle so shop grouping is not index-aligned.
  const shuffled = rng.shuffle(items);

  // Tiered rate table: heavier channels start dearer and step dearer (tier breaks
  // make splitting parcels worthwhile).
  const lightMax = rng.pick([2, 3, 4]);
  const midMax = lightMax + rng.pick([3, 4, 6]);
  const limit = rng.chance(0.12) ? midMax - rng.pick([0, 1]) : 20;
  const step = rng.pick([10, 15, 20, 25, 30]);
  const lightFirst = 2 * step + rng.pick([0, 5, 10, 20, 30]);
  // Surcharge for crossing into a heavier channel; often zero so splitting is not always better.
  const jump = rng.pick([0, 0, 0, 0, 0, 5, 10, 20]);
  const stepBump = jump === 0 ? 0 : rng.pick([0, 3, 5]);
  const brackets: RateBracket[] = [
    {
      label: 'light',
      maxKg: lightMax,
      firstKg: 1,
      firstFee: yuan(lightFirst),
      stepKg: 0.5,
      stepFee: yuan(step),
    },
    {
      label: 'standard',
      maxKg: midMax,
      firstKg: 1,
      firstFee: yuan(lightFirst + jump),
      stepKg: 0.5,
      stepFee: yuan(step + stepBump),
    },
    {
      label: 'heavy',
      maxKg: 30,
      firstKg: 1,
      firstFee: yuan(lightFirst + jump * 2),
      stepKg: 0.5,
      stepFee: yuan(step + stepBump * 2),
    },
  ];

  const coupons: SimCoupon[] = [];
  if (rng.chance(0.4)) {
    const amount = rng.pick([10, 15, 20, 30, 40]);
    coupons.push({
      id: 'C1',
      label: `¥${amount} off consolidation fee`,
      amount: yuan(amount),
      minGoods: yuan(rng.pick([200, 400, 600])),
    });
  }
  if (rng.chance(0.1)) {
    coupons.push({
      id: 'C2',
      label: '¥15 off consolidation fee',
      amount: yuan(15),
      minGoods: yuan(150),
    });
  }

  return {
    items: shuffled,
    shops: shopList,
    consolidation: {
      brackets,
      weightLimitKg: limit,
      packingFactor: 1.05,
      parcelWeightKg: 0.1,
    },
    coupons,
  };
}
