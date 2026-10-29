/**
 * Ghost Comparator
 * 
 * Real-time comparison engine between the user's live position
 * and their Personal Best (Ghost) position at the same elapsed time.
 * 
 * The Ghost is a sequence of coordinates from the user's PB run.
 * At each second of the live run, we compare the live position
 * against where the Ghost was at the same elapsed time.
 */

import { TelemetryPoint, GhostRecord, PaceData } from '../../data/models';
import { haversineDistanceM } from '../spatial/haversine';
import { calculateInstantPace } from '../spatial/paceCalculator';
import { calculateRII } from './riiEngine';
import { GHOST_CHECKPOINT_INTERVAL_M } from '../../utils/constants';

/**
 * Find the Ghost record that corresponds to the current elapsed time.
 * Uses linear interpolation between ghost points for sub-second accuracy.
 * 
 * @param ghostRecords - Sorted array of Ghost records (by seqIndex)
 * @param elapsedTimeMs - Elapsed time since session start in milliseconds
 * @param ghostStartTime - The timestamp of the ghost's first point
 * @returns The matched ghost record, or null if out of bounds
 */
export function matchGhostPosition(
  ghostRecords: GhostRecord[],
  elapsedTimeMs: number,
  ghostStartTime: number,
): GhostRecord | null {
  if (ghostRecords.length === 0) {
    return null;
  }

  const targetTimestamp = ghostStartTime + elapsedTimeMs;

  // Binary search for the nearest ghost record
  let low = 0;
  let high = ghostRecords.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (ghostRecords[mid].timestamp < targetTimestamp) {
      low = mid + 1;
    } else if (ghostRecords[mid].timestamp > targetTimestamp) {
      high = mid - 1;
    } else {
      return ghostRecords[mid]; // Exact match
    }
  }

  // Return the closest point (prefer the one before if between two points)
  if (high < 0) {
    return ghostRecords[0];
  }
  if (low >= ghostRecords.length) {
    return ghostRecords[ghostRecords.length - 1];
  }

  // Return the nearer point
  const diffLow = Math.abs(ghostRecords[low].timestamp - targetTimestamp);
  const diffHigh = Math.abs(ghostRecords[high].timestamp - targetTimestamp);
  return diffLow < diffHigh ? ghostRecords[low] : ghostRecords[high];
}

/**
 * Calculate the lead/lag distance between the user and their Ghost.
 * 
 * Positive = user is AHEAD of the Ghost
 * Negative = user is BEHIND the Ghost
 * 
 * @param livePoint - Current live telemetry point
 * @param ghostPoint - Matched ghost position
 * @param routeDirection - Direction along the route for sign determination
 * @returns Distance ahead/behind in meters
 */
export function calculateLeadLagM(
  livePoints: TelemetryPoint[],
  ghostRecords: GhostRecord[],
  currentSeqIndex: number,
): number {
  if (livePoints.length < 2 || ghostRecords.length < 2 || currentSeqIndex < 1) {
    return 0;
  }

  // Calculate cumulative distance for live run up to current index
  let liveDistance = 0;
  const maxLiveIdx = Math.min(currentSeqIndex, livePoints.length - 1);
  for (let i = 1; i <= maxLiveIdx; i++) {
    liveDistance += haversineDistanceM(
      livePoints[i - 1].latitude,
      livePoints[i - 1].longitude,
      livePoints[i].latitude,
      livePoints[i].longitude,
    );
  }

  // Calculate cumulative distance for ghost up to same index
  let ghostDistance = 0;
  const maxGhostIdx = Math.min(currentSeqIndex, ghostRecords.length - 1);
  for (let i = 1; i <= maxGhostIdx; i++) {
    ghostDistance += haversineDistanceM(
      ghostRecords[i - 1].latitude,
      ghostRecords[i - 1].longitude,
      ghostRecords[i].latitude,
      ghostRecords[i].longitude,
    );
  }

  // Positive = ahead, Negative = behind
  return liveDistance - ghostDistance;
}

/**
 * Generate complete pace comparison data for the UI.
 * This is called every second during an active run.
 * 
 * @param livePoints - All live telemetry points so far
 * @param ghostRecords - All ghost records for this route
 * @param sessionStartTime - When the live session started
 * @returns PaceData object for the UI
 */
export function generatePaceData(
  livePoints: TelemetryPoint[],
  ghostRecords: GhostRecord[],
  sessionStartTime: number,
): PaceData {
  const defaultPaceData: PaceData = {
    currentPaceSPerKm: Infinity,
    ghostPaceSPerKm: Infinity,
    riiScore: 0,
    distanceAheadM: 0,
    elapsedTimeS: 0,
  };

  if (livePoints.length < 2 || ghostRecords.length < 2) {
    return defaultPaceData;
  }

  const currentIdx = livePoints.length - 1;
  const currentPoint = livePoints[currentIdx];
  const prevPoint = livePoints[currentIdx - 1];

  // Current live pace
  const currentPace = calculateInstantPace(prevPoint, currentPoint);

  // Ghost pace at the same seq index
  const ghostIdx = Math.min(currentIdx, ghostRecords.length - 1);
  const ghostPace =
    ghostRecords[ghostIdx].paceSPerKm !== null
      ? ghostRecords[ghostIdx].paceSPerKm!
      : Infinity;

  // RII score
  const riiScore = calculateRII(ghostPace, currentPace);

  // Lead/lag distance
  const distanceAhead = calculateLeadLagM(
    livePoints,
    ghostRecords,
    currentIdx,
  );

  // Elapsed time
  const elapsedTimeS = (currentPoint.timestamp - sessionStartTime) / 1000;

  return {
    currentPaceSPerKm: currentPace,
    ghostPaceSPerKm: ghostPace,
    riiScore,
    distanceAheadM: distanceAhead,
    elapsedTimeS,
  };
}

// ============================================================
// Distance-based ghost: ±Δt at every 10 m (thesis §3.5, FRS-06)
// ============================================================

/** Elapsed time of the personal-best run when it passed a distance mark. */
export interface GhostCheckpoint {
  distanceM: number;
  elapsedS: number;
}

/**
 * Time gap at one distance mark: live elapsed time minus the ghost's.
 * Negative = ahead of the ghost, positive = behind (split-time convention).
 */
export interface GhostSplit {
  distanceM: number;
  deltaS: number;
}

type TrackPoint = Pick<TelemetryPoint, 'latitude' | 'longitude' | 'timestamp'>;

/**
 * Build the checkpoint table from a personal-best track: the elapsed time at
 * 0, 10, 20 … m, by linear interpolation between the recorded fixes.
 *
 * @param track - The PB run's accepted points, in time order
 * @param intervalM - Checkpoint spacing (default 10 m)
 * @returns Checkpoints, empty if the track is shorter than one interval
 */
export function buildGhostCheckpoints(
  track: TrackPoint[],
  intervalM: number = GHOST_CHECKPOINT_INTERVAL_M,
): GhostCheckpoint[] {
  if (track.length < 2 || intervalM <= 0) {
    return [];
  }

  const t0 = track[0].timestamp;
  const checkpoints: GhostCheckpoint[] = [{ distanceM: 0, elapsedS: 0 }];
  let travelledM = 0;
  let nextMark = intervalM;

  for (let i = 1; i < track.length; i++) {
    const stepM = haversineDistanceM(
      track[i - 1].latitude,
      track[i - 1].longitude,
      track[i].latitude,
      track[i].longitude,
    );
    if (stepM <= 0) {
      continue;
    }
    const startS = (track[i - 1].timestamp - t0) / 1000;
    const endS = (track[i].timestamp - t0) / 1000;

    // 1e-9 m tolerance so a mark reached exactly at a fix is not lost to rounding
    while (travelledM + stepM >= nextMark - 1e-9) {
      const fraction = Math.min(1, (nextMark - travelledM) / stepM);
      checkpoints.push({ distanceM: nextMark, elapsedS: startS + fraction * (endS - startS) });
      nextMark += intervalM;
    }
    travelledM += stepM;
  }

  return checkpoints.length >= 2 ? checkpoints : [];
}

/**
 * The ghost's elapsed time at a distance, interpolated between checkpoints.
 *
 * @returns Seconds, or null if the distance is outside the ghost's run
 */
export function interpolateCheckpoint(
  checkpoints: GhostCheckpoint[],
  distanceM: number,
): number | null {
  if (checkpoints.length < 2 || distanceM < 0) {
    return null;
  }
  const last = checkpoints[checkpoints.length - 1];
  if (distanceM > last.distanceM) {
    return null;
  }

  const intervalM = checkpoints[1].distanceM - checkpoints[0].distanceM;
  const k = Math.min(Math.floor(distanceM / intervalM), checkpoints.length - 2);
  const a = checkpoints[k];
  const b = checkpoints[k + 1];
  const fraction = (distanceM - a.distanceM) / (b.distanceM - a.distanceM);
  return a.elapsedS + fraction * (b.elapsedS - a.elapsedS);
}

/**
 * Time gap to the ghost at the same distance: Δt = live elapsed − ghost elapsed.
 * Negative = ahead, positive = behind.
 *
 * @returns Seconds, or null once the live run is past the ghost's last checkpoint
 */
export function evaluateGhostDelta(
  checkpoints: GhostCheckpoint[],
  distanceM: number,
  elapsedS: number,
): number | null {
  const ghostS = interpolateCheckpoint(checkpoints, distanceM);
  return ghostS === null ? null : elapsedS - ghostS;
}

/**
 * Where the ghost is after a given time, for drawing it on the map.
 * Clamped to the ghost's finish once its run is over.
 */
export function ghostDistanceAtTime(
  checkpoints: GhostCheckpoint[],
  elapsedS: number,
): number {
  if (checkpoints.length < 2 || elapsedS <= 0) {
    return 0;
  }
  const last = checkpoints[checkpoints.length - 1];
  if (elapsedS >= last.elapsedS) {
    return last.distanceM;
  }

  // First checkpoint reached after elapsedS
  let low = 1;
  let high = checkpoints.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (checkpoints[mid].elapsedS < elapsedS) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const a = checkpoints[low - 1];
  const b = checkpoints[low];
  const spanS = b.elapsedS - a.elapsedS;
  const fraction = spanS > 0 ? (elapsedS - a.elapsedS) / spanS : 1;
  return a.distanceM + fraction * (b.distanceM - a.distanceM);
}

/**
 * Live ghost comparison. Call update() with the running distance and elapsed
 * time after every accepted fix; it returns one split for each 10 m mark
 * crossed since the previous call, timing the crossing by interpolation.
 */
export class GhostPacer {
  private prevDistanceM = 0;
  private prevElapsedS = 0;
  private latestSplit: GhostSplit | null = null;
  private readonly intervalM: number;

  constructor(private readonly checkpoints: GhostCheckpoint[]) {
    this.intervalM =
      checkpoints.length >= 2 ? checkpoints[1].distanceM - checkpoints[0].distanceM : 0;
  }

  update(distanceM: number, elapsedS: number): GhostSplit[] {
    const splits: GhostSplit[] = [];
    if (this.intervalM <= 0 || distanceM <= this.prevDistanceM) {
      this.prevElapsedS = Math.max(this.prevElapsedS, elapsedS);
      return splits;
    }

    const lastMarkM = this.checkpoints[this.checkpoints.length - 1].distanceM;
    const travelledM = distanceM - this.prevDistanceM;
    const spanS = elapsedS - this.prevElapsedS;
    let mark = (Math.floor(this.prevDistanceM / this.intervalM + 1e-9) + 1) * this.intervalM;

    while (mark <= distanceM + 1e-9 && mark <= lastMarkM + 1e-9) {
      const crossedS = this.prevElapsedS + ((mark - this.prevDistanceM) / travelledM) * spanS;
      const ghostS = this.checkpoints[Math.round(mark / this.intervalM)].elapsedS;
      splits.push({ distanceM: mark, deltaS: crossedS - ghostS });
      mark += this.intervalM;
    }

    this.prevDistanceM = distanceM;
    this.prevElapsedS = elapsedS;
    if (splits.length > 0) {
      this.latestSplit = splits[splits.length - 1];
    }
    return splits;
  }

  /** The most recent split, or null before the first 10 m mark. */
  get latest(): GhostSplit | null {
    return this.latestSplit;
  }

  /** True once the live run has passed the ghost's last checkpoint. */
  get finished(): boolean {
    return (
      this.checkpoints.length >= 2 &&
      this.prevDistanceM > this.checkpoints[this.checkpoints.length - 1].distanceM
    );
  }
}
