# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Pre-implementation. The repo contains only three planning documents, read in this order: `specs.md` (requirements, FR-/NFR-/A- IDs) → `design.md` (architecture, module layout, algorithms) → `tasks.md` (build order T1–T22). No code, git repo, or build tooling exists yet. Follow `tasks.md` order; tasks marked **[HUMAN]** (T10, T21) need the user, so stop and ask instead of guessing.

## What it is

A Chrome MV3 extension (desktop only, no backend) for a Canadian Taobao shopper using Taobao official consolidation (官方集运). It probes the real checkout page for combinations of cart items and ranks them:
- **Objective A:** partition items into ≤ `K_MAX` checkout groups minimizing the sum of overhead `O(S) = T(S) − G(S)` (grand total minus goods net).
- **Objective B:** the subset with `G ≥ B_MIN_VALUE` that minimizes `O/G`.

Only verified costs (built from real probed quotes) are ever shown. Model predictions are internal and only choose what to probe next.

## Planned stack and commands (from design §2 / tasks T1)

TypeScript strict, WXT (MV3), Preact, `idb`, Vitest + happy-dom, Playwright (against `/mock-taobao`), ESLint + Prettier. Planned scripts: `dev`, `build`, `test`, `bench`, `e2e`, `lint`. These don't exist until T1 is done. Each task ends with tests passing, `npm run lint` clean, and a note in `CHANGELOG.md`.

## Architecture (big picture)

- **The run lives in the side panel, not the service worker.** MV3 workers die when idle, and the 6–12 s probe delays make that likely. The side panel hosts the run controller, ProbeRunner, SearchEngine and storage. Run state is persisted after every probe so a closed panel can resume. The background worker only enables the panel (cart host only) and routes messages.
- **Probe** = set cart selection to exactly `S` → click cart checkout → read the quote from the checkout page → navigate the probe tab back to the cart URL with `chrome.tabs.update`. This runs in a dedicated inactive extension-owned tab. Single-flight, never parallel.
- **`src/core` and `src/sim` are pure TS**: no DOM or `chrome.*` (lint-enforced). Search engines implement `next() / observe() / done() / results() / serialize() / restore()` against a `ProbeClient` interface that both the real ProbeRunner and the pricing simulator implement.
- **Search:** `n ≤ N_EXH` (6) is exhaustive over all 2^n−1 masks (full set first, then singletons). Larger `n` uses the heuristic: probe `U`, singletons, per-shop groups, calibrate the model, then a one-probe-at-a-time verify loop with local-search candidate generation (seeded RNG). Objective B can use top-down greedy. Coupon conflicts across groups are handled conservatively (FR-9).
- **Adapters** (`src/adapters/{cart,checkout}`) are split into `selectors.ts` (the only place with selectors, with primary and fallback entries), pure `parse.ts` (fixture-tested) and `actions.ts`. `blocked.ts` detects captcha, login and risk pages.
- **Pricing simulator (`src/sim`)** is the test oracle and also backs `/mock-taobao` for Playwright E2E.

## Hard rules

- **Never submit an order or touch payment controls (FR-6).** Enforced structurally:
  - Every click goes through `src/runner/clickAllowList.ts` (purposes `cartCheckbox` and `cartCheckout` only). ESLint bans `.click(`, `.submit(`, `.requestSubmit(` elsewhere.
  - A capture-phase guard (`guard.ts`) in the probe tab only blocks submit/pay events and `form.submit()` (MAIN-world override). Non-probe tabs must stay unaffected.
  - Safety tests (T15) and E2E require the mock submit endpoint hit count to be 0.
- **Never invent Taobao selectors, URLs or page text.** The agent can't access Taobao. Until real sanitized fixtures arrive from T10, leave `selectors.ts` entries as `TODO(T10)`.
- **Money is integer fen** everywhere. Show CNY as the source of truth, with CAD beside it (`fen/100 × fxRate × (1 + cardFxFee)`).
- **A-1/A-2 gate:** if the T10 findings show a consolidation order isn't one parcel per checkout (A-1), or the checkout doesn't show the consolidation fee before payment (A-2), stop and report before Phase 4.
- **Politeness and privacy:** probe delay ≥ 4 s (default 6–12 s), per-run cap ≤ 150, per-day cap ≤ 400, stop immediately on `blocked`, stop after 2 consecutive errors, and no network calls except the optional FX fetch. Cached quotes don't consume the probe budget. Restore the original cart selection when a run ends (FR-3.5).
- **Parse failures must name the field**, never yield a wrong number. Cross-check `T` against the sum of its components (NFR-4).
- **MVP acceptance (specs §8):** the heuristic at n = 10 must hit the true optimum in ≥ 90% of 200 random simulator carts within 80 probes (and be within 3% of optimal in ≥ 98%). Record the numbers in `BENCHMARK.md`.

## Coding standards
- Use TypeScript strict mode
- Prefer async/await over promise chains
- Run tests before committing
