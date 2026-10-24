# Taobao Consolidation Shipping Optimizer — Design

Version 0.2 · 2026-10-23
Implements `specs.md`. Requirement IDs (FR-x, NFR-x, A-x) refer to that document.

v0.2 review changes: `fromCache` on `ProbeResult` and budget accounting for failed probes (§4, §6); single engine factory (§7); exhaustive over-budget handling (§7.1); fail-closed submit guard (§5.2–5.3); hidden-tab throttling risk (§5.2, §12).

---

## 1. Overview

```
 ┌──────────────────────────── Chrome (desktop) ────────────────────────────┐
 │                                                                          │
 │  Side panel (extension page)            Probe tab (inactive, ext-owned)  │
 │  ┌──────────────────────────┐   tabs    ┌──────────────────────────────┐ │
 │  │ UI (setup/progress/      │──────────▶│ cart.taobao.com              │ │
 │  │      results/settings)   │  messages │  └ cart content script       │ │
 │  │ Run controller           │◀─────────▶│ buy.taobao.com (checkout)    │ │
 │  │  ├ ProbeRunner           │           │  └ checkout content script   │ │
 │  │  ├ SearchEngine (core)   │           │     + submit guard           │ │
 │  │  └ Storage (IndexedDB)   │           └──────────────────────────────┘ │
 │  └──────────────────────────┘                                            │
 └──────────────────────────────────────────────────────────────────────────┘
```

Flow of one run:
1. User opens the side panel on the cart page, picks in-scope items and objective.
2. The **run controller** creates a probe tab and asks the **SearchEngine** for the next selection to probe.
3. The **ProbeRunner** performs the probe (set selection → checkout → parse quote → back), waits the jittered delay, returns the `ProbeResult`.
4. The SearchEngine updates its state and proposes the next probe, until it reports done or the budget is exhausted.
5. The controller restores the original cart selection, closes the probe tab, stores the run, and shows ranked verified results.

**Why the run lives in the side panel, not the service worker:** MV3 service workers are terminated when idle, and the 6–12 s delays make that likely. The side panel is an extension page that stays alive while open and has full `chrome.tabs` / `chrome.scripting` access. Run state is persisted after every probe (NFR-6), so closing the panel pauses the run and reopening offers resume. The service worker only handles panel enablement and message routing.

## 2. Tech stack

| Concern | Choice |
|---|---|
| Language | TypeScript, `strict: true` |
| Extension framework | WXT (Manifest V3). Acceptable alternative: Vite + `@crxjs/vite-plugin`. |
| UI | Preact (or React) + plain CSS modules; no heavy UI kit |
| Storage | IndexedDB via `idb` (runs, quotes, logs); `chrome.storage.local` for settings |
| Unit tests | Vitest; `happy-dom` for adapter fixture tests |
| E2E | Playwright with the unpacked extension loaded against a local mock Taobao site |
| Lint/format | ESLint + Prettier |

## 3. Module layout

```
/src
  /core                 # pure TS, no DOM/chrome imports (NFR-7)
    money.ts            # fen integers, parse/format, CNY→CAD
    types.ts            # domain types (§4)
    selection.ts        # bitmask helpers, selection keys
    cost.ts             # overhead, objectives, coupon-conflict adjustment
    partitions.ts       # set-partition enumeration with k ≤ K_MAX
    search/
      engine.ts         # SearchEngine interface + factory
      exhaustive.ts     # FR-10.1
      heuristic.ts      # FR-10.2 probe–model–verify
      topDownGreedy.ts  # FR-10.5
      model.ts          # domestic + international predictors, calibration
      localSearch.ts    # candidate generation for A and B
    rank.ts             # ranking, tie-breaks, baseline savings
  /sim                  # pricing simulator (tests + mock site)
    simulator.ts
    randomCart.ts
  /adapters
    cart/{selectors.ts,parse.ts,actions.ts}
    checkout/{selectors.ts,parse.ts,guard.ts}
    blocked.ts          # captcha/login/risk-page detection
    sanitize.ts         # fixture capture sanitizer (FR-14)
  /runner
    probeRunner.ts      # one probe, state machine §6
    runController.ts    # loop engine ↔ runner, budgets, restore
    clickAllowList.ts   # FR-6.2
    rateLimiter.ts
  /storage
    db.ts settings.ts cache.ts
  /entrypoints          # WXT entrypoints
    background.ts sidepanel/ cart.content.ts checkout.content.ts
/test
  /fixtures             # sanitized real snapshots (from T10)
  /core /adapters /runner /e2e
/mock-taobao            # static mock site served in e2e (T13)
```

## 4. Data model

```ts
// money: integer fen everywhere
type Fen = number;

interface CartItem {
  lineId: string;          // Taobao cart line ID — primary key
  itemId: string;
  skuId: string | null;
  shopId: string;
  shopName: string;
  title: string;
  unitPrice: Fen;          // as displayed in cart
  qty: number;
  selected: boolean;
  selectable: boolean;     // false if invalid / out of stock
}

type Selection = readonly string[];   // sorted lineIds; canonical form
// In core search, selections are bitmasks over U's index order (n ≤ 20 → number OK)

interface Quote {
  key: string;             // cache key (FR-5.1)
  lineIds: Selection;
  status: 'ok' | 'infeasible';
  infeasibleReason?: string;
  goodsNet: Fen;           // G(S)
  grandTotal: Fen;         // T(S)
  overhead: Fen;           // O(S) = T − G
  // optional breakdown (A-4); absent fields = not parsed
  domesticByShop?: Record<string, Fen>;
  consolidationFee?: Fen;
  shippingDiscounts?: Fen;
  otherFees?: Fen;
  tax?: Fen;
  coupons: { id: string; label: string; amount: Fen }[];   // FR-9.1
  breakdownConsistent: boolean;  // NFR-4 cross-check
  capturedAt: number;      // epoch ms
  addressId: string;
}

type ProbeResult =
  | { kind: 'ok'; quote: Quote; fromCache: boolean }
  | { kind: 'infeasible'; quote: Quote; fromCache: boolean }
  | { kind: 'blocked'; reason: 'captcha' | 'login' | 'risk' | 'unknown' }
  | { kind: 'error'; reason: string };

interface ProbeClient {                       // implemented by ProbeRunner and by the simulator
  probe(sel: Selection): Promise<ProbeResult>;
}

type Objective = 'A' | 'B';

interface SearchParams {
  objective: Objective;
  nExh: number; kMax: number; bMinValue: Fen; rShow: number;
  maxProbes: number;
  strategyB?: 'heuristic' | 'topDownGreedy';
  rateTable?: RateTable;                     // FR-12.5, model only
}

interface RateTable { firstKg: number; firstFee: Fen; stepKg: number; stepFee: Fen; }

interface ResultA {
  groups: { lineIds: Selection; quote: Quote }[];
  cost: Fen;                 // Σ overhead, coupon-adjusted
  couponAdjusted: boolean;
  savingsVsBaseline: Fen | null;
}
interface ResultB {
  lineIds: Selection; quote: Quote;
  ratio: number;             // O/G
  savingsNote: string;
}

interface Run {
  id: string; startedAt: number; endedAt?: number;
  status: 'running' | 'paused' | 'done' | 'stopped' | 'aborted' | 'blocked';
  items: CartItem[];         // snapshot of U
  originalSelection: Selection;  // full cart selection to restore (FR-3.5)
  params: SearchParams;
  probesUsed: number;
  engineState: unknown;      // serialized SearchEngine state (NFR-6)
  results?: { exact: boolean; A?: ResultA[]; B?: ResultB[] };
}
```

## 5. Page adapters

Each adapter has three layers:
- `selectors.ts` — the **only** place with CSS selectors / text patterns, each field with `primary` and `fallback` (FR-1.2). Filled in from real fixtures in T11/T12.
- `parse.ts` — pure function `parse(document) → Result<T, ParseError[]>`; tested against fixtures.
- `actions.ts` — DOM actions, every click routed through `clickAllowList`.

### 5.1 Cart adapter (`cart.content.ts`)
Messages handled:
- `cart/read` → `CartItem[]`
- `cart/setSelection(lineIds)` → ticks exactly these lines, unticks all others. Implementation: read current state, click only the checkboxes that differ, wait for Taobao's selected-total element to update (poll ≤ 5 s), re-read and assert the state matches. Mismatch → `error`.
- `cart/goCheckout` → clicks the cart checkout button (allow-listed). Must verify the selected count shown next to the button equals `lineIds.length` before clicking.

Note: Taobao may persist cart selection server-side; that is why the original selection is stored in the run and restored at the end (FR-3.5).

### 5.2 Checkout adapter (`checkout.content.ts`)
- The guard is **fail-closed**. A MAIN-world content script (manifest `world: "MAIN"`, `run_at: document_start`) on the checkout hosts installs the guard **armed**, synchronously, before any page script runs. The isolated-world checkout script then asks the background whether this tab is the probe tab (`probeTabId` in `chrome.storage.session`). If it is not, the script disarms the guard through a one-shot `CustomEvent` handshake, so the user's own checkout works normally after a few milliseconds. An async lookup must never be the thing that arms the guard, because that leaves a window in which submit is unguarded.
- Hidden-tab throttling: the probe tab is inactive for the whole run, so Chrome throttles its timers (intensive throttling after 5 min) and pauses `requestAnimationFrame`. Waits use `MutationObserver` plus wall-clock timestamps rather than chained `setTimeout` polling. T10 must confirm that the checkout page renders fully in an inactive tab (see §12).
- `checkout/read` → `ProbeResult`:
  1. Run `blocked.ts` detection first (captcha/slider containers, login host redirect, risk-control page text). → `blocked`.
  2. Verify address against the configured match rule (FR-3.3). Mismatch → `error('address')`, and the controller aborts the run.
  3. Detect infeasibility messages (A-6) → `infeasible` with reason.
  4. Parse amounts → `Quote`; compute `overhead = grandTotal − goodsNet`; cross-check breakdown (NFR-4).
- Wait strategy: checkout content is rendered asynchronously; wait until the grand-total element is present and stable for 800 ms (unchanged across 3 polls), timeout 20 s → `error('timeout')`.

### 5.3 Submit guard (`guard.ts`, FR-6.3)
- Capture-phase `click`, `mousedown`, `pointerdown`, `keydown(Enter/Space)` listeners on `window` that `stopImmediatePropagation()` + `preventDefault()` when the event target is inside any element matching the submit/pay selector list **or** whose text matches `/提交订单|立即支付|付款|Submit order|Place order|Pay/i`.
- Override `HTMLFormElement.prototype.submit` and `requestSubmit` in the page's main world (from the same MAIN-world `document_start` script, §5.2) to throw while armed.
- Any blocked attempt is logged and reported to the controller, which aborts the run.

### 5.4 Click allow-list (FR-6.2)
`clickAllowList.click(el, purpose)` where `purpose ∈ {'cartCheckbox','cartCheckout'}` checks `el` against the selector set for that purpose and refuses (throws `SafetyError`) otherwise. Adapters never call `el.click()` directly; a lint rule (`no-restricted-syntax` on `.click(`) outside `clickAllowList.ts` enforces it.

### 5.5 Navigation back
After reading a quote, the runner navigates the probe tab to the cart URL with `chrome.tabs.update` (not history back), so no checkout-page control is ever touched.

## 6. Probe runner

State machine for one probe:

```
IDLE → SET_SELECTION → VERIFY_SELECTION → GO_CHECKOUT → WAIT_CHECKOUT
     → READ_QUOTE → RETURN_TO_CART → DONE
any state → BLOCKED | ERROR (with reason)
```

Timeouts: each state 20 s. Runner contract:
- `probe(sel)`: check cache first (FR-5); on hit return it without touching the page and without delay.
- On miss: check per-day budget; run the state machine; write the quote to cache; then sleep `uniform(PROBE_DELAY_MIN, PROBE_DELAY_MAX)`.
- Never runs two probes concurrently (single-flight mutex).

Run controller loop:

```ts
const engine = createEngine(U, params, savedState);
while (!engine.done() && run.probesUsed < params.maxProbes) {
  const sel = engine.next();                 // returns null when done
  if (!sel) break;
  const r = await runner.probe(sel);
  const fromCache = (r.kind === 'ok' || r.kind === 'infeasible') && r.fromCache;
  if (!fromCache) run.probesUsed += 1;       // errors and blocked pages still hit Taobao
  if (r.kind === 'blocked') { persist(run, engine.serialize()); pause('blocked'); focusProbeTab(); return; }
  if (r.kind === 'error') {                  // not observed: the engine re-proposes the same sel
    persist(run, engine.serialize());
    if (++consecutiveErrors >= 2) { stop('errors'); break; }
    continue;
  }
  consecutiveErrors = 0;
  engine.observe(sel, r);
  persist(run, engine.serialize());
}
await restoreSelection(run.originalSelection); closeProbeTab();
run.results = engine.results();
```

Cached quotes do not consume the probe budget. Every probe that touches the page does, including errors and blocked pages. A paused run (blocked, or panel closed) leaves the cart as it is. The original selection is restored when the run finishes, is stopped, or is discarded from the resume prompt.

## 7. Search

Notation: `U` indexed 0..n−1, selections as bitmasks. `quotes: Map<mask, Quote>` holds every verified quote. `O(mask) = ∞` for infeasible.

### 7.1 Exhaustive (n ≤ N_EXH), FR-10.1
1. Probe all `2^n − 1` non-empty masks, ordered so the full set `U` is first (baseline), then singletons, then the rest by popcount. That way a stopped run still has useful partial data.
2. Objective B: filter `G ≥ B_MIN_VALUE`, sort by `R = O/G` with tie-breaks (FR-8.2).
3. Objective A: enumerate all set partitions of `U` with `k ≤ K_MAX` blocks (restricted-growth strings; Bell(6) = 203, so trivial), cost each with `costPartition()` (§7.5), sort with FR-7.3 tie-breaks.
4. `exact = true` only if all masks were probed successfully.

Probe count for n = 6: 63, about 10 min at default delays (within `MAX_PROBES_PER_RUN = 80`). For n = 7 (allowed by `N_EXH ≤ 7`) it is 127. If `2^n − 1 > maxProbes`, the setup screen warns before Start, and a run that hits the cap returns `exact = false`.

Engine construction: a single factory, `createEngine(items, params, savedState?)`. It picks exhaustive, heuristic or top-down greedy from `n` and `params` and restores from `savedState` when given. There is no separate static `restore`.

### 7.2 Heuristic (n > N_EXH), FR-10.2

Phases:
1. **Baseline:** probe `U`.
2. **Singletons:** probe each `{i}`. An infeasible singleton → item ineligible; remove it from `U`, report it, and continue with the reduced set.
3. **Shop groups:** for each shop with ≥ 2 in-scope items, probe that shop's items as one selection.
4. **Calibrate model** (§7.3).
5. **Verify loop** (§7.4) until the budget is exhausted or the stopping rule fires.

Probe count before the verify loop: `1 + n + (#shops with ≥2 items)`. E.g. n = 12, 4 shops → 17.

### 7.3 Prediction model (`model.ts`) — internal only

`predictO(mask) = Σ_shops predictDomestic(shop, mask ∩ shopItems) + predictIntl(mask) − predictedShippingDiscounts(mask)`

If a quote for `mask` exists, use it instead (exact).

**Domestic per shop.** Data: singleton domestic `d1[i]` (from `domesticByShop` of the singleton quote; if breakdown not parsed, use `O({i}) − intl-part estimate`, see below), full-shop observation `dAll[s]`, and any observed `(shop, subgroup) → domestic` pairs extracted from any verified quote's `domesticByShop`.
```
predictDomestic(s, T):
  if T empty → 0
  if observed(s, T) exists → observed(s, T)
  base = max_{i∈T} d1[i]                  // shops usually charge freight once per order
  if dAll[s] known and dAll[s] < base and goods(T) ≥ goods(allItems(s))   // threshold reached
       → dAll[s]
  if some observed (s, T') with T' ⊆ T and domestic(T') < base and goods(T) ≥ goods(T')
       → min such domestic                // threshold already met by a smaller subgroup
  → base
```

**International.** Two modes:
- *Rate-table mode* (if `rateTable` configured): `rateFn(W) = W ≤ 0 ? 0 : firstFee + ceil(max(0, W − firstKg) / stepKg) · stepFee`. From each singleton's consolidation fee `f_i`, invert `rateFn` to a weight bracket `(lo_i, hi_i]`; use `mid_i`. `W(S) = α · Σ mid_i`, `predictIntl = rateFn(W(S))`. Fit `α ∈ [0.6, 1.1]` (grid step 0.02) by minimizing squared error on all verified multi-item quotes. If any `f_i` does not lie on the rate lattice (±¥0.5), switch to marginal mode and mark the model "uncalibrated" in debug view.
- *Marginal mode* (default, no rate table): `F0 = min_i f_i` (approximates the first-weight fee). `predictIntl(S) = F0 + Σ_{i∈S} (f_i − F0)` adjusted by learned scale `β` fitted the same way. This captures the main effect: the first-weight charge is paid once per group.

If the breakdown (A-4) is unavailable, the model works on overhead only: treat `O({i})` as `f_i` in marginal mode, and treat the per-shop domestic as 0 except via observed groups. Predictions get weaker, but results stay correct because only verified quotes are ranked.

### 7.4 Verify loop

Maintains `best: verified results` (top `R_SHOW`) and a candidate pool scored by prediction.

```
loop:
  cands = generateCandidates(objective)          // §7.6, predicted scores
  for c in cands sorted by predicted score:
      unprobed = groups/subsets of c without a quote
      if unprobed empty: insert c into verified ranking; continue
      if predicted(c) is not better than the R_SHOW-th verified result by > ε (1% or ¥1): skip
      probe the unprobed selection with the best predicted contribution (one probe), observe, recalibrate
      restart loop
  stop when no candidate passes the filter, or budget exhausted
```

Each iteration probes exactly one selection so the model learns between probes.

### 7.5 Cost functions (`cost.ts`)

```
objectiveA(P): if any O(Sj) = ∞ → ∞ ; else couponAdjust(P).cost
objectiveB(S): G(S) < B_MIN_VALUE → invalid ; else O(S)/G(S)

couponAdjust(P):                      // FR-9.2
  for each coupon id c used by ≥ 2 groups:
     keeper = argmax_j amount(c in Sj)
     for other groups j: cost += amount(c in Sj)
  couponAdjusted = any adjustment made
```

### 7.6 Candidate generation (`localSearch.ts`)

Objective A (partitions with k ≤ K_MAX):
- Seeds: `{U}`; partition by shop (merge smallest shops until k ≤ K_MAX); best 2-split from singletons' predicted costs; the current verified best.
- Moves: relocate one item to another group or a new group; swap two items between groups; merge two groups; split one shop's items out into its own group.
- Best-improvement hill climbing with 20 random restarts (seeded RNG for test determinism), keep the top 50 distinct partitions (canonicalized: groups sorted by min index).

Objective B (subsets with G ≥ B_MIN_VALUE):
- Seeds: `U`; each shop group; whole shops sorted by predicted R, added greedily.
- Moves: add one, remove one, swap one in/out, add or remove a whole shop's items.
- Same climbing and restart settings, top 50 distinct subsets.

### 7.7 Top-down greedy (FR-10.5, objective B only)

```
S = U (already probed); loop:
  probe S \ {i} for all i ∈ S where G(S\{i}) ≥ B_MIN_VALUE   (cache helps)
  pick i* minimizing R(S\{i}); if R(S\{i*}) ≥ R(S) → stop; else S = S\{i*}
```

Cost ≤ n(n+1)/2 probes, so it is budget-bounded: stop when the budget runs out and report best-found.

## 8. Ranking and presentation (`rank.ts`)
- Only verified results are ranked (FR-10.3).
- Objective A: sort by `cost`, then group count, then `Σ T`. Savings = `cost({U}) − cost(P)`.
- Objective B: sort by ratio, then larger `G`, then smaller `O`.
- CAD display: `cad = fen/100 × fxRate × (1 + cardFxFee)`, rounded to cents; always shown beside CNY, never instead of it.

## 9. Storage
- `chrome.storage.local`: settings (FR-12), address match rule, daily probe counter `{date, count}`.
- `chrome.storage.session`: probe-tab flags (`probeTabId`), so the guard activates only in that tab.
- IndexedDB `tbopt` v1 stores:
  - `quotes` key = cache key; index by `capturedAt`.
  - `runs` key = run id.
  - `probeLog` auto-increment; last 500 entries.
  - `quoteVsFinal` (T22): checkout quote vs user-entered final fee.

## 10. UI (side panel)

Screens:
1. **First-run setup:** explain what the tool does and the safety rules; capture the consolidation address match rule (open the checkout page once manually; the panel reads the address text and asks the user to confirm); FX rate.
2. **Setup:** cart items grouped by shop with checkboxes (FR-2.1); objective toggle A/B; B minimum value; "Search mode: exact (n ≤ 6) / heuristic"; planned probes and ETA; Start.
3. **Progress:** probes used / budget, current phase, ETA, best verified result so far, Stop button. On blocked: banner "Taobao asked for verification — solve it in the probe tab, then Resume".
4. **Results:** ranked cards (FR-11.2), exact vs best-found badge, Apply buttons, group checklist for A.
5. **Settings:** FR-12. **Debug:** FR-14.2.

The panel is enabled only on the cart host (`chrome.sidePanel.setOptions` per tab from the background script).

## 11. Testing strategy

### 11.1 Pricing simulator (`/sim`)
A deterministic oracle implementing `ProbeClient` with hidden ground truth:
- Items: price, qty, true weight (kg), shop.
- Shops: freight template (base fee, free-shipping threshold by amount or by count, optional 满减 discount).
- Consolidation: rate table with first/step pricing, weight limit (e.g. 20 kg → infeasible), packing factor.
- Platform coupons: e.g. "¥X off consolidation fee over ¥Y", single-use (to exercise FR-9).
- Optional noise mode: ±¥1 rounding, to test robustness.
`randomCart(seed, n, shops)` generates realistic carts (clothes 0.2–1.2 kg, shoes 0.8–1.6 kg, accessories 0.05–0.3 kg; prices ¥15–¥400).

Uses:
- Unit tests for exhaustive search: results equal brute force.
- Benchmark (`npm run bench`) for the heuristic: acceptance criterion 4 in specs §8.
- Backing data for the mock site.

### 11.2 Adapter fixture tests
Sanitized real snapshots from T10, plus synthetic variants (missing fields, English UI). Assert exact parsed values and that the guard blocks the submit control.

### 11.3 E2E (Playwright)
The mock Taobao site serves cart and checkout pages built from the fixture markup, with the simulator computing amounts. The extension's host permissions include the mock host in test builds only. Scenarios: full run n = 4 exact; n = 8 heuristic; blocked page mid-run; address mismatch; infeasible item; cart selection restored; submit button never activated (the mock submit endpoint counts hits and must be 0).

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Taobao markup changes | Selectors isolated; fixture tests; parse errors are explicit; capture tool makes new fixtures quick. |
| Anti-bot / account risk | Low probe rates, single tab, hard caps, immediate stop on verification, no direct API calls, no parallelism. |
| Assumption A-1/A-2 false | Verified in T10 before building adapters; the search engine is independent of that answer and can be reused. |
| Coupons consumed or shared across checkouts | FR-9 conservative adjustment; A-5 verified in T10. |
| Checkout quote ≠ final consolidation fee | Quote log (T22) measures it; results are labeled as checkout quotes. |
| Service worker lifetime | Run lives in the side panel; persisted after each probe. |
| Inactive probe tab throttled (timers, rAF paused), checkout never finishes rendering | Waits based on MutationObserver and timestamps; T10 checks rendering in an inactive tab; fallback is an unfocused, non-minimized extension window. |
