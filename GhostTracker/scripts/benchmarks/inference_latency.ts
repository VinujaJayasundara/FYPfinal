/**
 * A1 — Inference latency of the fairness pipeline.
 *
 * Times the code the app runs when a session ends:
 *   predictExpectedPace → calculateNPI (both from the app's npiEngine.ts)
 *   → calculateRII (core riiEngine.ts)
 *
 * Two measurements:
 *   - batch:    30 repetitions of 10,000 calls, wall time / 10,000 (mean cost per call)
 *   - per-call: 10,000 individually timed calls; includes the cost of reading the
 *               clock, which is measured separately and reported as timerOverheadNs
 *
 * Inputs vary per call (seeded PRNG) so the JIT cannot constant-fold the result.
 * Runs in Node.js on the development machine, not on a phone.
 *
 * Output: benchmarks_output/inference.json
 */

import { machineInfo, prng, summarize, writeJson } from './common';
import { calculateNPI, RunnerProfile, RunContext } from '../../../GhostTrackerApp/src/core/npiEngine';
import { calculateRII } from '../../src/core/fairness/riiEngine';

const CALLS = 10_000;
const BATCH_REPEATS = 30;
const WARMUP = 50_000;
const SEED = 42;

interface Input {
  profile: RunnerProfile;
  context: RunContext;
  pbPace: number;
}

function makeInputs(n: number): Input[] {
  const random = prng(SEED);
  return Array.from({ length: n }, () => {
    const heightCm = 150 + random() * 40;
    const weightKg = 45 + random() * 50;
    const bmi = weightKg / (heightCm / 100) ** 2;
    const avgPace = 280 + random() * 200;
    return {
      profile: { age: 18 + Math.floor(random() * 45), weightKg, heightCm, bmi, gender: random() < 0.5 ? 'M' : 'F' },
      context: { altitudeM: random() * 2200, distanceM: 1000 + Math.floor(random() * 10) * 1000, avgPaceSPerKm: avgPace },
      pbPace: avgPace * (0.95 + random() * 0.1),
    };
  });
}

let sink = 0;

function runOnce(input: Input): void {
  const npi = calculateNPI(input.profile, input.context);
  const rii = calculateRII(input.pbPace, input.context.avgPaceSPerKm);
  sink += npi.npi + rii;
}

function main() {
  const inputs = makeInputs(CALLS);

  for (let i = 0; i < WARMUP; i++) runOnce(inputs[i % CALLS]);

  // Batch timing: mean cost per call.
  const batchNsPerCall: number[] = [];
  for (let r = 0; r < BATCH_REPEATS; r++) {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < CALLS; i++) runOnce(inputs[i]);
    const t1 = process.hrtime.bigint();
    batchNsPerCall.push(Number(t1 - t0) / CALLS);
  }

  // Clock-read overhead: two back-to-back hrtime calls.
  const overhead: number[] = [];
  for (let i = 0; i < CALLS; i++) {
    const a = process.hrtime.bigint();
    const b = process.hrtime.bigint();
    overhead.push(Number(b - a));
  }

  // Per-call timing: distribution, upper bound because it includes clock overhead.
  const perCallNs: number[] = [];
  for (let i = 0; i < CALLS; i++) {
    const t0 = process.hrtime.bigint();
    runOnce(inputs[i]);
    const t1 = process.hrtime.bigint();
    perCallNs.push(Number(t1 - t0));
  }

  const batch = summarize(batchNsPerCall);
  const perCall = summarize(perCallNs);
  const timer = summarize(overhead);

  const result = {
    benchmark: 'A1 inference latency (predictExpectedPace + calculateNPI + calculateRII)',
    environment: 'Node.js on development machine (not a phone)',
    machine: machineInfo(),
    config: { calls: CALLS, batchRepeats: BATCH_REPEATS, warmupCalls: WARMUP, seed: SEED },
    batchMeanPerCall: {
      meanNs: batch.mean,
      sdNs: batch.sd,
      minNs: batch.min,
      maxNs: batch.max,
      meanMs: batch.mean / 1e6,
    },
    perCall: {
      note: 'each sample includes one clock read; subtract timerOverheadNs.p50 for an estimate of the pure cost',
      meanNs: perCall.mean,
      p50Ns: perCall.p50,
      p95Ns: perCall.p95,
      p99Ns: perCall.p99,
      maxNs: perCall.max,
      p50Ms: perCall.p50 / 1e6,
      p99Ms: perCall.p99 / 1e6,
    },
    timerOverheadNs: { p50: timer.p50, mean: timer.mean },
    sink, // printed so the work cannot be optimised away
  };

  const file = writeJson('inference.json', result);
  console.log('A1 inference latency');
  console.log(`  batch mean per call : ${batch.mean.toFixed(1)} ns (${(batch.mean / 1e6).toFixed(6)} ms), sd ${batch.sd.toFixed(1)} ns`);
  console.log(`  per call p50 / p99  : ${perCall.p50} ns / ${perCall.p99} ns (timer overhead p50 ${timer.p50} ns)`);
  console.log(`  -> ${file}`);
}

main();
