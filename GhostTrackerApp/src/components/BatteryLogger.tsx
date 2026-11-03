/**
 * Battery log during runs (Phase F4, thesis ST-05).
 *
 * While a run is in progress, samples the battery at the start, every
 * minute, and when the run ends, together with whether Bluetooth sync was
 * running. Renders nothing. Lives inside the Bluetooth provider so it can
 * record the Bluetooth state.
 */

import { useEffect, useRef } from 'react';
import { useRun } from '../context/RunContext';
import { useBluetooth } from '../context/BluetoothContext';
import { readBattery } from '../core/battery';
import { insertBatterySample } from '../data/database';

export const BATTERY_SAMPLE_INTERVAL_MS = 60_000;

export default function BatteryLogger() {
  const { run } = useRun();
  const bt = useBluetooth();
  const bleRunningRef = useRef(bt.running);
  bleRunningRef.current = bt.running;

  const startTime = run.startTime;
  const running = run.status === 'running';

  useEffect(() => {
    if (!running || !startTime) return;

    const sample = async () => {
      const b = await readBattery();
      if (!b) return;
      const now = Date.now();
      await insertBatterySample({
        run_started_at: startTime,
        recorded_at: now,
        elapsed_s: (now - startTime) / 1000,
        level: b.level,
        charging: b.charging ? 1 : 0,
        ble_running: bleRunningRef.current ? 1 : 0,
        low_power: b.lowPower === null ? null : b.lowPower ? 1 : 0,
      }).catch(e => console.warn('[Battery] Could not log sample:', e));
    };

    sample();
    const timer = setInterval(sample, BATTERY_SAMPLE_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      sample(); // final sample when the run ends
    };
  }, [running, startTime]);

  return null;
}
