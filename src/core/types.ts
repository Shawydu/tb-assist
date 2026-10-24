// Core data model (design §4). Pure TS: no DOM / chrome.

/** Integer fen (1/100 CNY). Always an integer. */
export type Fen = number;

export interface CartItem {
  lineId: string; // Taobao cart line ID — primary key
  itemId: string;
  skuId: string | null;
  shopId: string;
  shopName: string;
  title: string;
  unitPrice: Fen; // as displayed in cart
  qty: number;
  selected: boolean;
  selectable: boolean; // false if invalid / out of stock
}

/** Sorted lineIds; canonical form. In core search, selections are bitmasks over U's index order. */
export type Selection = readonly string[];

export interface Quote {
  key: string; // cache key (FR-5.1)
  lineIds: Selection;
  status: 'ok' | 'infeasible';
  infeasibleReason?: string;
  goodsNet: Fen; // G(S)
  grandTotal: Fen; // T(S)
  overhead: Fen; // O(S) = T − G
  // optional breakdown (A-4); absent fields = not parsed
  domesticByShop?: Record<string, Fen>;
  consolidationFee?: Fen;
  shippingDiscounts?: Fen;
  otherFees?: Fen;
  tax?: Fen;
  coupons: { id: string; label: string; amount: Fen }[]; // FR-9.1
  breakdownConsistent: boolean; // NFR-4 cross-check
  capturedAt: number; // epoch ms
  addressId: string;
}

export type ProbeResult =
  | { kind: 'ok'; quote: Quote; fromCache: boolean }
  | { kind: 'infeasible'; quote: Quote; fromCache: boolean }
  | { kind: 'blocked'; reason: 'captcha' | 'login' | 'risk' | 'unknown' }
  | { kind: 'error'; reason: string };

/** Implemented by ProbeRunner and by the simulator. */
export interface ProbeClient {
  probe(sel: Selection): Promise<ProbeResult>;
}

export type Objective = 'A' | 'B';

export interface RateTable {
  firstKg: number;
  firstFee: Fen;
  stepKg: number;
  stepFee: Fen;
}

export interface SearchParams {
  objective: Objective;
  nExh: number;
  kMax: number;
  bMinValue: Fen;
  rShow: number;
  maxProbes: number;
  strategyB?: 'heuristic' | 'topDownGreedy';
  rateTable?: RateTable; // FR-12.5, model only
  /** Seed for the heuristic's local search; default derived from the lineIds. */
  seed?: number;
}

export interface ResultA {
  groups: { lineIds: Selection; quote: Quote }[];
  cost: Fen; // Σ overhead, coupon-adjusted
  couponAdjusted: boolean;
  savingsVsBaseline: Fen | null;
}

export interface ResultB {
  lineIds: Selection;
  quote: Quote;
  ratio: number; // O/G
  savingsNote: string;
}

export interface Run {
  id: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'paused' | 'done' | 'stopped' | 'aborted' | 'blocked';
  items: CartItem[]; // snapshot of U
  originalSelection: Selection; // full cart selection to restore (FR-3.5)
  params: SearchParams;
  probesUsed: number;
  engineState: unknown; // serialized SearchEngine state (NFR-6)
  results?: { exact: boolean; A?: ResultA[]; B?: ResultB[]; ineligible?: string[] };
}

/** A parse failure that names the offending field (NFR-3). */
export interface ParseError {
  field: string;
  message: string;
  raw?: string;
}

export type Result<T, E = ParseError> = { ok: true; value: T } | { ok: false; errors: E[] };
