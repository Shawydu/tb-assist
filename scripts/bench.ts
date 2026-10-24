// Benchmark for the heuristic search (specs §8 criterion 4, tasks T9).
// Usage: npm run bench -- [--n 8,10,12] [--seeds 1-200] [--obj A,B] [--rate off|on|both]
//                         [--maxProbes 80] [--bMin 10000] [--kMax 3] [--greedy on|off] [--quiet]
import { createEngine } from '../src/core/search/engine';
import { driveEngine } from '../src/core/search/drive';
import type { CartItem, RateTable, SearchParams } from '../src/core/types';
import { randomCart } from '../src/sim/randomCart';
import { PricingSimulator, trueOptimumA, trueOptimumB } from '../src/sim/simulator';
import type { SimConfig } from '../src/sim/simulator';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? (process.argv[i + 1] as string) : def;
}

const toItems = (cfg: SimConfig): CartItem[] =>
  cfg.items.map((i) => ({
    lineId: i.lineId,
    itemId: i.itemId,
    skuId: i.skuId,
    shopId: i.shopId,
    shopName: i.shopName,
    title: i.title,
    unitPrice: i.unitPrice,
    qty: i.qty,
    selected: true,
    selectable: true,
  }));

/** The base ("light") rate table, as a user would enter it in settings (FR-12.5). */
const rateTableOf = (cfg: SimConfig): RateTable => {
  const b = cfg.consolidation.brackets[0] as SimConfig['consolidation']['brackets'][number];
  return { firstKg: b.firstKg, firstFee: b.firstFee, stepKg: b.stepKg, stepFee: b.stepFee };
};

interface CartOutcome {
  feasible: boolean;
  hit: boolean;
  within3: boolean;
  gapPct: number;
  probes: number;
}

export interface Row {
  label: string;
  carts: number;
  infeasible: number;
  hit: number;
  within3: number;
  gapP50: number;
  gapP90: number;
  gapMax: number;
  meanProbes: number;
  maxProbes: number;
  seconds: number;
}

const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] as number;
};

async function runCart(
  seed: number,
  n: number,
  obj: 'A' | 'B',
  strategy: 'heuristic' | 'topDownGreedy',
  useRate: boolean,
  o: { maxProbes: number; bMin: number; kMax: number },
): Promise<CartOutcome> {
  const cfg = randomCart(seed, n);
  const sim = new PricingSimulator(cfg);
  const params: SearchParams = {
    objective: obj,
    nExh: 6,
    kMax: o.kMax,
    bMinValue: o.bMin,
    rShow: 5,
    maxProbes: o.maxProbes,
    ...(obj === 'B' ? { strategyB: strategy } : {}),
    ...(useRate ? { rateTable: rateTableOf(cfg) } : {}),
  };
  const eng = createEngine(toItems(cfg), params);
  const out = await driveEngine(eng, sim, o.maxProbes);
  let truth: number | null;
  let got: number | null;
  if (obj === 'A') {
    truth = trueOptimumA(sim, o.kMax).optimum?.cost ?? null;
    got = out.results.A?.[0]?.cost ?? null;
  } else {
    const t = trueOptimumB(sim, o.bMin).optimum;
    truth = t ? t.ratio : null;
    got = out.results.B?.[0]?.ratio ?? null;
  }
  if (truth === null)
    return { feasible: false, hit: false, within3: false, gapPct: 0, probes: out.probes };
  if (got === null)
    return { feasible: true, hit: false, within3: false, gapPct: Infinity, probes: out.probes };
  const tol = obj === 'A' ? 0.5 : 1e-12;
  const hit = got <= truth + tol;
  const gap = truth > 0 ? Math.max(0, (got - truth) / truth) * 100 : got > 0 ? Infinity : 0;
  return {
    feasible: true,
    hit,
    within3: hit || gap <= 3,
    gapPct: hit ? 0 : gap,
    probes: out.probes,
  };
}

export async function benchRow(
  label: string,
  seeds: number[],
  n: number,
  obj: 'A' | 'B',
  strategy: 'heuristic' | 'topDownGreedy',
  useRate: boolean,
  o: { maxProbes: number; bMin: number; kMax: number },
  quiet: boolean,
): Promise<Row> {
  const t0 = Date.now();
  const res: CartOutcome[] = [];
  for (const [i, s] of seeds.entries()) {
    const r = await runCart(s, n, obj, strategy, useRate, o);
    if (process.argv.includes('--fails') && r.feasible && !r.hit)
      process.stderr.write(`  miss ${label} seed ${s} gap ${r.gapPct.toFixed(1)}%\n`);
    res.push(r);
    if (!quiet && (i + 1) % 50 === 0)
      process.stderr.write(`  ${label}: ${i + 1}/${seeds.length}\n`);
  }
  const f = res.filter((r) => r.feasible);
  const gaps = f.map((r) => r.gapPct);
  return {
    label,
    carts: res.length,
    infeasible: res.length - f.length,
    hit: (100 * f.filter((r) => r.hit).length) / Math.max(1, f.length),
    within3: (100 * f.filter((r) => r.within3).length) / Math.max(1, f.length),
    gapP50: pct(gaps, 0.5),
    gapP90: pct(gaps, 0.9),
    gapMax: Math.max(0, ...gaps),
    meanProbes: res.reduce((a, r) => a + r.probes, 0) / Math.max(1, res.length),
    maxProbes: Math.max(0, ...res.map((r) => r.probes)),
    seconds: (Date.now() - t0) / 1000,
  };
}

async function main(): Promise<void> {
  const ns = arg('n', '8,10,12').split(',').map(Number);
  const [lo, hi] = arg('seeds', '1-200').split('-').map(Number) as [number, number];
  const seeds: number[] = [];
  for (let s = lo; s <= (hi ?? lo); s++) seeds.push(s);
  const objs = arg('obj', 'A,B').split(',') as ('A' | 'B')[];
  const rate = arg('rate', 'off');
  const greedy = arg('greedy', 'on') === 'on';
  const quiet = process.argv.includes('--quiet');
  const o = {
    maxProbes: Number(arg('maxProbes', '80')),
    bMin: Number(arg('bMin', '10000')),
    kMax: Number(arg('kMax', '3')),
  };
  const rates = rate === 'both' ? [false, true] : [rate === 'on'];
  const rows: Row[] = [];
  for (const r of rates)
    for (const n of ns)
      for (const obj of objs) {
        const tag = `${obj} n=${n}${r ? ' +rate' : ''}`;
        rows.push(await benchRow(tag, seeds, n, obj, 'heuristic', r, o, quiet));
        if (obj === 'B' && greedy)
          rows.push(
            await benchRow(
              `B-greedy n=${n}${r ? ' +rate' : ''}`,
              seeds,
              n,
              obj,
              'topDownGreedy',
              r,
              o,
              quiet,
            ),
          );
      }
  console.log(`seeds ${lo}-${hi}, maxProbes ${o.maxProbes}, kMax ${o.kMax}, bMin ${o.bMin} fen\n`);
  console.log(
    '| config | carts | infeasible | hit % | within 3% | gap p50 % | gap p90 % | gap max % | mean probes | max probes | s |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows)
    console.log(
      `| ${r.label} | ${r.carts} | ${r.infeasible} | ${r.hit.toFixed(1)} | ${r.within3.toFixed(1)} | ${r.gapP50.toFixed(2)} | ${r.gapP90.toFixed(2)} | ${r.gapMax.toFixed(1)} | ${r.meanProbes.toFixed(1)} | ${r.maxProbes} | ${r.seconds.toFixed(0)} |`,
    );
}

await main();
