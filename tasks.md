# Taobao Consolidation Shipping Optimizer — Task Plan

Version 0.1 · 2026-10-17
For a coding agent. Read `specs.md` and `design.md` first; requirement IDs refer to them.

## Ground rules for the coding agent
1. Build in the order below. Tasks marked **[HUMAN]** need the user; stop and ask instead of guessing.
2. The agent cannot access Taobao. Never invent Taobao selectors, URLs or page text; use only sanitized fixtures from T10. Until then, write adapters against the interfaces and leave `selectors.ts` with `TODO(T10)` entries.
3. `src/core` and `src/sim` must not import DOM or `chrome.*` APIs.
4. Money is integer fen everywhere in code.
5. Never write code that clicks outside `clickAllowList.ts` (lint-enforced from T1).
6. Each task ends with: tests passing, `npm run lint` clean, short note in `CHANGELOG.md`.

---

## Phase 1 — Foundations

### T1 Scaffold
- WXT + TypeScript strict, Preact, Vitest, happy-dom, Playwright, ESLint/Prettier, `idb`.
- Entry points: background, sidepanel, `cart.content.ts`, `checkout.content.ts` (empty stubs).
- ESLint `no-restricted-syntax` rule banning `.click(`, `.submit(`, `.requestSubmit(` outside `src/runner/clickAllowList.ts`; ban `chrome` and `document` in `src/core/**` and `src/sim/**`.
- Scripts: `dev`, `build`, `test`, `bench`, `e2e`, `lint`.
- **Done when:** extension builds and loads unpacked; CI-style `npm test` runs (zero tests OK).

### T2 Core types and money
- `core/types.ts` per design §4; `core/money.ts` (parse "¥1,234.50"/"1234.5" → fen, format, CNY→CAD with card fee); `core/selection.ts` (mask ↔ lineIds, canonical keys).
- **Done when:** unit tests cover parsing edge cases (commas, full-width ¥, missing decimals, negative discounts) and CAD rounding.

### T3 Pricing simulator
- `sim/simulator.ts` and `sim/randomCart.ts` per design §11.1, seeded RNG, implements `ProbeClient`.
- Provides `trueOptimumA(cart, kMax)` and `trueOptimumB(cart, bMin)` by brute force (n ≤ 10).
- **Done when:** tests confirm free-shipping thresholds, first-weight pricing, weight-limit infeasibility, and single-use coupon behavior.

## Phase 2 — Search engine (pure)

### T4 Cost, partitions, ranking
- `cost.ts` (overhead, objectives, coupon adjustment FR-9), `partitions.ts` (restricted-growth enumeration, k ≤ K_MAX), `rank.ts` (tie-breaks FR-7.3, FR-8.2; savings vs baseline).
- **Done when:** partition counts match Stirling numbers for n ≤ 7; coupon-adjust tests from FR-9.2 pass.

### T5 Exhaustive engine
- `search/engine.ts` interface: `next(): Selection | null`, `observe(sel, result)`, `done()`, `results()`, `serialize()`, `static restore(state)`.
- `search/exhaustive.ts` with probe order per design §7.1 and handling of infeasible/error results.
- **Done when:** for 300 random simulator carts with n ≤ 6, results for A and B equal brute force; serialize/restore mid-run yields identical results.

### T6 Prediction model
- `search/model.ts`: domestic predictor, rate-table mode, marginal mode, α/β fitting, "uncalibrated" flag (design §7.3).
- **Done when:** on simulator data the model reproduces probed quotes exactly, and on unprobed multi-item selections the median absolute error of predicted overhead is reported by a test (no hard threshold; logged for tuning).

### T7 Heuristic engine and local search
- `search/localSearch.ts` (design §7.6) and `search/heuristic.ts` (phases + verify loop, design §7.2/§7.4). Ineligible singleton handling.
- **Done when:** unit tests pass on hand-built scenarios (threshold in one shop, coupon conflict, overweight full cart).

### T8 Top-down greedy (objective B option)
- `search/topDownGreedy.ts` per design §7.7.
- **Done when:** on simulator carts it never returns a result with ratio worse than the baseline and respects the budget.

### T9 Benchmark
- `npm run bench`: 200 random carts at n = 8, 10, 12 for A and B; reports optimum-hit rate, gap distribution, mean probes.
- Tune candidate generation and verify-loop ε until specs §8 criterion 4 holds at n = 10. Record the final numbers in `BENCHMARK.md`.
- **Done when:** criterion 4 met and documented.

## Phase 3 — Discovery

### T10a Fixture capture tool
- `adapters/sanitize.ts`: clone DOM, strip scripts, replace names/phones/addresses/user IDs/order tokens with placeholders, keep structure, classes, and amounts.
- Side panel debug command "Capture this page" → downloads `{pageType}-{timestamp}.html`.
- **Done when:** sanitizer tests show no 11-digit phone patterns, no address text from a synthetic page, and amounts preserved.

### T10 [HUMAN] Capture fixtures and resolve assumptions
The user, logged into desktop taobao.com with the consolidation address set:
1. Capture the cart page (≥ 2 shops, ≥ 4 items, one invalid item if available).
2. From the cart, select 1 item → checkout with the consolidation address → capture. Repeat with 2 items from one shop, and with items from 2 shops.
3. Capture a checkout where an item can't use consolidation, if one exists.
4. If a verification slider/CAPTCHA or login prompt ever appears, capture it.
5. Record the exact cart and checkout hosts/URLs (redact tokens).
6. Answer specs §4 A-1…A-7 in `ASSUMPTIONS.md` (with screenshots where useful), especially: does the checkout page show the consolidation fee before paying for goods (A-2)? Does closing the checkout page leave any trace in orders or coupons (A-5)?
- **Agent's part:** review fixtures, update `ASSUMPTIONS.md` with findings, and flag any assumption that breaks the design. If A-1 or A-2 is false, **stop and report** before Phase 4.

## Phase 4 — Adapters

### T11 Cart adapter
- `adapters/cart/{selectors,parse,actions}.ts` from fixtures: `read`, `setSelection`, `goCheckout` (design §5.1).
- **Done when:** fixture tests parse every field correctly; `setSelection` works on the mock site (after T13) including verification of the selected count.

### T12 Checkout adapter, blocked detection, guard
- `adapters/checkout/*`, `adapters/blocked.ts`, `guard.ts` (design §5.2–5.3), address verification, infeasibility detection, stability wait, NFR-4 cross-check.
- **Done when:** fixture tests produce exact `Quote`s; blocked fixtures detected; guard tests show submit control clicks, Enter key, `form.submit()` and `requestSubmit()` are all blocked in probe mode and **not** blocked in a non-probe tab.

### T13 Mock Taobao site
- `/mock-taobao`: cart and checkout pages reproduced from fixture markup (structure and class names), amounts computed by the simulator, a submit endpoint that counts hits, toggles for blocked page, address mismatch, slow rendering, infeasible item.
- **Done when:** the mock serves deterministic pages for a seeded cart and adapters parse them identically to the real fixtures.

## Phase 5 — Runner

### T14 Probe runner and run controller
- `runner/probeRunner.ts` (state machine, timeouts, cache-first, delays), `runner/rateLimiter.ts`, `runner/runController.ts` (loop, budgets, consecutive-error stop, blocked pause/resume, restore selection, persistence after each probe), `storage/*`.
- **Done when:** unit tests with a fake tab driver cover every state transition; budgets and daily cap enforced; resume after panel reload continues from saved engine state.

### T15 Safety test suite
- Tests for FR-6 against fixtures and the mock: allow-list refuses non-allowed elements; guard blocks all submit paths; a deliberately malicious engine that proposes clicking submit cannot cause a hit on the mock submit endpoint.
- **Done when:** all pass; included in `npm test` and `npm run e2e`.

## Phase 6 — UI

### T16 First-run setup and settings
- Screens 1 and 5 of design §10; settings bounds enforced (FR-12.3, 12.4); optional FX fetch behind a toggle.

### T17 Setup and progress screens
- Screens 2 and 3; planned probe count and ETA (`exhaustive: 2^n−1`; heuristic: `1+n+shops` plus verify budget); Stop; blocked banner with Resume.

### T18 Results and apply
- Screen 4; result cards (FR-11.2); exact/best-found badge; Apply for B; group checklist for A (apply each group in turn; the extension never proceeds to checkout).
- **Done when:** component tests render simulator results; Apply sets the mock cart selection correctly.

### T19 Debug view
- Last N probes, parse warnings, model calibration mode, daily counter (FR-14.2).

## Phase 7 — Integration

### T20 E2E suite
- Playwright scenarios from design §11.3 against the mock site.
- **Done when:** all scenarios pass; mock submit-hit counter is 0 in every scenario.

### T21 [HUMAN] Live smoke test
- Agent prepares a checklist; the user runs it on the real cart with 3 items / 2 shops, objective A then B, default delays.
- Verify: results match the checkout page when a result is applied and checkout opened manually (specs §8 criterion 1); cart selection restored; no new orders (criterion 2).
- Agent fixes issues from the user's report and adds a fixture/test for each.

### T22 (Post-MVP) Quote vs final fee log
- FR-13.2: after the user pays the consolidation fee, they enter it against the run's chosen group; the debug view shows the checkout-quote error distribution.

---

## Dependency summary
```
T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9
T1 → T10a → T10[HUMAN] → T11, T12 → T13 → T14 → T15 → T16..T19 → T20 → T21[HUMAN] → T22
(Phase 2 can run in parallel with T10a/T10.)
```
