import { describe, expect, it } from 'vitest';
import { formatCad, formatCny, parseFen, toCad } from '../../src/core/money';

describe('parseFen', () => {
  it.each([
    ['¥1,234.50', 123450],
    ['￥1,234.50', 123450],
    ['1234.5', 123450],
    ['1234', 123400],
    ['.5', 50],
    ['0.29', 29],
    ['0.57', 57],
    ['1.005'.slice(0, 4), 100],
    ['1.01', 101],
    ['  ¥12.00  ', 1200],
    [' ¥12.00 ', 1200],
    ['１２３４．５０', 123450],
    ['￥１，２３４．５０', 123450],
    ['-¥5.00', -500],
    ['¥-5.00', -500],
    ['－¥5.00', -500],
    ['¥－5.00', -500],
    ['+¥3.00', 300],
    ['¥ 3', 300],
    ['¥99,999.99', 9999999],
    ['0', 0],
    ['-0', 0],
    ['¥0.00', 0],
    ['1,000', 100000],
  ])('%s -> %s', (t, v) => {
    expect(parseFen(t)).toBe(v);
  });

  it('is exact for float traps', () => {
    expect(parseFen('0.29')).toBe(29);
    expect(parseFen('1.15')).toBe(115);
    expect(parseFen('4.35')).toBe(435);
    expect(parseFen('8.2')).toBe(820);
  });

  it.each([
    '',
    '   ',
    'abc',
    '¥',
    '-',
    '1.005',
    '1.234',
    '1.234,50',
    '1,234,5',
    '12,34',
    '1 234',
    '12 34',
    '1.2.3',
    '5.',
    '¥5 ¥6',
    '5.00 6.00',
    '-¥-5',
    '--5',
    '¥5元',
    '1e3',
    '9999999999999999',
  ])('rejects %j', (t) => {
    expect(parseFen(t)).toBeNull();
  });
});

describe('formatCny', () => {
  it.each([
    [123450, '¥1,234.50'],
    [-500, '-¥5.00'],
    [0, '¥0.00'],
    [5, '¥0.05'],
    [9999999, '¥99,999.99'],
    [100000000, '¥1,000,000.00'],
  ])('%s', (f, s) => {
    expect(formatCny(f)).toBe(s);
  });
  it('round-trips with parseFen', () => {
    for (const f of [0, 1, 99, 100, 123450, -1, -500, 9999999, -9999999]) {
      expect(parseFen(formatCny(f))).toBe(f);
    }
  });
  it('rejects non-integers', () => {
    expect(() => formatCny(1.5)).toThrow();
  });
});

describe('toCad', () => {
  it('basic with fee 0', () => {
    expect(toCad(10000, 0.19, 0)).toBe(1900);
  });
  it('2.5% fee', () => {
    // 100 CNY * 0.19 * 1.025 = 19.475 -> 19.48 (half away from zero)
    expect(toCad(10000, 0.19, 0.025)).toBe(1948);
  });
  it('5% fee', () => {
    expect(toCad(10000, 0.2, 0.05)).toBe(2100);
  });
  it('rounds half away from zero', () => {
    expect(toCad(5, 1, 0)).toBe(5);
    expect(toCad(50, 0.01, 0)).toBe(1); // 0.5 cents -> 1
    expect(toCad(150, 0.01, 0)).toBe(2); // 1.5 -> 2
    expect(toCad(250, 0.01, 0)).toBe(3); // 2.5 -> 3 (not banker's)
    expect(toCad(-50, 0.01, 0)).toBe(-1);
    expect(toCad(-250, 0.01, 0)).toBe(-3);
    expect(toCad(49, 0.01, 0)).toBe(0);
    expect(toCad(-49, 0.01, 0)).toBe(0);
  });
  it('zero and large', () => {
    expect(toCad(0, 0.19, 0.025)).toBe(0);
    expect(toCad(9999999, 0.19, 0)).toBe(1900000); // 18999.9981 CAD
  });
  it('negative discount', () => {
    expect(toCad(-500, 0.2, 0)).toBe(-100);
  });
  it('validates inputs', () => {
    expect(() => toCad(100, 0, 0)).toThrow();
    expect(() => toCad(100, -0.2, 0)).toThrow();
    expect(() => toCad(100, NaN, 0)).toThrow();
    expect(() => toCad(100, Infinity, 0)).toThrow();
    expect(() => toCad(100, 0.2, -0.01)).toThrow();
    expect(() => toCad(100, 0.2, 0.0501)).toThrow();
    expect(() => toCad(100, 0.2, NaN)).toThrow();
    expect(() => toCad(1.5, 0.2, 0)).toThrow();
  });
});

describe('formatCad', () => {
  it.each([
    [1234, 'CA$12.34'],
    [-50, '-CA$0.50'],
    [0, 'CA$0.00'],
    [123456789, 'CA$1,234,567.89'],
  ])('%s', (c, s) => {
    expect(formatCad(c)).toBe(s);
  });
});
