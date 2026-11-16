/**
 * A8 — Determinism reference (thesis ST-04).
 *
 * Runs the fairness engine 1,000,000 times on seeded inputs and hashes the raw
 * 64-bit results (src/core/diagnostics/benchmarks.ts runDeterminismCheck).
 * The phone computes the same hash on the Diagnostics screen; equal hashes
 * mean bit-identical results on x86_64 (this laptop, Node.js) and ARM64 (phone, Hermes).
 *
 * Output: benchmarks_output/determinism.json
 */
import { machineInfo, writeJson } from './common';
import { runDeterminismCheck, DETERMINISM_REFERENCE } from '../../src/core/diagnostics/benchmarks';

const r = runDeterminismCheck(() => performance.now());
const file = writeJson('determinism.json', {
  evaluations: r.evaluations,
  hash: r.hash,
  ms: Math.round(r.ms),
  matchesPinnedReference: r.matchesReference,
  machine: machineInfo(),
});
console.log(`determinism: ${r.evaluations} evaluations, hash ${r.hash} (pinned ${DETERMINISM_REFERENCE.hash}), ${Math.round(r.ms)} ms -> ${file}`);
