# Changelog

## T1 Scaffold
- WXT (MV3) + TypeScript strict + Preact, Vitest + happy-dom, Playwright, ESLint (flat) + Prettier, idb.
- Stub entrypoints: background, sidepanel, cart.content, checkout.content.
- ESLint: FR-6 click/submit ban outside `src/runner/clickAllowList.ts`; NFR-7 purity rules for `src/core/**` and `src/sim/**`.

## T2 Core types and money
- `src/core/types.ts`: design §4 types plus `ParseError` and `Result<T, E>`.
- `src/core/money.ts`: exact string-based `parseFen` (full-width, NBSP, signs, thousands commas; rejects >2 decimals, ambiguous formats), `formatCny`, `toCad` (half away from zero, validated FX inputs), `formatCad`.
- `src/core/selection.ts`: mask <-> lineIds helpers, canonical keys (n ≤ 20).

## T3 Pricing simulator
- `src/core/rng.ts`: seeded mulberry32 `createRng(seed)` with `next/int/chance/pick/shuffle`.
- `src/sim/simulator.ts`: `PricingSimulator implements ProbeClient` (shop freight templates by amount/count/always-free, 满减 reducing G, tiered consolidation brackets + weight limit + packing, single-use platform coupons, deterministic hashed ±¥1 noise, `probeCount`, `inject` failure hook). Own brute-force ground truth: `trueOptimumA` (single-use coupon assignment, FR-7.3 tie-break), `trueOptimumB` (exact ratio compare, FR-8.2), `trueOverhead`.
- `src/sim/randomCart.ts`: `randomCart(seed, n, shops?)` realistic generator tuned so ~36% of n=10 carts have a non-{U} A-optimum (kMax 3).
- Tests in `test/sim/*` and `test/core/rng.test.ts`.
