import type { Fen } from './types';

const FULLWIDTH_MAP: Record<string, string> = {
  '，': ',',
  '．': '.',
  '。': '.',
  '－': '-',
  '−': '-',
  '＋': '+',
  '￥': '¥',
};

function normalize(text: string): string {
  let out = '';
  for (const ch of text.trim().replace(/^[\s\u00a0\u3000]+|[\s\u00a0\u3000]+$/g, '')) {
    const c = ch.codePointAt(0) as number;
    if (c >= 0xff10 && c <= 0xff19) out += String.fromCharCode(c - 0xff10 + 0x30);
    else out += FULLWIDTH_MAP[ch] ?? ch;
  }
  return out;
}

// sign? ¥? sign? number ; whitespace allowed after sign / currency only.
// number = digits with optional well-formed thousands commas, optional 1-2 decimals.
// Accepts ".5" (=50 fen); rejects "5." and anything with >2 decimals.
const MONEY_RE =
  /^([+-])?[\s\u00a0\u3000]*(¥)?[\s\u00a0\u3000]*([+-])?[\s\u00a0\u3000]*(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d{1,2}))?$/;

/**
 * Parse a CNY amount string to integer fen using exact string arithmetic (no float multiply).
 * Returns null for anything not unambiguously a single amount: empty, garbage, >2 decimals
 * (never rounded), multiple numbers, European format "1.234,50", signs on both sides of ¥.
 */
export function parseFen(text: string): Fen | null {
  const m = MONEY_RE.exec(normalize(text));
  if (!m) return null;
  const [, s1, , s2, intPart, frac] = m;
  if (intPart === undefined && frac === undefined) return null;
  if (s1 && s2) return null;
  const whole = (intPart ?? '0').replace(/,/g, '');
  if (whole.length > 13) return null; // beyond safe-integer range for fen
  const fen = Number(whole) * 100 + Number((frac ?? '').padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(fen)) return null;
  return (s1 ?? s2) === '-' ? (fen === 0 ? 0 : -fen) : fen;
}

function assertInt(n: number, name: string): void {
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got ${n}`);
}

function groupThousands(s: string): string {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatMinor(minor: number, symbol: string): string {
  assertInt(minor, 'amount');
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${minor < 0 ? '-' : ''}${symbol}${groupThousands(String(whole))}.${frac}`;
}

/** `¥1,234.50`, `-¥5.00`. */
export function formatCny(fen: Fen): string {
  return formatMinor(fen, '¥');
}

export const MAX_CARD_FX_FEE = 0.05;

/**
 * CNY fen -> CAD cents: fen/100 × fxRate × (1 + cardFxFee), rounded to the nearest cent,
 * half away from zero (a tiny epsilon absorbs float error on exact .5 cases).
 * Throws if fxRate is not finite and > 0, or cardFxFee is outside [0, 0.05].
 */
export function toCad(fen: Fen, fxRate: number, cardFxFee: number): number {
  assertInt(fen, 'fen');
  if (!Number.isFinite(fxRate) || fxRate <= 0) throw new Error(`invalid fxRate: ${fxRate}`);
  if (!Number.isFinite(cardFxFee) || cardFxFee < 0 || cardFxFee > MAX_CARD_FX_FEE) {
    throw new Error(`invalid cardFxFee (must be 0..${MAX_CARD_FX_FEE}): ${cardFxFee}`);
  }
  // fen/100 dollars × rate × (1+fee) dollars == that value × 100 cents == fen × rate × (1+fee)
  const cents = fen * fxRate * (1 + cardFxFee);
  const r = Math.floor(Math.abs(cents) + 0.5 + 1e-9);
  return cents < 0 && r !== 0 ? -r : r;
}

/** `CA$12.34`, `-CA$0.50`. */
export function formatCad(cents: number): string {
  return formatMinor(cents, 'CA$');
}
