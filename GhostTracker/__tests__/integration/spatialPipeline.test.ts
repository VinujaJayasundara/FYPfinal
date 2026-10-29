/**
 * Integration Test IT-01: Spatial-to-Geodesic pipeline (thesis Table 27)
 *
 * A 1 Hz stream with 20 % injected noise goes through
 *   GpsFilter (1 Hz → accuracy → velocity) → haversine → RollingPaceWindow
 * and must drop every noisy fix, keep the distance within 1 % of the clean
 * track, and produce a smooth pace with no NaN or Infinity.
 *
 * The clean track is generated here with known geometry (two laps of a
 * 100 m-radius circle at 5:00 /km), so the true distance is known exactly.
 * The bundled bellanwila_telemetry.json sessions are generated with heavy
 * jitter and have no ground-truth distance, so they are only used for the
 * "no NaN / Infinity" check.
 */

import { GpsFilter } from '../../src/core/spatial/gpsFilter';
import { haversineDistanceM } from '../../src/core/spatial/haversine';
import { RollingPaceWindow } from '../../src/core/spatial/paceCalculator';
import { TelemetryPoint } from '../../src/data/models';
import { EARTH_RADIUS_M } from '../../src/utils/constants';
import bellanwila from '../../scripts/test_data/bellanwila_telemetry.json';

const CENTER = { latitude: 6.8413, longitude: 79.8815 };
const RADIUS_M = 100;
const SPEED_MS = 1000 / 300; // 5:00 /km
const DURATION_S = Math.round((2 * 2 * Math.PI * RADIUS_M) / SPEED_MS); // two laps
const T0 = 1_793_000_000_000;

/** Deterministic PRNG (mulberry32) so the noise is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Point at a bearing and distance from CENTER (flat-earth offset; fine at 100 m). */
function offset(northM: number, eastM: number) {
  const latRad = (CENTER.latitude * Math.PI) / 180;
  return {
    latitude: CENTER.latitude + (northM / EARTH_RADIUS_M) * (180 / Math.PI),
    longitude: CENTER.longitude + (eastM / (EARTH_RADIUS_M * Math.cos(latRad))) * (180 / Math.PI),
  };
}

function makePoint(seqIndex: number, timestamp: number, pos: { latitude: number; longitude: number }, accuracy = 5): TelemetryPoint {
  return { id: `p${seqIndex}`, sessionId: 'it-01', ...pos, timestamp, velocity: null, accuracy, seqIndex };
}

/** True position on the circle after `s` seconds. */
function positionAt(s: number) {
  const angle = (s * SPEED_MS) / RADIUS_M;
  return offset(RADIUS_M * Math.cos(angle), RADIUS_M * Math.sin(angle));
}

function cleanTrack(): TelemetryPoint[] {
  return Array.from({ length: DURATION_S + 1 }, (_, s) => makePoint(s, T0 + s * 1000, positionAt(s)));
}

function trackDistanceM(points: TelemetryPoint[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += haversineDistanceM(points[i - 1].latitude, points[i - 1].longitude, points[i].latitude, points[i].longitude);
  }
  return d;
}

/**
 * Inject noise into the clean 1 Hz stream:
 * - one fix in every block of five is replaced by a spike 40–150 m away
 *   (20 %); one spike in four also reports a poor accuracy (60–120 m)
 * - one clean fix in ten is followed by an extra fix 400 ms later (faster
 *   than 1 Hz), at its true position for that moment
 */
function noisyStream(clean: TelemetryPoint[]) {
  const random = prng(2026);
  const stream: TelemetryPoint[] = [];
  let spikes = 0;
  let extras = 0;
  let seq = 0;

  for (let block = 0; block < clean.length; block += 5) {
    // never spike the very first fix: the filter needs a clean reference
    const spikeAt = block === 0 ? 1 + Math.floor(random() * 4) : block + Math.floor(random() * 5);
    for (let i = block; i < Math.min(block + 5, clean.length); i++) {
      const p = clean[i];
      if (i === spikeAt) {
        const bearing = random() * 2 * Math.PI;
        const jumpM = 40 + random() * 110;
        const pos = {
          latitude: p.latitude + (jumpM * Math.cos(bearing) / EARTH_RADIUS_M) * (180 / Math.PI),
          longitude: p.longitude + (jumpM * Math.sin(bearing) / EARTH_RADIUS_M) * (180 / Math.PI),
        };
        stream.push(makePoint(seq++, p.timestamp, pos, random() < 0.25 ? 60 + random() * 60 : 5));
        spikes++;
      } else {
        stream.push({ ...p, seqIndex: seq++ });
      }
      if (i % 10 === 3 && i !== spikeAt) {
        stream.push(makePoint(seq++, p.timestamp + 400, positionAt(i + 0.4)));
        extras++;
      }
    }
  }
  return { stream, spikes, extras };
}

function runPipeline(stream: TelemetryPoint[]) {
  const filter = new GpsFilter();
  const window = new RollingPaceWindow();
  const accepted: TelemetryPoint[] = [];
  const paces: Array<{ timestamp: number; pace: number }> = [];
  let distanceM = 0;

  for (const raw of stream) {
    const fix = filter.sanitizeFix(raw);
    if (!fix) continue;
    const prev = accepted[accepted.length - 1];
    if (prev) {
      distanceM += haversineDistanceM(prev.latitude, prev.longitude, fix.latitude, fix.longitude);
    }
    accepted.push(fix);
    paces.push({ timestamp: fix.timestamp, pace: window.push(fix) });
  }
  return { filter, accepted, paces, distanceM };
}

describe('IT-01: Spatial-to-Geodesic pipeline', () => {
  const clean = cleanTrack();
  const cleanDistanceM = trackDistanceM(clean);
  const { stream, spikes, extras } = noisyStream(clean);
  const result = runPipeline(stream);

  test('the injected noise is 20 % of the 1 Hz fixes', () => {
    expect(spikes / clean.length).toBeCloseTo(0.2, 2);
    expect(stream.length).toBe(clean.length + extras);
  });

  test('every noisy fix is dropped, at the right stage', () => {
    const { rejected, accepted } = result.filter.stats;
    expect(rejected.TEMPORAL).toBe(extras);
    expect(rejected.ACCURACY + rejected.VELOCITY).toBe(spikes);
    expect(rejected.ACCURACY).toBeGreaterThan(0);
    expect(accepted).toBe(clean.length - spikes);
  });

  test('distance stays within 1 % of the clean track', () => {
    expect(cleanDistanceM).toBeCloseTo(2 * 2 * Math.PI * RADIUS_M, -1);
    const errorPct = (Math.abs(result.distanceM - cleanDistanceM) / cleanDistanceM) * 100;
    expect(errorPct).toBeLessThan(1);
  });

  test('rolling pace has no NaN or Infinity', () => {
    result.paces.forEach(({ pace }) => expect(Number.isFinite(pace)).toBe(true));
  });

  test('once the 10 s window is full, pace stays within 2 % of 5:00 /km and changes smoothly', () => {
    const settled = result.paces.filter(p => p.timestamp - T0 >= 10_000);
    settled.forEach(({ pace }) => expect(Math.abs(pace - 300) / 300).toBeLessThan(0.02));
    for (let i = 1; i < settled.length; i++) {
      expect(Math.abs(settled[i].pace - settled[i - 1].pace)).toBeLessThan(5);
    }
  });

  test('bundled test sessions produce finite distance and pace values', () => {
    const bySession = new Map<string, TelemetryPoint[]>();
    for (const t of bellanwila.telemetry) {
      const p: TelemetryPoint = {
        id: t.id,
        sessionId: t.session_id,
        latitude: t.latitude,
        longitude: t.longitude,
        timestamp: t.timestamp,
        velocity: t.velocity,
        accuracy: t.accuracy,
        seqIndex: t.seq_index,
      };
      bySession.set(p.sessionId, [...(bySession.get(p.sessionId) ?? []), p]);
    }
    expect(bySession.size).toBe(5);
    for (const points of bySession.values()) {
      const out = runPipeline(points);
      expect(out.accepted.length).toBeGreaterThan(0);
      expect(Number.isFinite(out.distanceM)).toBe(true);
      out.paces.forEach(({ pace }) => expect(Number.isFinite(pace)).toBe(true));
    }
  });
});
