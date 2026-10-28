/**
 * Shared helpers for the benchmark scripts.
 * Import this first: it defines the React Native __DEV__ global that the
 * core logger reads at load time, and silences debug logging.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

(globalThis as any).__DEV__ = false;
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../../src/utils/logger').setLogLevel('ERROR');

import { LeaderboardEntry } from '../../src/data/models';

/** benchmarks_output/ next to this script (works from the compiled .build tree too). */
export const OUTPUT_DIR = path.resolve(__dirname.split(`${path.sep}.build${path.sep}`)[0], '..', 'benchmarks_output');

export function machineInfo() {
  return {
    cpu: os.cpus()[0]?.model.trim() ?? 'unknown',
    cores: os.cpus().length,
    ramGb: Math.round(os.totalmem() / 1024 ** 3),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    measuredAt: new Date().toISOString(),
  };
}

export function writeJson(name: string, data: unknown): string {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

/** Deterministic PRNG (mulberry32), same as the gossip unit tests. */
export function prng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexId(random: () => number, pattern: string): string {
  return pattern.replace(/x/g, () => Math.floor(random() * 16).toString(16));
}

/**
 * A device ID and leaderboard entries shaped like the app's real records:
 * database.ts generateId() gives 'xxxx-xxxx-xxxx' (14 chars) and the device
 * ID is two of those joined by '-' (29 chars).
 */
export function makeDevice(random: () => number, alias: string, entries: number, baseTime: number) {
  const deviceId = `${hexId(random, 'xxxx-xxxx-xxxx')}-${hexId(random, 'xxxx-xxxx-xxxx')}`;
  const leaderboard: LeaderboardEntry[] = Array.from({ length: entries }, (_, k) => ({
    id: hexId(random, 'xxxx-xxxx-xxxx'),
    deviceId,
    userAlias: alias,
    routeId: k === 0 ? 'default-route' : `route-${k}`,
    riiScore: 0.9 + random() * 0.2,
    npiScore: -1 + random() * 2,
    totalTimeS: 600 + random() * 1800,
    syncedAt: null,
    createdAt: baseTime + k,
    updatedAt: baseTime + k,
  }));
  return { deviceId, leaderboard };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, values.length - 1));
  return {
    n: values.length,
    mean,
    sd,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}
