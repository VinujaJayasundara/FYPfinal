/**
 * Thesis ST-04: the fairness engine gives bit-identical results on different CPUs.
 * This test pins the laptop (x86_64, Node.js) hash; the Diagnostics screen
 * computes the same hash on the phone (ARM64, Hermes) and compares.
 */
import { runDeterminismCheck, DETERMINISM_REFERENCE } from '../../src/core/diagnostics/benchmarks';

const now = () => Date.now();

describe('determinism check (ST-04)', () => {
  it('is repeatable and sensitive to the number of evaluations', () => {
    const a = runDeterminismCheck(now, 1000);
    expect(runDeterminismCheck(now, 1000).hash).toBe(a.hash);
    expect(runDeterminismCheck(now, 1001).hash).not.toBe(a.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(a.matchesReference).toBeNull();
  });

  it('matches the pinned laptop hash for 1,000,000 evaluations', () => {
    const r = runDeterminismCheck(now);
    // eslint-disable-next-line no-console
    console.log(`determinism: ${r.evaluations} evaluations, hash ${r.hash}, ${r.ms} ms (laptop)`);
    expect(r.hash).toBe(DETERMINISM_REFERENCE.hash);
    expect(r.matchesReference).toBe(true);
  });
});
