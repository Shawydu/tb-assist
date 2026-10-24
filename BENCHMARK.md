# BENCHMARK (T9)

Method: `npm run bench -- --n 8,10,12 --seeds 1-200 --maxProbes 80` (scripts/bench.ts). Simulator carts from `randomCart(seed, n)`, kMax 3, bMin 10000 fen, no rate table by default. Hit = best verified cost (A) or ratio (B) equals simulator truth (ties count). Carts with no feasible optimum are excluded and listed as "infeasible". Tuning used dev seeds 10001-10200; evaluation seeds 1-200 were run once at the end.

## Evaluation seeds 1-200 (no rate table)

| config | infeasible | hit % | within 3% | gap p90 % | gap max % | mean probes | s |
|---|---|---|---|---|---|---|---|
| A n=8 | 11 | 94.2 | 97.4 | 0.00 | 9.2 | 80 | 154 |
| B n=8 | 0 | 100.0 | 100.0 | 0.00 | 0.0 | 80 | 119 |
| A n=10 | 11 | 83.6 | 92.1 | 2.23 | 11.9 | 80 | 428 |
| B n=10 | 0 | 98.5 | 99.0 | 0.00 | 7.6 | 80 | 133 |
| A n=12 | 8 | 90.1 | 94.8 | 0.00 | Infinity | 80 | 335 |
| B n=12 | 0 | 99.5 | 99.5 | 0.00 | 3.4 | 80 | 223 |
| B-greedy n=8 | 0 | 61.5 | 66.0 | 20.98 | Infinity | 30 | 0 |
| B-greedy n=10 | 0 | 38.0 | 47.5 | Infinity | Infinity | 43 | 0 |
| B-greedy n=12 | 0 | 32.5 | 39.0 | Infinity | Infinity | 59 | 1 |

Rate-table mode, n=10, seeds 1-200: A hit 80.4 / within 3% 87.8; B hit 77.5 / 85.5 (worse than marginal mode: the rate-table model is not used by the latent path and predicts less well).

## Verdict against specs §8 criterion 4 (n=10)

- B: met (98.5% hit, 99.0% within 3%; the 98% within-3% threshold is met at 99.0).
- A: NOT met. 83.6% hit (need 90) and 92.1% within 3% (need 98). Dev seeds gave ~87-88% hit.

## What changed

- `feeModel.ts`: latent per-item weight model fitted from observed fees (lattice step from the cheapest half of fees), giving posterior samples of fee per mask.
- `exhaustiveCands.ts`: exhaustive candidate enumeration (A for n <= 10, B for n <= 12), ranked by expected improvement over the samples; local search remains for larger n and as fallback.
- `heuristic.ts`: epsilon stop rule removed (full probe budget used), next probe = unprobed block with largest sample sd, soft fallback when the model thinks everything is infeasible.
- Biggest gains: using the whole budget plus exhaustive candidates (dev A 72 -> 84, B 59 -> 94), then the fee model.

## Known weaknesses

- The model over-predicts overhead of unprobed larger masks (bias about -650 fen on truth minus mean, growing with mask size), so some true-optimum blocks are never probed within 80 probes.
- A n=10 misses are mostly this; A n=12 has a few carts with no verified result (gap Infinity).
- Exhaustive A is slow (about 2 s/cart at n=10).
- Rate-table mode is not exploited.
- randomCart not changed; not judged unrealistic, but 4% carts with an ineligible item and coupons add noise.
