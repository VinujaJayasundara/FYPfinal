/**
 * GPS Noise Filter
 *
 * Filters out invalid GPS readings caused by:
 * - Multipath interference (signal bouncing off buildings)
 * - GPS drift when stationary
 * - Vehicle spoofing (moving too fast for a runner)
 * - Low-accuracy satellite fixes
 *
 * This is a critical anti-cheat component and data quality gate.
 *
 * The live pipeline (GpsFilter.sanitizeFix) applies the stages of thesis
 * Table 12 in order:
 *   0. Coordinate sanity   lat/lon present and in range
 *   1. Temporal gate       Δt ≥ 1,000 ms since the last accepted fix (1 Hz grid)
 *   2. Accuracy gate       r_acc ≤ 50.0 m
 *   3. Velocity clamp      v_inst ≤ 6.94 m/s (25 km/h), measured between the
 *                          last accepted fix and this one
 * A rejected fix returns null and does not become the reference for the next fix.
 */

import {
  MAX_VELOCITY_KMH,
  MAX_VELOCITY_MS,
  MAX_ACCURACY_M,
  GPS_SAMPLE_INTERVAL_MS,
} from '../../utils/constants';
import { TelemetryPoint } from '../../data/models';
import { haversineDistanceM } from './haversine';

/**
 * Result of a GPS validation check.
 */
export interface ValidationResult {
  isValid: boolean;
  rejectionReason: string | null;
}

/**
 * The fields of a fix the filter reads. TelemetryPoint satisfies it, and so
 * does any app-side point that carries the same fields.
 */
export type GpsFix = Pick<TelemetryPoint, 'latitude' | 'longitude' | 'timestamp' | 'velocity' | 'accuracy'>;

/** Pipeline stage that rejected a fix (thesis Table 12). */
export type FilterStage = 'INVALID' | 'TEMPORAL' | 'ACCURACY' | 'VELOCITY';

export interface FilterRejection {
  stage: FilterStage;
  reason: string;
}

export interface FilterStats {
  accepted: number;
  rejected: Record<FilterStage, number>;
}

function checkCoordinates(point: GpsFix): string | null {
  if (
    point.latitude === null ||
    point.longitude === null ||
    isNaN(point.latitude) ||
    isNaN(point.longitude)
  ) {
    return 'NULL_COORDINATES';
  }
  if (point.latitude < -90 || point.latitude > 90) {
    return 'LATITUDE_OUT_OF_BOUNDS';
  }
  if (point.longitude < -180 || point.longitude > 180) {
    return 'LONGITUDE_OUT_OF_BOUNDS';
  }
  return null;
}

/**
 * Validate a single telemetry point against quality thresholds.
 * Uses the device-reported speed, so it works without a previous point.
 *
 * @param point - The telemetry point to validate
 * @returns Validation result with reason if rejected
 */
export function validateTelemetryPoint(point: TelemetryPoint): ValidationResult {
  // 1. Check for null/invalid coordinates and bounds
  const coordinateError = checkCoordinates(point);
  if (coordinateError) {
    return { isValid: false, rejectionReason: coordinateError };
  }

  // 2. Check velocity threshold (anti-spoofing / spike rejection)
  if (point.velocity !== null && point.velocity * 3.6 > MAX_VELOCITY_KMH) {
    return {
      isValid: false,
      rejectionReason: `VELOCITY_EXCEEDED: ${(point.velocity * 3.6).toFixed(1)} km/h > ${MAX_VELOCITY_KMH} km/h`,
    };
  }

  // 3. Check GPS accuracy
  if (point.accuracy !== null && point.accuracy > MAX_ACCURACY_M) {
    return {
      isValid: false,
      rejectionReason: `LOW_ACCURACY: ${point.accuracy.toFixed(1)}m > ${MAX_ACCURACY_M}m threshold`,
    };
  }

  return { isValid: true, rejectionReason: null };
}

/**
 * Validate a telemetry point against its predecessor (temporal consistency).
 * Detects impossible teleportation (GPS spikes).
 *
 * @param prev - Previous telemetry point
 * @param curr - Current telemetry point
 * @returns Validation result
 */
export function validatePointPair(
  prev: GpsFix,
  curr: GpsFix,
): ValidationResult {
  // Check temporal ordering
  if (curr.timestamp <= prev.timestamp) {
    return { isValid: false, rejectionReason: 'TIMESTAMP_NOT_MONOTONIC' };
  }

  const speedMs = impliedSpeedMs(prev, curr);
  if (speedMs > MAX_VELOCITY_MS) {
    return {
      isValid: false,
      rejectionReason: `IMPLIED_SPEED_EXCEEDED: ${speedMs.toFixed(2)} m/s (${(speedMs * 3.6).toFixed(1)} km/h, teleportation detected)`,
    };
  }

  return { isValid: true, rejectionReason: null };
}

/**
 * Instantaneous speed between two fixes, v_inst = d / Δt (thesis Eq. 3.20).
 * Returns Infinity when Δt ≤ 0.
 */
export function impliedSpeedMs(prev: GpsFix, curr: GpsFix): number {
  const timeDeltaS = (curr.timestamp - prev.timestamp) / 1000;
  if (timeDeltaS <= 0) {
    return Infinity;
  }
  const distanceM = haversineDistanceM(
    prev.latitude,
    prev.longitude,
    curr.latitude,
    curr.longitude,
  );
  return distanceM / timeDeltaS;
}

/**
 * Stateful live filter. Feed it every raw fix in arrival order; it returns the
 * fix if it passes all stages, or null if any stage rejects it.
 */
export class GpsFilter {
  private last: GpsFix | null = null;
  private rejection: FilterRejection | null = null;
  private counts: FilterStats = {
    accepted: 0,
    rejected: { INVALID: 0, TEMPORAL: 0, ACCURACY: 0, VELOCITY: 0 },
  };

  /**
   * Run one fix through the pipeline.
   *
   * @param fix - Raw fix from the location service
   * @returns The same fix if accepted, otherwise null
   */
  sanitizeFix<T extends GpsFix>(fix: T): T | null {
    const rejection = this.check(fix);
    this.rejection = rejection;
    if (rejection) {
      this.counts.rejected[rejection.stage]++;
      return null;
    }
    this.last = fix;
    this.counts.accepted++;
    return fix;
  }

  /** Why the most recent fix was rejected, or null if it was accepted. */
  get lastRejection(): FilterRejection | null {
    return this.rejection;
  }

  /** The most recent accepted fix, the reference for the next velocity check. */
  get lastAccepted(): GpsFix | null {
    return this.last;
  }

  get stats(): FilterStats {
    return { accepted: this.counts.accepted, rejected: { ...this.counts.rejected } };
  }

  reset(): void {
    this.last = null;
    this.rejection = null;
    this.counts = {
      accepted: 0,
      rejected: { INVALID: 0, TEMPORAL: 0, ACCURACY: 0, VELOCITY: 0 },
    };
  }

  private check(fix: GpsFix): FilterRejection | null {
    // Stage 0: coordinate sanity
    const coordinateError = checkCoordinates(fix);
    if (coordinateError) {
      return { stage: 'INVALID', reason: coordinateError };
    }

    // Stage 1: 1 Hz temporal gate
    if (this.last) {
      const deltaMs = fix.timestamp - this.last.timestamp;
      if (deltaMs < GPS_SAMPLE_INTERVAL_MS) {
        return {
          stage: 'TEMPORAL',
          reason: `TEMPORAL_DOWNSAMPLED: ${deltaMs} ms < ${GPS_SAMPLE_INTERVAL_MS} ms since last accepted fix`,
        };
      }
    }

    // Stage 2: horizontal accuracy gate
    if (fix.accuracy !== null && fix.accuracy > MAX_ACCURACY_M) {
      return {
        stage: 'ACCURACY',
        reason: `LOW_ACCURACY: ${fix.accuracy.toFixed(1)}m > ${MAX_ACCURACY_M}m threshold`,
      };
    }

    // Stage 3: velocity clamp. Between fixes when there is a previous one;
    // for the very first fix only the device-reported speed is available.
    if (this.last) {
      const pair = validatePointPair(this.last, fix);
      if (!pair.isValid) {
        return { stage: 'VELOCITY', reason: pair.rejectionReason! };
      }
    } else if (fix.velocity !== null && fix.velocity > MAX_VELOCITY_MS) {
      return {
        stage: 'VELOCITY',
        reason: `VELOCITY_EXCEEDED: ${fix.velocity.toFixed(2)} m/s > ${MAX_VELOCITY_MS.toFixed(2)} m/s`,
      };
    }

    return null;
  }
}

/**
 * Filter an array of telemetry points, removing invalid readings.
 * Runs the same pipeline as the live filter, so batch and live results agree.
 *
 * @param points - Array of raw telemetry points, in time order
 * @returns Object containing valid points and rejection log
 */
export function filterTelemetry(points: TelemetryPoint[]): {
  validPoints: TelemetryPoint[];
  rejectedCount: number;
  rejectionLog: Array<{ seqIndex: number; reason: string }>;
} {
  const filter = new GpsFilter();
  const validPoints: TelemetryPoint[] = [];
  const rejectionLog: Array<{ seqIndex: number; reason: string }> = [];

  for (const point of points) {
    if (filter.sanitizeFix(point)) {
      validPoints.push(point);
    } else {
      rejectionLog.push({
        seqIndex: point.seqIndex,
        reason: filter.lastRejection!.reason,
      });
    }
  }

  return {
    validPoints,
    rejectedCount: rejectionLog.length,
    rejectionLog,
  };
}
