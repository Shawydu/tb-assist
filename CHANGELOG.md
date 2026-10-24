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

## T4 Cost, partitions, ranking
- `src/core/partitions.ts`: restricted-growth enumeration (`partitions`, `partitionsOfMasks`, `countPartitions`, `stirling2`); canonical blocks sorted by lowest bit.
- `src/core/cost.ts`: `overhead`, `objectiveA` (FR-9.2 conservative coupon adjustment, null if unquoted, Infinity if infeasible), `objectiveB` (null if G < bMin, G <= 0, infeasible, unquoted).
- `src/core/rank.ts`: `rankA` (cost, groups, ΣT, key; dedupe; savings vs {U}), `rankB` (exact integer ratio compare, larger G, smaller O, mask; savings note).
- Tests: Stirling/Bell counts n <= 7, coupon cases, tie-breaks, simulator cross-check vs `trueOptimumA`.

## T5 Exhaustive engine
- `src/core/search/engine.ts`: `SearchEngine` interface, `EngineState` (versioned union), `createEngine(items, params, savedState?)` (validates n 1..20 and params; n > nExh throws "heuristic engine not implemented (T7)"; saved state must match lineIds and params).
- `src/core/search/exhaustive.ts`: probe order U, singletons, rest by popcount; `results()` returns A and B from verified quotes, `exact` only when all 2^n-1 masks are probed; state is `{ v: 1, kind: 'exhaustive', lineIds, nExh, kMax, bMinValue, rShow, quotes }`.
- `src/core/search/drive.ts`: `driveEngine(engine, client, maxProbes)` test/bench loop (design §6 semantics).
- Tests: `test/core/search/exhaustive.test.ts` (300 random carts vs brute force, order, contract, serialize/restore, drive failures).

## T6 Prediction model
- `src/core/search/model.ts`: `buildModel(items, quotes, rateTable?)` -> `PredictionModel { predictO, predictG, mode, calibrated, params }`; also exports `rateFn`, `invertRate`. Cheap to rebuild after every probe.
- Domestic per shop per design §7.3 (observed pairs, max-of-singletons base, full-shop and subset threshold rules; subset rule ignores singleton subgroups). International: rate-table mode (invert singletons, alpha grid 0.6..1.1/0.02; off-lattice falls back to marginal with `calibrated=false`) or marginal mode (F0 = min fee, beta grid 0.4..1.4/0.02); overhead-only mode when no quote has a breakdown.
- Shipping discounts, coupons, other fees/tax are not predicted for unprobed masks (documented in file header); observed quotes are returned exactly; observed-infeasible and masks with an infeasible singleton give Infinity.
- Tests: `test/core/search/model.test.ts` (17), incl. a logged accuracy report (100 carts, n=10, after U + singletons + shop groups).

## T7 Heuristic engine and local search
- `src/core/search/localSearch.ts`: `candidatesA(ctx, extraSeeds)` / `candidatesB(ctx, extraSeeds)` (design §7.6): seeds (U, by-shop merged to kMax, best 2-split, verified best; B: shops and greedy-by-R prefixes), best-improvement hill climbing (relocate/swap/merge/split-shop-out; B add/remove/swap/whole-shop), 20 seeded restarts, top 50 distinct canonical candidates. About 1-5 ms at n = 12..20.
- `src/core/search/heuristic.ts`: `createHeuristicEngine`, wired into `createEngine` for n > nExh. Phases: U, singletons, reduced set E (only if some item is ineligible), shop groups, then one-probe verify loop (model rebuilt each step, epsilon = max(1%, ¥1) vs rShow-th verified). Engine stops at `params.maxProbes` non-cached probes. State `{ v: 1, kind: 'heuristic', lineIds, objective, kMax, bMinValue, rShow, seed, observed: [{quote, cached}] }`; restore replays deterministically (RNG reseeded per step from seed and probe count). `exact` is always false.
- `results()` also returns `ineligible?: string[]` (types.ts `EngineResults`, `Run.results`); A partitions cover only eligible items. `SearchParams.seed?` added.
- Verified A results come from exact enumeration of partitions whose blocks are all quoted, not from the candidate pool.
- Supersets of an observed-infeasible mask are treated as infeasible by the search (not by the model).
- Tests: `test/core/search/heuristic.test.ts`, `localSearch.test.ts`.

## T8 Top-down greedy (objective B)
- `src/core/search/topDownGreedy.ts`: `createTopDownGreedyEngine(items, params, saved?)`, design §7.7. Probes U, then S\{i} for each i in S, moves to the best (FR-8.2 ties, exact cross-multiplication) while R strictly improves; R(S)=Infinity if S infeasible or G < bMin. Next probe is derived from the observed quotes alone, so state is `{ v: 1, kind: 'topDownGreedy', lineIds, kMax, bMinValue, rShow, observed: [{quote, cached}] }`. At most n(n+1)/2 + 1 probes; stops at `params.maxProbes` non-cached probes.
- Candidates with gross value (sum unitPrice * qty, an upper bound of G) below bMinValue are skipped unprobed.
- `createEngine`: `objective === 'B' && strategyB === 'topDownGreedy' && n > nExh` -> topDownGreedy; restore checks `state.kind`. `EngineState` union extended.
- `results()`: B from all verified quotes; A only from partitions whose blocks are all quoted (usually sparse).
- Tests: `test/core/search/topDownGreedy.test.ts` (100 carts, budgets 10/20/80, contract, restore, hand-built path, logged hit rate at n = 10).

## T9 Benchmark and tuning
- `scripts/bench.ts` rewritten (flags `--n --seeds --obj --rate --maxProbes --bMin --kMax --greedy --quiet --fails`), markdown output.
- New `src/core/search/feeModel.ts` (latent weight fee model) and `exhaustiveCands.ts` (exhaustive EI-ranked candidates); `model.ts` latent mode; `heuristic.ts` uses full budget (stop rule removed), soft fallback.
- Tests: `test/core/search/feeModel.test.ts`, `exhaustiveCands.test.ts`.
- Result (eval seeds 1-200, n=10): B 98.5% hit / 99.0% within 3% (criterion met); A 83.6% / 92.1% (criterion NOT met). See `BENCHMARK.md`.
