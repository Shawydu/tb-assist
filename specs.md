# Taobao Consolidation Shipping Optimizer — Requirements Spec

Version 0.1 · 2026-10-17
Companion documents: `design.md` (how), `tasks.md` (build order). Read in order: specs → design → tasks.

---

## 1. Purpose

A Chrome extension for a Canadian Taobao shopper who uses **Taobao's official consolidation (官方集运)**. Given the items in the shopping cart, it asks Taobao for **real shipping quotes** on combinations of those items and ranks the combinations from best to worst under two objectives:

- **Objective A — Cheapest full shipment:** split the in-scope items into one or more checkout groups so that the **total overhead** of shipping everything is minimal.
- **Objective B — Most efficient batch:** find the subset of in-scope items with the **lowest overhead per ¥ of goods**, so the user ships the most efficient batch now and leaves the rest in the cart.

The only source of truth for prices is the **consolidation checkout page**. The tool never displays an estimated cost as if it were a real quote.

## 2. Scope

### In scope (MVP)
- Reading the Taobao desktop web cart.
- Changing the cart's item selection (checkboxes) programmatically.
- Opening the consolidation checkout page for a selection and reading the quote.
- Searching over combinations of in-scope cart items (subsets and partitions).
- Ranking results under objective A or B and applying a chosen selection back to the cart.
- Local storage of quotes, runs and settings.

### Out of scope
- Searching or crawling Taobao for other items or sellers. No item-page parsing.
- Changing item quantities or variants (SKUs). Quantities are taken from the cart as-is.
- Submitting orders or paying. **The tool must never submit an order** (see FR-6).
- Third-party forwarders, sea vs air selection beyond what the checkout page offers by default, Canadian duty calculation.
- Mobile app, other browsers, any backend server, multi-user features.

## 3. Glossary

| Term | Meaning |
|---|---|
| Cart item | One cart line: item + SKU + quantity, identified by Taobao's cart line ID. |
| In-scope set `U` | The cart items the user chose to analyze (default: the items currently ticked in the cart). `n = |U|`. |
| Selection / subset `S` | A set of cart items ticked together for one checkout. |
| Consolidation checkout page | The order confirmation page (下单/确认订单页) reached from the cart with the user's consolidation (集运) address selected. The user also calls this the "consolidation payment page". |
| Probe | One automated round trip: set cart selection = `S` → open the checkout page → read the quote → leave without submitting. |
| Quote `Q(S)` | The structured numbers read from the checkout page for selection `S`. |
| Goods net `G(S)` | Goods subtotal for `S` after item-level discounts (shop 满减, item coupons) as displayed. |
| Grand total `T(S)` | The amount payable shown on the checkout page for `S`. |
| Overhead `O(S)` | `T(S) − G(S)`: everything the user pays beyond the goods, i.e. domestic freight to the warehouse, the consolidation/international fee, other fees, minus shipping discounts, plus any tax shown. |
| Partition `P` | A split of `U` into disjoint non-empty groups `{S1..Sk}` that cover `U`. |
| Verified | A cost computed only from real quotes (every group of a partition has been probed). |
| Predicted | A cost produced by the internal model. Used only to choose what to probe next; never shown as a result. |

## 4. Assumptions to verify (resolved in task T10)

| ID | Assumption | If false |
|---|---|---|
| A-1 | Each checkout with the consolidation address produces one consolidation order that is shipped as one parcel; separate checkouts produce separate parcels. | Objective A's cost model changes (parcels are formed at the warehouse). Revisit design §7 before building search. |
| A-2 | The checkout page shows the consolidation/international fee (or an estimate of it) **before** paying for the goods. | If it is only charged after weighing, the "source of truth" moves to a page that cannot be probed per combination; stop and re-scope. |
| A-3 | Selecting items in the cart and clicking checkout navigates to a checkout page whose content reflects exactly the selected items. | Adapter design changes; the probe may need to build the checkout URL directly. |
| A-4 | The checkout page lets us read per-shop domestic freight, the consolidation fee, discounts and the grand total as separate labeled values. | Fall back to `O(S) = T(S) − G(S)` only (already the primary definition). |
| A-5 | Visiting the checkout page without submitting has no side effects (no order created, no coupon consumed, no stock locked beyond Taobao's normal behavior). | Reduce probe budget defaults and add a warning in the UI. |
| A-6 | The checkout page indicates items that cannot be consolidation-shipped, or exceed weight/size limits, with a detectable message. | Treat any unparseable checkout page as a failed probe. |
| A-7 | Platform/consolidation coupons applied on the checkout page are identifiable (name and/or amount) so that conflicts across groups can be detected (FR-9). | Coupon-conflict handling degrades to a warning only. |

## 5. Functional requirements

### FR-1 Cart reading
- FR-1.1 On `cart.taobao.com` (exact host list confirmed in T10), the extension parses every cart line into a `CartItem` (design §4): cart line ID, item ID, SKU ID, shop ID, shop name, title, unit price, quantity, selected state, and whether it is selectable (not invalid/out of stock).
- FR-1.2 Parsing must not depend on a single brittle selector; each field has a primary and a fallback strategy, and parse failures are reported per field.
- FR-1.3 The parser never sends cart data off the device.

### FR-2 Scope selection
- FR-2.1 The side panel lists cart items grouped by shop with checkboxes; default checked = items currently ticked in the cart.
- FR-2.2 Hard cap `n ≤ 20`. The UI warns above `N_WARN = 12` that results come from the heuristic search and take longer.
- FR-2.3 The user picks the objective (A or B) and, for B, the minimum batch value `B_MIN_VALUE` (default ¥100).
- FR-2.4 Before starting, the UI shows the planned probe count range and an ETA.

### FR-3 Probing
- FR-3.1 A probe for selection `S` sets the cart selection to exactly `S`, opens the consolidation checkout page, parses a `Quote`, and returns to the cart without submitting.
- FR-3.2 Probes run in a dedicated, non-active browser tab owned by the extension. The user's own tabs are never driven.
- FR-3.3 Before reading a quote, the probe verifies the selected shipping address is the configured consolidation address (match rule configured in T10). If not, the run aborts with a clear message; no quote is recorded.
- FR-3.4 A probe results in one of: `ok`, `infeasible` (page states the selection cannot ship, e.g. ineligible item, over weight/size), `blocked` (CAPTCHA, slider verification, login redirect, risk page), `error` (timeout, parse failure).
- FR-3.5 After a run ends (complete, stopped, or aborted), the cart selection is restored to what it was before the run.

### FR-4 Rate limiting and stop conditions
- FR-4.1 Delay between probes: uniform random in `[PROBE_DELAY_MIN, PROBE_DELAY_MAX]` (default 6–12 s).
- FR-4.2 Per-run probe cap `MAX_PROBES_PER_RUN` (default 80) and per-day cap `MAX_PROBES_PER_DAY` (default 200).
- FR-4.3 On a `blocked` result the run stops immediately, the probe tab is brought to the front so the user can resolve it, and the run can be resumed manually. No automatic retry.
- FR-4.4 Two consecutive `error` results stop the run.
- FR-4.5 The user can stop a run at any time; partial results remain available.

### FR-5 Quote cache
- FR-5.1 Quotes are cached by key `(sorted cart line IDs with qty and unit price, address ID, local date)`.
- FR-5.2 Default TTL 12 h; a cached quote is invalid if any included line's price or quantity changed.
- FR-5.3 Cached quotes count toward results without re-probing; the UI shows the quote age.

### FR-6 Order-submission safety (non-negotiable)
- FR-6.1 The extension must never click, dispatch events to, or programmatically trigger the submit-order control (提交订单) or any payment control.
- FR-6.2 Enforcement is structural: an allow-list of the only elements the extension may click (cart checkboxes, cart checkout button, navigation back). Any other click attempt throws and stops the run.
- FR-6.3 While a probe tab is on the checkout page, a capture-phase guard blocks submit/payment controls and form submission in that tab, even if triggered by page scripts reacting to extension activity.
- FR-6.4 Automated tests prove FR-6.1–6.3 against fixtures (see tasks T15).

### FR-7 Objective A — cheapest full shipment
- FR-7.1 Find partitions `P = {S1..Sk}` of `U` with `1 ≤ k ≤ K_MAX` (default 3) minimizing `Cost_A(P) = Σ O(Sj)`.
- FR-7.2 Any group with an `infeasible` quote makes the partition infeasible.
- FR-7.3 Tie-break: fewer groups, then lower `Σ T(Sj)`.
- FR-7.4 The baseline is the single-group partition `{U}` (always probed). Results show savings vs baseline.
- FR-7.5 If `{U}` itself is infeasible, the baseline is "none" and only feasible partitions are listed.

### FR-8 Objective B — most efficient batch
- FR-8.1 Find subsets `S ⊆ U` with `G(S) ≥ B_MIN_VALUE` minimizing the ratio `R(S) = O(S) / G(S)`.
- FR-8.2 Tie-break: larger `G(S)`, then lower `O(S)`.
- FR-8.3 The baseline is `S = U`. Results show the baseline ratio and each result's ratio and absolute overhead.

### FR-9 Coupon conflicts (objective A)
- FR-9.1 Each quote records the platform/consolidation coupons applied (identifier and amount, when shown).
- FR-9.2 If two or more groups of a partition rely on the same coupon, only one group may keep it. The partition's cost is adjusted conservatively: keep the coupon on the group where it saves the most and add the coupon amount back to the others.
- FR-9.3 Adjusted partitions are marked "coupon-adjusted" in the results with an explanation.

### FR-10 Search
- FR-10.1 If `n ≤ N_EXH` (default 6), probe every non-empty subset (exhaustive). Objective A enumerates all partitions with `≤ K_MAX` groups from the quotes; objective B ranks all subsets. Results are exact.
- FR-10.2 If `n > N_EXH`, use the heuristic probe–model–verify search (design §7) within the probe budget.
- FR-10.3 Only verified results appear in the ranked list. The model's predictions are internal.
- FR-10.4 The search reports whether results are exact (exhaustive) or best-found (heuristic).
- FR-10.5 Optional strategy for B: "top-down greedy" (start from `U`, repeatedly drop the item whose removal gives the best real `R`, stop when no removal improves or `G < B_MIN_VALUE`).

### FR-11 Results and apply
- FR-11.1 The results view lists the top `R_SHOW` (default 5) verified results, ranked from best down.
- FR-11.2 Each result shows: groups (A) or subset (B) with item titles and shop names; per group `G`, `O`, `T`; domestic freight and consolidation fee when parsed separately; coupons; total; savings vs baseline; quote age; coupon-adjusted flag.
- FR-11.3 Amounts are shown in CNY (source of truth) with CAD conversion beside them, using the configured FX rate and card FX fee (FR-12).
- FR-11.4 "Apply" sets the cart selection to a result's subset (B) or to a chosen group (A). For A, the panel tracks groups as a checklist ("Apply group 1 → check out yourself → Apply group 2"). The extension never proceeds to checkout itself after Apply.

### FR-12 Settings
- FR-12.1 Consolidation address match rule (e.g. recipient name or address substring), set during first-run setup.
- FR-12.2 FX: manual CNY→CAD rate, plus card FX fee % (default 2.5%). Optional fetch of the Bank of Canada daily CNY rate (series and endpoint verified at implementation time).
- FR-12.3 Probe budget and delay settings within safe bounds: delay min ≥ 4 s, per-run cap ≤ 150, per-day cap ≤ 400.
- FR-12.4 Search parameters: `N_EXH` (≤ 7), `K_MAX` (≤ 4), `B_MIN_VALUE`, `R_SHOW`.
- FR-12.5 Optional rate table for the internal model (first weight, first fee, step weight, step fee). Used only for prediction.

### FR-13 Run history and quote log
- FR-13.1 Every run is stored with its settings, quotes, and ranked results.
- FR-13.2 Per checkout the user actually placed, the user can later enter the final consolidation fee paid after weighing; the log shows checkout quote vs final fee to measure quote reliability. (Post-MVP, task T22.)

### FR-14 Diagnostics and fixture capture
- FR-14.1 A developer "capture" command saves the current cart or checkout page DOM as a sanitized HTML snapshot (names, phone numbers, addresses, user IDs replaced with placeholders) for use as test fixtures.
- FR-14.2 A debug view shows the last N probes with status, parse warnings, and timing.

## 6. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 Privacy | All data stays on device (`chrome.storage` / IndexedDB). No analytics, no telemetry, no remote servers. The only network call the extension itself makes is the optional FX fetch. |
| NFR-2 Permissions | Minimum manifest permissions: `storage`, `sidePanel`, `tabs`, `scripting`; host permissions only for the confirmed Taobao cart/checkout hosts and the FX endpoint. |
| NFR-3 Robustness | Adapters isolate selectors in one file per page type, with fixture tests. A parse failure produces a clear error naming the field, never a wrong number. |
| NFR-4 Numeric correctness | Money is handled in integer fen (¥0.01) internally. Parsed amounts are cross-checked: `T(S)` must equal the sum of displayed components within ¥0.01 when components are available, otherwise the quote is flagged. |
| NFR-5 Politeness | Never exceed FR-4 limits; never run probes in parallel. |
| NFR-6 Resumability | Run state is persisted after every probe; closing and reopening the side panel resumes or offers to resume. |
| NFR-7 Testability | The search engine is pure TypeScript with no DOM/Chrome dependencies and is tested against a pricing simulator. |
| NFR-8 Language | UI in English; parsers must handle both Chinese and English Taobao page variants if both exist (confirmed in T10). |

## 7. Configuration defaults

| Key | Default | Bounds |
|---|---|---|
| `PROBE_DELAY_MIN` / `MAX` | 6 s / 12 s | min ≥ 4 s |
| `MAX_PROBES_PER_RUN` | 80 | ≤ 150 |
| `MAX_PROBES_PER_DAY` | 200 | ≤ 400 |
| `QUOTE_TTL` | 12 h | 1–48 h |
| `N_EXH` | 6 | 1–7 |
| `N_WARN` | 12 | — |
| `n` hard cap | 20 | — |
| `K_MAX` | 3 | 1–4 |
| `B_MIN_VALUE` | ¥100 | ≥ 0 |
| `R_SHOW` | 5 | 1–20 |
| Card FX fee | 2.5 % | 0–5 % |

## 8. MVP acceptance criteria

1. On a real cart of 3 items across 2 shops, a run completes, restores the cart selection, and shows ranked A and B results whose numbers match the checkout page exactly when the selection is applied and checkout is opened manually.
2. No order is ever created during any run (verified by the user's order list after the live smoke test).
3. On the mock Taobao site, a `blocked` page stops the run within one probe.
4. On the pricing simulator, for random carts with `n ≤ 6`, results equal brute force exactly; for `n = 10`, the heuristic finds the true optimum (A and B separately) in ≥ 90% of 200 random carts within 80 probes, and its best result is within 3% of optimal in ≥ 98%.
5. All core and adapter tests pass in CI; the submit-guard tests pass.
