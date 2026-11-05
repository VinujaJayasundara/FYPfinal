/**
 * Track processor — turns the raw 1 Hz location stream into a clean track and
 * a distance that agrees between phones with different GPS quality.
 *
 * Found in a real test (4–5 Nov 2026): two phones in the same hand over a
 * 2 km race; the phone with the noisier GPS zig-zagged around the true path
 * and summed ~32 m more, because every raw fix-to-fix step was added.
 *
 * Stages, in order (the first three are thesis Table 12; 2 is stricter, and
 * 4–6 are added after that test):
 *   0. coordinate sanity
 *   1. temporal gate      ≥ 1,000 ms since the last accepted fix (1 Hz)
 *   2. accuracy gate      r_acc ≤ maxAccuracyM (default 20 m; thesis bound 50 m)
 *   3. velocity clamp     v_inst ≤ maxSpeedMs (thesis 6.94 m/s), measured from
 *                         the filter's predicted position with the fix's own
 *                         accuracy allowed for (raw fix-to-fix speed rejects
 *                         honest fixes on a noisy phone: ±6 m jitter alone is
 *                         ~12 m between two fixes); after `jumpResetAfter`
 *                         rejections in a row the filter re-anchors there (e.g.
 *                         after a tunnel) without adding distance
 *   4. warm-up            the first `warmupFixes` good fixes only seed the
 *                         filter (accuracy is still settling at the start)
 *   5. Kalman smoothing   constant-velocity filter per axis (position and
 *                         speed, in metres), each fix weighted by its reported
 *                         accuracy. No lag at a steady pace, so a noisy and a
 *                         clean phone stay level (a position-only filter would
 *                         trail the noisy phone by ~10 m)
 *   6. distance           filtered speed × time while moving (speed ≥
 *                         minMovingSpeedMs), not the sum of fix-to-fix steps
 *                         (sideways jitter inflates those). It is held as
 *                         pending until the smoothed position has really moved
 *                         a step (≥ max(minStepM, accuracy × stepPerAccuracy))
 *                         from the last route point; pending with no confirmed
 *                         step for pendingTimeoutS is dropped, so standing
 *                         still adds nothing. Route points = confirmed steps.
 *
 * Pure and deterministic (tested); the app feeds every raw fix in order.
 */

import { haversineDistanceM } from './haversine';
import { GPS_SAMPLE_INTERVAL_MS, MAX_VELOCITY_MS } from '../../utils/constants';

export interface RawFix {
  latitude: number;
  longitude: number;
  timestamp: number;
  /** Horizontal accuracy radius (m), or null if the device gave none. */
  accuracy: number | null;
  altitude?: number | null;
  speed?: number | null;
}

export interface TrackConfig {
  maxAccuracyM: number;
  maxSpeedMs: number;
  warmupFixes: number;
  minStepM: number;
  /**
   * How distance is measured: 'speed' integrates the filtered speed (|v|·dt)
   * while moving — not inflated by sideways jitter; 'chord' sums the steps
   * between counted route points.
   */
  distanceMode: 'speed' | 'chord';
  /**
   * 'speed' mode: speed·dt is held as pending until a real step confirms
   * movement; pending older than this (s) without a confirmed step is
   * dropped (standing still).
   */
  pendingTimeoutS: number;
  /** Minimum step also scales with the fix accuracy: max(minStepM, accuracy × this). */
  stepPerAccuracy: number;
  /** Below this filtered speed (m/s) the runner counts as standing still. */
  minMovingSpeedMs: number;
  /** Kalman process noise: how quickly the runner may change speed (m/s²). */
  accelNoise: number;
  /** Consecutive velocity rejections after which the track re-anchors. */
  jumpResetAfter: number;
  minIntervalMs: number;
}

export const DEFAULT_TRACK_CONFIG: TrackConfig = {
  maxAccuracyM: 20,
  maxSpeedMs: MAX_VELOCITY_MS,
  warmupFixes: 3,
  minStepM: 4,
  distanceMode: 'speed',
  pendingTimeoutS: 20,
  stepPerAccuracy: 1.5,
  minMovingSpeedMs: 1.0,
  accelNoise: 0.3,
  jumpResetAfter: 5,
  minIntervalMs: GPS_SAMPLE_INTERVAL_MS,
};

export type TrackStage = 'INVALID' | 'TEMPORAL' | 'ACCURACY' | 'VELOCITY' | 'WARMUP';

export interface TrackPoint {
  latitude: number;
  longitude: number;
  timestamp: number;
  altitude: number | null;
  accuracy: number | null;
}

export interface TrackResult {
  /** Fix passed the gates and updated the smoothed position. */
  accepted: boolean;
  /** Why it was not used (accepted = false), or WARMUP while seeding. */
  stage: TrackStage | null;
  /** Smoothed position after this fix (null until the first good fix). */
  smoothed: TrackPoint | null;
  /** True when this fix added a route point (and possibly distance). */
  counted: boolean;
  /** Distance added by this fix (m). */
  addedM: number;
  /** Total filtered distance so far (m). */
  distanceM: number;
}

const M_PER_DEG_LAT = 111_320;

/** One axis of a constant-velocity Kalman filter: state [p, v], covariance P. */
interface Axis {
  p: number;
  v: number;
  p00: number;
  p01: number;
  p10: number;
  p11: number;
}

function newAxis(z: number, r: number): Axis {
  // Unknown speed at start: up to ~3 m/s (variance 9)
  return { p: z, v: 0, p00: r, p01: 0, p10: 0, p11: 9 };
}

function stepAxis(a: Axis, z: number, r: number, dt: number, q: number): void {
  // Predict: p += v·dt; P = F P Fᵀ + Q (white-acceleration model)
  a.p += a.v * dt;
  const q2 = q * q;
  const p00 = a.p00 + dt * (a.p10 + a.p01) + dt * dt * a.p11 + q2 * (dt ** 4) / 4;
  const p01 = a.p01 + dt * a.p11 + q2 * (dt ** 3) / 2;
  const p10 = a.p10 + dt * a.p11 + q2 * (dt ** 3) / 2;
  const p11 = a.p11 + q2 * dt * dt;
  // Update with the measured position (variance r = accuracy²)
  const s = p00 + r;
  const k0 = p00 / s;
  const k1 = p10 / s;
  const y = z - a.p;
  a.p += k0 * y;
  a.v += k1 * y;
  a.p00 = (1 - k0) * p00;
  a.p01 = (1 - k0) * p01;
  a.p10 = p10 - k1 * p00;
  a.p11 = p11 - k1 * p01;
}

export class TrackProcessor {
  private cfg: TrackConfig;
  private lastAccepted: RawFix | null = null;
  private goodFixes = 0;
  private velocityRejectsInRow = 0;
  // Kalman state per axis in local metres around an origin: [position, velocity]
  private origin: { lat: number; lon: number; mPerDegLon: number } | null = null;
  private kx: Axis | null = null;
  private ky: Axis | null = null;
  private lastFilterTime = 0;
  private prevTime = 0;
  private pending = 0;
  private lastStepTime = 0;
  private anchor: TrackPoint | null = null;
  private total = 0;
  private current: TrackPoint | null = null;
  private rejected: Record<TrackStage, number> = { INVALID: 0, TEMPORAL: 0, ACCURACY: 0, VELOCITY: 0, WARMUP: 0 };

  constructor(config: Partial<TrackConfig> = {}) {
    this.cfg = { ...DEFAULT_TRACK_CONFIG, ...config };
  }

  /** Confirmed distance plus movement still waiting for confirmation. */
  get distanceM(): number {
    return this.total + this.pending;
  }
  get position(): TrackPoint | null {
    return this.current;
  }
  get stats(): { rejected: Record<TrackStage, number> } {
    return { rejected: { ...this.rejected } };
  }
  get config(): TrackConfig {
    return { ...this.cfg };
  }

  reset(): void {
    this.lastAccepted = null;
    this.goodFixes = 0;
    this.velocityRejectsInRow = 0;
    this.origin = null;
    this.kx = null;
    this.ky = null;
    this.prevTime = 0;
    this.pending = 0;
    this.lastStepTime = 0;
    this.anchor = null;
    this.total = 0;
    this.current = null;
    this.rejected = { INVALID: 0, TEMPORAL: 0, ACCURACY: 0, VELOCITY: 0, WARMUP: 0 };
  }

  /** Feed one raw fix (in arrival order). */
  push(fix: RawFix): TrackResult {
    const reject = (stage: TrackStage): TrackResult => {
      this.rejected[stage]++;
      return { accepted: false, stage, smoothed: this.current, counted: false, addedM: 0, distanceM: this.total };
    };

    // 0. sanity
    if (
      !isFinite(fix.latitude) || !isFinite(fix.longitude) ||
      fix.latitude < -90 || fix.latitude > 90 || fix.longitude < -180 || fix.longitude > 180
    ) {
      return reject('INVALID');
    }

    // 1. temporal gate
    if (this.lastAccepted && fix.timestamp - this.lastAccepted.timestamp < this.cfg.minIntervalMs) {
      return reject('TEMPORAL');
    }

    // 2. accuracy gate
    if (fix.accuracy !== null && fix.accuracy > this.cfg.maxAccuracyM) {
      return reject('ACCURACY');
    }

    // 3. velocity clamp against the predicted position, allowing for the
    //    fix's accuracy (and the filter's own uncertainty)
    let reanchor = false;
    if (this.lastAccepted && this.kx && this.ky && this.origin) {
      const dt = (fix.timestamp - this.lastFilterTime) / 1000;
      const mx = (fix.longitude - this.origin.lon) * this.origin.mPerDegLon;
      const my = (fix.latitude - this.origin.lat) * M_PER_DEG_LAT;
      const px = this.kx.p + this.kx.v * dt;
      const py = this.ky.p + this.ky.v * dt;
      const miss = Math.hypot(mx - px, my - py);
      const allowance = this.cfg.maxSpeedMs * dt + 3 * Math.max(fix.accuracy ?? 10, 1) + 2 * Math.sqrt(this.kx.p00 + this.ky.p00);
      if (dt <= 0 || miss > allowance) {
        this.velocityRejectsInRow++;
        if (this.velocityRejectsInRow < this.cfg.jumpResetAfter) return reject('VELOCITY');
        // The jump persists: the runner really is over there (e.g. after a tunnel)
        reanchor = true;
      }
    }
    this.velocityRejectsInRow = 0;
    this.lastAccepted = fix;

    // 5. Kalman update (warm-up fixes also feed it, so it starts settled)
    this.filter(fix, reanchor);
    this.goodFixes++;

    // 4. warm-up: seed only
    if (this.goodFixes <= this.cfg.warmupFixes) {
      this.rejected.WARMUP++;
      return { accepted: true, stage: 'WARMUP', smoothed: this.current, counted: false, addedM: 0, distanceM: this.total };
    }

    // 6. distance and route
    const p = this.current!;
    const speedNow = Math.hypot(this.kx!.v, this.ky!.v);
    const dtS = this.prevTime > 0 ? (fix.timestamp - this.prevTime) / 1000 : 0;
    this.prevTime = fix.timestamp;
    let speedAdded = 0;
    if (this.cfg.distanceMode === 'speed') {
      if (!reanchor && speedNow >= this.cfg.minMovingSpeedMs && dtS > 0 && dtS <= 10) {
        speedAdded = speedNow * dtS;
        this.pending += speedAdded;
      }
      // No confirmed step for a while: it was jitter, not movement
      if (this.lastStepTime > 0 && (fix.timestamp - this.lastStepTime) / 1000 > this.cfg.pendingTimeoutS) {
        this.pending = 0;
        this.lastStepTime = fix.timestamp;
      }
    }
    if (this.anchor === null || reanchor) {
      this.anchor = p;
      this.pending = 0;
      this.lastStepTime = fix.timestamp;
      return { accepted: true, stage: null, smoothed: p, counted: true, addedM: 0, distanceM: this.distanceM };
    }
    const step = haversineDistanceM(this.anchor.latitude, this.anchor.longitude, p.latitude, p.longitude);
    const speed = Math.hypot(this.kx!.v, this.ky!.v);
    const minStep = Math.max(this.cfg.minStepM, (fix.accuracy ?? 0) * this.cfg.stepPerAccuracy);
    if (speed < this.cfg.minMovingSpeedMs || step < minStep) {
      return { accepted: true, stage: null, smoothed: p, counted: false, addedM: speedAdded, distanceM: this.distanceM };
    }
    // A real step: confirm the movement
    if (this.cfg.distanceMode === 'chord') this.total += step;
    else {
      this.total += this.pending;
      this.pending = 0;
    }
    this.lastStepTime = fix.timestamp;
    this.anchor = p;
    return {
      accepted: true,
      stage: null,
      smoothed: p,
      counted: true,
      addedM: this.cfg.distanceMode === 'chord' ? step : speedAdded,
      distanceM: this.distanceM,
    };
  }

  private filter(fix: RawFix, reanchor: boolean): void {
    const acc = Math.max(fix.accuracy ?? 10, 1);
    if (!this.origin) {
      this.origin = {
        lat: fix.latitude,
        lon: fix.longitude,
        mPerDegLon: M_PER_DEG_LAT * Math.cos((fix.latitude * Math.PI) / 180),
      };
    }
    const mx = (fix.longitude - this.origin.lon) * this.origin.mPerDegLon;
    const my = (fix.latitude - this.origin.lat) * M_PER_DEG_LAT;

    const r = acc * acc;
    if (!this.kx || !this.ky || reanchor) {
      this.kx = newAxis(mx, r);
      this.ky = newAxis(my, r);
    } else {
      const dt = Math.max(0.001, (fix.timestamp - this.lastFilterTime) / 1000);
      stepAxis(this.kx, mx, r, dt, this.cfg.accelNoise);
      stepAxis(this.ky, my, r, dt, this.cfg.accelNoise);
    }
    this.lastFilterTime = fix.timestamp;
    this.current = {
      latitude: this.origin.lat + this.ky.p / M_PER_DEG_LAT,
      longitude: this.origin.lon + this.kx.p / this.origin.mPerDegLon,
      timestamp: fix.timestamp,
      altitude: fix.altitude ?? null,
      accuracy: fix.accuracy,
    };
  }
}

/** Run a whole recorded stream through a processor (tests, re-analysis). */
export function processTrack(fixes: RawFix[], config: Partial<TrackConfig> = {}): { distanceM: number; route: TrackPoint[]; processor: TrackProcessor } {
  const p = new TrackProcessor(config);
  const route: TrackPoint[] = [];
  for (const f of fixes) {
    const r = p.push(f);
    if (r.counted && r.smoothed) route.push(r.smoothed);
  }
  return { distanceM: p.distanceM, route, processor: p };
}
