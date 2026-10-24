import { describe, expect, it } from 'vitest';
import { createRng } from '../../../src/core/rng';
import { fitFeeModel, SAMPLES } from '../../../src/core/search/feeModel';

// Lattice: first fee 4000, step 1000; weights in step units chosen so singletons land on levels 0..2.
const obs = [
  { mask: 0b001, fee: 4000 },
  { mask: 0b010, fee: 5000 },
  { mask: 0b100, fee: 4000 },
  { mask: 0b011, fee: 6000 },
];

describe('fitFeeModel', () => {
  it('is deterministic for a given seed', () => {
    const a = fitFeeModel(3, obs, [], createRng(7));
    const b = fitFeeModel(3, obs, [], createRng(7));
    expect(a).not.toBeNull();
    expect(a!.predictFee(0b111)).toBe(b!.predictFee(0b111));
  });

  it('predicts fees on the observed lattice and monotone in the mask', () => {
    const m = fitFeeModel(3, obs, [], createRng(1))!;
    expect(m.samples).toBe(SAMPLES);
    const s = m.feeSamples(0b111);
    expect(s).toHaveLength(SAMPLES);
    for (const v of s) expect(v).toBeGreaterThanOrEqual(4000);
    expect(m.predictFee(0b111)).toBeGreaterThanOrEqual(m.predictFee(0b001));
  });

  it('flags masks that contain an observed over-weight mask', () => {
    const m = fitFeeModel(3, obs, [0b110], createRng(1))!;
    expect(m.pOverweight(0b111)).toBeGreaterThanOrEqual(0.5);
    expect(m.pOverweight(0b001)).toBeLessThan(0.5);
  });
});
