/**
 * Battery readings (expo-battery), loaded lazily and fully guarded: on a
 * build without the native module, readBattery() returns null and nothing
 * is logged (the run itself is unaffected).
 */

import { requireOptionalNativeModule } from 'expo';

let mod: typeof import('expo-battery') | null | undefined;

function load(): typeof import('expo-battery') | null {
  if (mod !== undefined) return mod;
  // Check for the native module first: requiring expo-battery without it
  // throws, and the dev client reports that as an error even when caught.
  if (!requireOptionalNativeModule('ExpoBattery')) {
    mod = null;
    return mod;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('expo-battery') as typeof import('expo-battery');
  } catch {
    mod = null;
  }
  return mod;
}

export interface BatteryReading {
  /** 0..1 */
  level: number;
  charging: boolean;
  lowPower: boolean | null;
}

export function batteryAvailable(): boolean {
  return load() !== null;
}

export async function readBattery(): Promise<BatteryReading | null> {
  const b = load();
  if (!b) return null;
  try {
    const [level, state, lowPower] = await Promise.all([
      b.getBatteryLevelAsync(),
      b.getBatteryStateAsync(),
      b.isLowPowerModeEnabledAsync().catch(() => null),
    ]);
    if (!(level >= 0 && level <= 1)) return null; // -1 = unknown (e.g. some emulators)
    return {
      level,
      charging: state === b.BatteryState.CHARGING || state === b.BatteryState.FULL,
      lowPower,
    };
  } catch {
    return null;
  }
}
