/** Phase F4: battery log summary and CSV export. */
import { summarizeBatteryLog, batteryLogCsv, DBBatterySample } from '../../src/core/diagnostics/batteryLog';

const T0 = Date.UTC(2026, 10, 3, 6, 0, 0);
let nextId = 1;
function sample(runStart: number, minute: number, level: number, extra: Partial<DBBatterySample> = {}): DBBatterySample {
  return {
    id: nextId++,
    run_started_at: runStart,
    session_id: null,
    recorded_at: runStart + minute * 60_000,
    elapsed_s: minute * 60,
    level,
    charging: 0,
    ble_running: 1,
    low_power: 0,
    ...extra,
  };
}

describe('summarizeBatteryLog', () => {
  it('computes drain in %/h per run, newest run first', () => {
    const runA = [0, 10, 20, 30].map((m, i) => sample(T0, m, 0.9 - i * 0.01)); // 3 % in 30 min
    const runB = [sample(T0 + 86_400_000, 0, 0.5), sample(T0 + 86_400_000, 60, 0.43, { session_id: 's-b' })];
    const out = summarizeBatteryLog([...runA, ...runB]);
    expect(out.map(r => r.runStartedAt)).toEqual([T0 + 86_400_000, T0]);
    expect(out[1]).toMatchObject({ samples: 4, minutes: 30, bleRunning: true, charged: false });
    expect(out[1].drainPctPerHour).toBeCloseTo(6.0, 6);
    expect(out[0].drainPctPerHour).toBeCloseTo(7.0, 6);
    expect(out[0].sessionId).toBe('s-b');
  });

  it('gives no rate for runs under 10 minutes and flags charging', () => {
    const out = summarizeBatteryLog([sample(T0, 0, 0.8), sample(T0, 5, 0.79, { charging: 1 })]);
    expect(out[0].drainPctPerHour).toBeNull();
    expect(out[0].charged).toBe(true);
  });

  it('handles an empty log', () => {
    expect(summarizeBatteryLog([])).toEqual([]);
  });
});

describe('batteryLogCsv', () => {
  it('writes a header and one line per sample', () => {
    const csv = batteryLogCsv([sample(T0, 1, 0.875, { session_id: 'abc', low_power: null })]).split('\n');
    expect(csv[0]).toBe('run_started_at,session_id,recorded_at_iso,elapsed_s,level_pct,charging,ble_running,low_power');
    expect(csv[1]).toBe(`${T0},abc,2026-11-03T06:01:00.000Z,60,87.5,0,1,`);
  });
});
