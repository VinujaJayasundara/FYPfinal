/**
 * Phase F3: the on-device benchmark code, checked on the laptop
 * (logic only — the timings that matter are measured on the phone).
 */
import {
  summarize,
  makeInferenceInputs,
  runInferenceBenchmark,
  runWalBenchmark,
  WAL_CONFIGS,
} from '../../src/core/diagnostics/benchmarks';
import type { SqlDb } from '../../src/data/database/thesisSchema';

declare const require: (m: string) => any;
const { DatabaseSync } = require('node:sqlite');
const os = require('os');
const fs = require('fs');
const path = require('path');

function open(file: string): { db: SqlDb; close: () => void } {
  const raw = new DatabaseSync(file);
  return {
    db: {
      async exec(sql) {
        raw.exec(sql);
      },
      async run(sql, params = []) {
        raw.prepare(sql).run(...(params as any[]));
      },
      async all(sql, params = []) {
        return raw.prepare(sql).all(...(params as any[]));
      },
    },
    close: () => raw.close(),
  };
}

describe('summarize', () => {
  it('uses nearest-rank percentiles', () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toMatchObject({ n: 100, p50: 50, p95: 95, p99: 99, min: 1, max: 100 });
    expect(s.mean).toBeCloseTo(50.5);
  });
  it('handles one value and none', () => {
    expect(summarize([7])).toMatchObject({ p50: 7, p99: 7, mean: 7 });
    expect(summarize([]).n).toBe(0);
  });
});

describe('inference benchmark', () => {
  it('inputs are deterministic and in the laptop benchmark ranges', () => {
    const a = makeInferenceInputs(500);
    expect(makeInferenceInputs(500)).toEqual(a);
    for (const x of a) {
      expect(x.runner.age).toBeGreaterThanOrEqual(18);
      expect(x.runner.age).toBeLessThan(63);
      expect(x.route.avgPaceSPerKm).toBeGreaterThanOrEqual(280);
      expect(x.route.avgPaceSPerKm).toBeLessThan(480);
      expect(x.route.distanceM % 1000).toBe(0);
    }
  });

  it('runs every call and gives the same checksum each time', () => {
    let t = 0;
    const fakeClock = () => (t += 0.001);
    const r1 = runInferenceBenchmark(fakeClock, { calls: 1000, batches: 2, warmup: 10 });
    const r2 = runInferenceBenchmark(fakeClock, { calls: 1000, batches: 2, warmup: 10 });
    expect(r1.perCallMs.n).toBe(1000);
    expect(r1.batchMsPerCall.n).toBe(2);
    expect(Number.isFinite(r1.checksum)).toBe(true);
    expect(r2.checksum).toBe(r1.checksum);
  });
});

describe('WAL benchmark (real SQLite file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-diag-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it.each(WAL_CONFIGS)('$name inserts every row and reports the journal mode', async cfg => {
    const { db, close } = open(path.join(dir, `${cfg.name}.db`));
    const now = () => Number(process.hrtime.bigint()) / 1e6;
    const r = await runWalBenchmark(db, cfg, now, 200);
    close();
    expect(r.inserts).toBe(200);
    expect(r.insertMs.n).toBe(200);
    expect(r.journalMode).toBe(cfg.journal.toLowerCase());
    expect(r.insertMs.min).toBeGreaterThanOrEqual(0);
  });
});

declare const process: { hrtime: { bigint(): bigint } };
