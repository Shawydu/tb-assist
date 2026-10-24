// Minimal engine driver for tests and the benchmark (the real controller is T14). Pure TS.

import type { ProbeClient } from '../types';
import type { EngineResults, SearchEngine } from './engine';

export interface DriveOutcome {
  /** Non-cached probes (errors and blocked count, as in design §6). */
  probes: number;
  results: EngineResults;
  stop: 'done' | 'budget' | 'blocked' | 'errors';
}

export async function driveEngine(
  engine: SearchEngine,
  client: ProbeClient,
  maxProbes: number,
): Promise<DriveOutcome> {
  let probes = 0;
  let consecutiveErrors = 0;
  let stop: DriveOutcome['stop'] = 'done';
  while (!engine.done()) {
    if (probes >= maxProbes) {
      stop = 'budget';
      break;
    }
    const sel = engine.next();
    if (!sel) break;
    const r = await client.probe(sel);
    const fromCache = (r.kind === 'ok' || r.kind === 'infeasible') && r.fromCache;
    if (!fromCache) probes += 1;
    if (r.kind === 'blocked') {
      stop = 'blocked';
      break;
    }
    if (r.kind === 'error') {
      if (++consecutiveErrors >= 2) {
        stop = 'errors';
        break;
      }
      continue;
    }
    consecutiveErrors = 0;
    engine.observe(sel, r);
  }
  return { probes, results: engine.results(), stop };
}
