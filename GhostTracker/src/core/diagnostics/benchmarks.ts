/**
 * On-device benchmarks (Phase F3, measured in Phase G1).
 *
 * The same workloads as the laptop benchmarks, so phone and laptop numbers
 * can be put side by side:
 *   - inference: predictExpectedPace → NPI → RII, 10,000 calls
 *     (scripts/benchmarks/inference_latency.ts)
 *   - WAL: 1,000 single-row GPS inserts, one transaction each, WAL + NORMAL
 *     (the app's setting) vs rollback journal + FULL (SQLite default)
 *     (scripts/benchmarks/sqlite_wal.py)
 *
 * The clock and the database are passed in, so this runs on the phone
 * (performance.now + expo-sqlite) and in Jest (node:sqlite).
 * Results describe the device they ran on; the screen labels them.
 */

import type { SqlDb } from '../../data/database/thesisSchema';
import { calculateNPI } from '../fairness/npiCalculator';
import { calculateRII } from '../fairness/riiEvaluator';

export interface Stats {
  n: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
}

/** Nearest-rank percentiles (same rule as sqlite_wal.py). */
export function summarize(values: number[]): Stats {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return { n: 0, mean: NaN, p50: NaN, p95: NaN, p99: NaN, min: NaN, max: NaN };
  const pct = (p: number) => s[Math.min(n - 1, Math.max(0, Math.ceil((p * n) / 100) - 1))];
  return {
    n,
    mean: s.reduce((a, b) => a + b, 0) / n,
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    min: s[0],
    max: s[n - 1],
  };
}

/** Deterministic PRNG (mulberry32), same as the laptop benchmarks. */
export function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Inference ───────────────────────────────────────────────────────────────

interface InferenceInput {
  runner: { age: number; bmi: number; gender: 'M' | 'F' };
  route: { altitudeM: number; distanceM: number; avgPaceSPerKm: number };
  pbPace: number;
}

/** Same input distribution as inference_latency.ts (seed 42). */
export function makeInferenceInputs(n: number, seed = 42): InferenceInput[] {
  const random = prng(seed);
  return Array.from({ length: n }, () => {
    const heightCm = 150 + random() * 40;
    const weightKg = 45 + random() * 50;
    const bmi = weightKg / (heightCm / 100) ** 2;
    const avgPace = 280 + random() * 200;
    const age = 18 + Math.floor(random() * 45);
    const gender: 'M' | 'F' = random() < 0.5 ? 'M' : 'F';
    const altitudeM = random() * 2200;
    const distanceM = 1000 + Math.floor(random() * 10) * 1000;
    const pbPace = avgPace * (0.95 + random() * 0.1);
    return { runner: { age, bmi, gender }, route: { altitudeM, distanceM, avgPaceSPerKm: avgPace }, pbPace };
  });
}

export interface InferenceResult {
  calls: number;
  /** Mean cost of one call from timing whole batches (ms per call). */
  batchMsPerCall: Stats;
  /** Each call timed on its own (ms); includes one clock read, see clockOverheadMs. */
  perCallMs: Stats;
  clockOverheadMs: Stats;
  /** Sum of results, so the work cannot be optimised away; also a sanity check. */
  checksum: number;
}

export function runInferenceBenchmark(
  now: () => number,
  opts: { calls?: number; batches?: number; warmup?: number } = {},
): InferenceResult {
  const calls = opts.calls ?? 10_000;
  const batches = opts.batches ?? 5;
  const warmup = opts.warmup ?? 2_000;
  const inputs = makeInferenceInputs(calls);
  let sink = 0;
  const once = (x: InferenceInput) => {
    const npi = calculateNPI(x.runner, x.route);
    sink += npi.npi + calculateRII(x.pbPace, x.route.avgPaceSPerKm);
  };

  for (let i = 0; i < warmup; i++) once(inputs[i % calls]);

  const batch: number[] = [];
  for (let b = 0; b < batches; b++) {
    const t0 = now();
    for (let i = 0; i < calls; i++) once(inputs[i]);
    batch.push((now() - t0) / calls);
  }

  const overhead: number[] = [];
  for (let i = 0; i < calls; i++) {
    const a = now();
    overhead.push(now() - a);
  }

  const perCall: number[] = [];
  for (let i = 0; i < calls; i++) {
    const t0 = now();
    once(inputs[i]);
    perCall.push(now() - t0);
  }

  return {
    calls,
    batchMsPerCall: summarize(batch),
    perCallMs: summarize(perCall),
    clockOverheadMs: summarize(overhead),
    checksum: Math.round(sink * 1000) / 1000,
  };
}

// ── SQLite write latency ────────────────────────────────────────────────────

export interface WalConfig {
  name: string;
  journal: 'WAL' | 'DELETE';
  synchronous: 'NORMAL' | 'FULL';
}

export const WAL_CONFIGS: WalConfig[] = [
  { name: 'wal-normal', journal: 'WAL', synchronous: 'NORMAL' }, // the app's setting (thesis §3.8.2)
  { name: 'rollback-full', journal: 'DELETE', synchronous: 'FULL' }, // SQLite default
];

export interface WalResult {
  config: string;
  /** journal_mode SQLite actually reported (it can refuse WAL, e.g. in memory). */
  journalMode: string;
  inserts: number;
  insertMs: Stats;
}

const BENCH_TABLE = `
  CREATE TABLE bench_gps_points (
    point_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp  INTEGER NOT NULL,
    latitude   REAL NOT NULL,
    longitude  REAL NOT NULL,
    altitude   REAL,
    accuracy   REAL,
    velocity   REAL,
    seq_index  INTEGER NOT NULL
  );
`;

/**
 * Inserts `inserts` GPS rows one at a time (autocommit: one transaction each,
 * as the app does for every accepted 1 Hz fix) into an empty scratch
 * database that the caller opened. Never touches the user's data.
 */
export async function runWalBenchmark(
  db: SqlDb,
  config: WalConfig,
  now: () => number,
  inserts = 1000,
): Promise<WalResult> {
  const mode = await db.all<{ journal_mode: string }>(`PRAGMA journal_mode = ${config.journal}`);
  await db.exec(`PRAGMA synchronous = ${config.synchronous};`);
  await db.exec('DROP TABLE IF EXISTS bench_gps_points;');
  await db.exec(BENCH_TABLE);

  const random = prng(42);
  let lat = 6.8402;
  let lon = 79.8877;
  const t0 = 1_793_000_000_000;
  const times: number[] = [];
  for (let i = 0; i < inserts; i++) {
    lat += (random() - 0.5) * 4e-5;
    lon += (random() - 0.5) * 4e-5;
    const params = ['bench-session', t0 + i * 1000, lat, lon, 15 + random() * 2 - 1, 3 + random() * 12, 2 + random() * 2, i];
    const start = now();
    await db.run(
      `INSERT INTO bench_gps_points
         (session_id, timestamp, latitude, longitude, altitude, accuracy, velocity, seq_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params,
    );
    times.push(now() - start);
  }

  const rows = await db.all<{ n: number }>('SELECT COUNT(*) AS n FROM bench_gps_points');
  if (Number(rows[0]?.n) !== inserts) {
    throw new Error(`expected ${inserts} rows, found ${rows[0]?.n}`);
  }
  await db.exec('DROP TABLE bench_gps_points;');
  return {
    config: config.name,
    journalMode: String(mode[0]?.journal_mode ?? '').toLowerCase(),
    inserts,
    insertMs: summarize(times),
  };
}
