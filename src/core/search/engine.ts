// Search engine interface and factory (design §7, §7.1 "Engine construction"). Pure TS.

import { MAX_N } from '../selection';
import type { CartItem, ProbeResult, ResultA, ResultB, SearchParams, Selection } from '../types';
import { createExhaustiveEngine } from './exhaustive';
import type { ExhaustiveState } from './exhaustive';
import { createHeuristicEngine } from './heuristic';
import type { HeuristicState } from './heuristic';
import { createTopDownGreedyEngine } from './topDownGreedy';
import type { TopDownGreedyState } from './topDownGreedy';

export interface EngineResults {
  exact: boolean;
  A?: ResultA[];
  B?: ResultB[];
  /** Heuristic only: lineIds whose singleton was infeasible; excluded from the A partitions. */
  ineligible?: string[];
}

export interface SearchEngine {
  readonly kind: 'exhaustive' | 'heuristic' | 'topDownGreedy';
  /** Next selection to probe, null when done. Idempotent until observe() is called. */
  next(): Selection | null;
  /** Feed the result for the pending selection. Only 'ok' | 'infeasible' are accepted. */
  observe(sel: Selection, r: ProbeResult): void;
  done(): boolean;
  /** Callable anytime; ranks only verified quotes. */
  results(): EngineResults;
  /** JSON-safe plain data. */
  serialize(): EngineState;
}

/** Versioned discriminated union; heuristic kinds join later. */
export type EngineState = ExhaustiveState | HeuristicState | TopDownGreedyState;

export const N_EXH_MAX = 7;

function isNonNegInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0;
}

export function validateParams(params: SearchParams): void {
  const bad = (m: string): never => {
    throw new Error(`invalid SearchParams: ${m}`);
  };
  if (!Number.isInteger(params.nExh) || params.nExh < 1 || params.nExh > N_EXH_MAX)
    bad(`nExh must be an integer 1..${N_EXH_MAX}, got ${params.nExh}`);
  if (!Number.isInteger(params.kMax) || params.kMax < 1) bad(`kMax must be an integer >= 1`);
  if (!isNonNegInt(params.bMinValue)) bad(`bMinValue must be a non-negative integer fen`);
  if (!isNonNegInt(params.rShow)) bad(`rShow must be a non-negative integer`);
  if (!Number.isInteger(params.maxProbes) || params.maxProbes < 1)
    bad(`maxProbes must be an integer >= 1`);
}

export function validateItems(items: readonly CartItem[]): void {
  const n = items.length;
  if (n < 1) throw new Error('cart must have at least 1 item');
  if (n > MAX_N) throw new Error(`cart has ${n} items; maximum is ${MAX_N}`);
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.lineId)) throw new Error(`duplicate lineId ${it.lineId}`);
    seen.add(it.lineId);
  }
}

export function createEngine(
  items: CartItem[],
  params: SearchParams,
  savedState?: EngineState,
): SearchEngine {
  validateItems(items);
  validateParams(params);
  if (items.length > params.nExh) {
    if (params.objective === 'B' && params.strategyB === 'topDownGreedy') {
      if (savedState && savedState.kind !== 'topDownGreedy') {
        throw new Error(`saved state kind ${String(savedState.kind)} does not match engine`);
      }
      return createTopDownGreedyEngine(items, params, savedState);
    }
    if (savedState && savedState.kind !== 'heuristic') {
      throw new Error(`saved state kind ${String(savedState.kind)} does not match engine`);
    }
    return createHeuristicEngine(items, params, savedState);
  }
  if (savedState && savedState.kind !== 'exhaustive') {
    throw new Error(`saved state kind ${String(savedState.kind)} does not match engine`);
  }
  return createExhaustiveEngine(items, params, savedState);
}
