/**
 * Battery log helpers (Phase F4, thesis ST-05): per-run drain and CSV export.
 * Rows come from the app's battery_log table.
 */

export interface DBBatterySample {
  id: number;
  run_started_at: number;
  session_id: string | null;
  recorded_at: number;
  elapsed_s: number;
  level: number;
  charging: number;
  ble_running: number;
  low_power: number | null;
}

/** Per run: samples, duration and drain in %/h (null when too short to say). */
export interface BatteryRunSummary {
  runStartedAt: number;
  sessionId: string | null;
  samples: number;
  minutes: number;
  startPct: number;
  endPct: number;
  drainPctPerHour: number | null;
  charged: boolean;
  bleRunning: boolean;
}

export function summarizeBatteryLog(rows: DBBatterySample[]): BatteryRunSummary[] {
  const byRun = new Map<number, DBBatterySample[]>();
  for (const r of rows) {
    const list = byRun.get(r.run_started_at) ?? [];
    list.push(r);
    byRun.set(r.run_started_at, list);
  }
  return [...byRun.entries()]
    .map(([runStartedAt, list]) => {
      list.sort((a, b) => a.recorded_at - b.recorded_at);
      const first = list[0];
      const last = list[list.length - 1];
      const minutes = (last.recorded_at - first.recorded_at) / 60_000;
      const drop = (first.level - last.level) * 100;
      return {
        runStartedAt,
        sessionId: list.find(x => x.session_id)?.session_id ?? null,
        samples: list.length,
        minutes,
        startPct: first.level * 100,
        endPct: last.level * 100,
        // Battery level moves in 1 % steps, so under 10 minutes the rate is meaningless
        drainPctPerHour: minutes >= 10 ? (drop / minutes) * 60 : null,
        charged: list.some(x => x.charging === 1),
        bleRunning: list.some(x => x.ble_running === 1),
      };
    })
    .sort((a, b) => b.runStartedAt - a.runStartedAt);
}

export function batteryLogCsv(rows: DBBatterySample[]): string {
  const header = 'run_started_at,session_id,recorded_at_iso,elapsed_s,level_pct,charging,ble_running,low_power';
  const lines = rows.map(r =>
    [
      r.run_started_at,
      r.session_id ?? '',
      new Date(r.recorded_at).toISOString(),
      r.elapsed_s.toFixed(0),
      (r.level * 100).toFixed(1),
      r.charging,
      r.ble_running,
      r.low_power ?? '',
    ].join(','),
  );
  return [header, ...lines].join('\n');
}
