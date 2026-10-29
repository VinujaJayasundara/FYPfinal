/**
 * Ghost-Tracker app helpers
 * Pure TypeScript — no native dependencies
 *
 * Distance and RII come from the shared core engine (GhostTracker/src/core),
 * so the app runs the same code the core tests check. This file keeps only
 * the display formatting and elevation helpers the app needs.
 */

export { haversineDistanceKm, haversineDistanceM } from '../../../GhostTracker/src/core/spatial/haversine';
export { calculateRII, getRIIStatus } from '../../../GhostTracker/src/core/fairness/riiEngine';

// ── Pace Calculator ───────────────────────────────────────

/** Average pace in s/km for a distance (m) and time (s); Infinity when either is 0. */
export { calculateAvgPace as calculatePace } from '../../../GhostTracker/src/core/spatial/paceCalculator';

export function formatPace(sPerKm: number): string {
  if (!isFinite(sPerKm) || sPerKm <= 0) return '--:--';
  const min = Math.floor(sPerKm / 60);
  const sec = Math.floor(sPerKm % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function formatTime(totalSeconds: number): string {
  const min = Math.floor(totalSeconds / 60);
  const sec = Math.floor(totalSeconds % 60);
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ── Elevation Helpers ─────────────────────────────────────

/**
 * Minimum altitude change (meters) to count as real elevation.
 * Changes smaller than this are treated as sensor noise.
 */
const ELEVATION_NOISE_THRESHOLD_M = 2;

/**
 * Calculate elevation gain and loss from an altitude delta.
 * Applies a dead-zone filter to reject barometric sensor jitter.
 *
 * @returns { gain, loss } — both are non-negative values
 */
export function calculateElevationDelta(
  prevAltitude: number | null,
  currAltitude: number | null,
): { gain: number; loss: number } {
  if (prevAltitude === null || currAltitude === null) {
    return { gain: 0, loss: 0 };
  }
  const delta = currAltitude - prevAltitude;
  if (delta > ELEVATION_NOISE_THRESHOLD_M) {
    return { gain: delta, loss: 0 };
  }
  if (delta < -ELEVATION_NOISE_THRESHOLD_M) {
    return { gain: 0, loss: Math.abs(delta) };
  }
  return { gain: 0, loss: 0 };
}
