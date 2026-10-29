/**
 * Unit Tests: GPS Noise Filter
 */

import { validateTelemetryPoint, validatePointPair, filterTelemetry, GpsFilter } from '../../src/core/spatial/gpsFilter';
import { TelemetryPoint } from '../../src/data/models';
import { EARTH_RADIUS_M } from '../../src/utils/constants';

const LAT0 = 6.8413;

/** Latitude `metres` north of LAT0 on the same meridian (haversine is exact there). */
function northOf(metres: number): number {
  return LAT0 + (metres / EARTH_RADIUS_M) * (180 / Math.PI);
}

function makePoint(overrides: Partial<TelemetryPoint> = {}): TelemetryPoint {
  return {
    id: 'test-id',
    sessionId: 'test-session',
    latitude: 6.8413,
    longitude: 79.8815,
    timestamp: Date.now(),
    velocity: 2.5, // ~9 km/h — normal running speed
    accuracy: 5,
    seqIndex: 0,
    ...overrides,
  };
}

describe('GPS Noise Filter', () => {
  describe('validateTelemetryPoint', () => {
    test('should accept valid running point', () => {
      const result = validateTelemetryPoint(makePoint());
      expect(result.isValid).toBe(true);
    });

    test('should reject null coordinates', () => {
      const result = validateTelemetryPoint(makePoint({ latitude: NaN }));
      expect(result.isValid).toBe(false);
      expect(result.rejectionReason).toBe('NULL_COORDINATES');
    });

    test('should reject out-of-bounds latitude', () => {
      const result = validateTelemetryPoint(makePoint({ latitude: 91 }));
      expect(result.isValid).toBe(false);
      expect(result.rejectionReason).toBe('LATITUDE_OUT_OF_BOUNDS');
    });

    test('should reject out-of-bounds longitude', () => {
      const result = validateTelemetryPoint(makePoint({ longitude: -181 }));
      expect(result.isValid).toBe(false);
      expect(result.rejectionReason).toBe('LONGITUDE_OUT_OF_BOUNDS');
    });

    test('should reject velocity > 25 km/h (vehicle spoofing)', () => {
      // 25 km/h = 6.944 m/s
      const result = validateTelemetryPoint(makePoint({ velocity: 8.0 })); // 28.8 km/h
      expect(result.isValid).toBe(false);
      expect(result.rejectionReason).toContain('VELOCITY_EXCEEDED');
    });

    test('should accept velocity just under threshold', () => {
      const result = validateTelemetryPoint(makePoint({ velocity: 6.9 })); // 24.84 km/h
      expect(result.isValid).toBe(true);
    });

    test('should reject low accuracy readings', () => {
      const result = validateTelemetryPoint(makePoint({ accuracy: 60 })); // >50m threshold
      expect(result.isValid).toBe(false);
      expect(result.rejectionReason).toContain('LOW_ACCURACY');
    });

    test('should accept null velocity (GNSS may not report it)', () => {
      const result = validateTelemetryPoint(makePoint({ velocity: null }));
      expect(result.isValid).toBe(true);
    });
  });

  describe('validatePointPair', () => {
    test('should accept normally spaced points', () => {
      const prev = makePoint({ timestamp: 1000, latitude: 6.8413, seqIndex: 0 });
      const curr = makePoint({ timestamp: 2000, latitude: 6.84135, seqIndex: 1 }); // ~5.5m in 1s = ~20 km/h
      const result = validatePointPair(prev, curr);
      expect(result.isValid).toBe(true);
    });

    test('should reject teleportation (GPS spike)', () => {
      const prev = makePoint({ timestamp: 1000, latitude: 6.8413 });
      const curr = makePoint({ timestamp: 2000, latitude: 6.8500 }); // ~967m in 1s — impossible for running
      const result = validatePointPair(prev, curr);
      expect(result.isValid).toBe(false);
      expect(result.rejectionReason).toContain('IMPLIED_SPEED_EXCEEDED');
    });

    test('should reject non-monotonic timestamps', () => {
      const prev = makePoint({ timestamp: 2000 });
      const curr = makePoint({ timestamp: 1000 });
      const result = validatePointPair(prev, curr);
      expect(result.isValid).toBe(false);
      expect(result.rejectionReason).toBe('TIMESTAMP_NOT_MONOTONIC');
    });
  });

  describe('filterTelemetry', () => {
    test('should pass through all valid points', () => {
      const points = Array.from({ length: 10 }, (_, i) =>
        makePoint({
          seqIndex: i,
          timestamp: 1000 + i * 1000,
          latitude: 6.8413 + i * 0.00001, // ~1.1m per step
        }),
      );
      const result = filterTelemetry(points);
      expect(result.validPoints.length).toBe(10);
      expect(result.rejectedCount).toBe(0);
    });

    test('should filter out GPS spikes while keeping adjacent valid points', () => {
      const points = [
        makePoint({ seqIndex: 0, timestamp: 1000, latitude: 6.8413 }),
        makePoint({ seqIndex: 1, timestamp: 2000, latitude: 6.8414 }),
        makePoint({ seqIndex: 2, timestamp: 3000, latitude: 6.9000 }), // SPIKE — ~6.5km jump
        makePoint({ seqIndex: 3, timestamp: 4000, latitude: 6.8415 }),
        makePoint({ seqIndex: 4, timestamp: 5000, latitude: 6.8416 }),
      ];
      const result = filterTelemetry(points);
      expect(result.rejectedCount).toBeGreaterThan(0);
      expect(result.rejectionLog.some(r => r.reason.includes('IMPLIED_SPEED_EXCEEDED'))).toBe(true);
    });
  });

  // ── Thesis Table 12 pipeline (GpsFilter.sanitizeFix) ──────────────────

  describe('GpsFilter — thesis Table 12', () => {
    /** First fix at t = 0 on LAT0, then one candidate fix `metres` north after `deltaMs`. */
    function candidate(metres: number, deltaMs = 1000, overrides: Partial<TelemetryPoint> = {}) {
      const filter = new GpsFilter();
      expect(filter.sanitizeFix(makePoint({ timestamp: 0, latitude: LAT0, velocity: null }))).not.toBeNull();
      const fix = makePoint({ timestamp: deltaMs, latitude: northOf(metres), velocity: null, seqIndex: 1, ...overrides });
      return { filter, result: filter.sanitizeFix(fix) };
    }

    test('UT-01: fix with r_acc = 62.4 m is rejected and null is returned', () => {
      const { filter, result } = candidate(3, 1000, { accuracy: 62.4 });
      expect(result).toBeNull();
      expect(filter.lastRejection?.stage).toBe('ACCURACY');
    });

    test('UT-02: fix with v_inst = 9.20 m/s (33.1 km/h) is rejected as a spike', () => {
      const { filter, result } = candidate(9.2);
      expect(result).toBeNull();
      expect(filter.lastRejection?.stage).toBe('VELOCITY');
      expect(filter.lastRejection?.reason).toContain('33.1 km/h');
    });

    describe('BVA: horizontal accuracy 49.9 / 50.0 / 50.1 m', () => {
      test.each([
        [49.9, true],
        [50.0, true],
        [50.1, false],
      ])('r_acc = %p m → accepted %p', (accuracy, accepted) => {
        const { result } = candidate(3, 1000, { accuracy });
        expect(result !== null).toBe(accepted);
      });
    });

    describe('BVA: velocity clamp 6.93 / 6.94 / 6.95 m/s', () => {
      test.each([
        [6.93, true],
        [6.94, true],
        [6.95, false],
      ])('v_inst = %p m/s → accepted %p', (speed, accepted) => {
        const { result } = candidate(speed);
        expect(result !== null).toBe(accepted);
      });
    });

    test('1 Hz gate: fixes at 0, 400, 1000, 1500, 2100 ms keep exactly 0, 1000, 2100', () => {
      const filter = new GpsFilter();
      const kept = [0, 400, 1000, 1500, 2100]
        .map((t, i) => makePoint({ timestamp: t, latitude: northOf(t * 0.003), seqIndex: i }))
        .filter(p => filter.sanitizeFix(p) !== null)
        .map(p => p.timestamp);
      expect(kept).toEqual([0, 1000, 2100]);
      expect(filter.stats.rejected.TEMPORAL).toBe(2);
    });

    test('temporal gate runs before the accuracy gate (Table 12 order)', () => {
      const { filter, result } = candidate(1, 500, { accuracy: 80 });
      expect(result).toBeNull();
      expect(filter.lastRejection?.stage).toBe('TEMPORAL');
    });

    test('a rejected spike does not become the reference for the next fix', () => {
      const filter = new GpsFilter();
      filter.sanitizeFix(makePoint({ timestamp: 0, latitude: LAT0 }));
      expect(filter.sanitizeFix(makePoint({ timestamp: 1000, latitude: northOf(120) }))).toBeNull();
      // 6 m from the last accepted fix in 2 s = 3 m/s, so this one is kept
      expect(filter.sanitizeFix(makePoint({ timestamp: 2000, latitude: northOf(6) }))).not.toBeNull();
      expect(filter.lastAccepted?.timestamp).toBe(2000);
    });

    test('first fix with no predecessor falls back to the device-reported speed', () => {
      const filter = new GpsFilter();
      expect(filter.sanitizeFix(makePoint({ timestamp: 0, velocity: 9.2 }))).toBeNull();
      expect(filter.lastRejection?.stage).toBe('VELOCITY');
    });

    test('reset clears the reference fix and the counters', () => {
      const filter = new GpsFilter();
      filter.sanitizeFix(makePoint({ timestamp: 0 }));
      filter.sanitizeFix(makePoint({ timestamp: 100 }));
      filter.reset();
      expect(filter.lastAccepted).toBeNull();
      expect(filter.stats).toEqual({ accepted: 0, rejected: { INVALID: 0, TEMPORAL: 0, ACCURACY: 0, VELOCITY: 0 } });
      expect(filter.sanitizeFix(makePoint({ timestamp: 100 }))).not.toBeNull();
    });
  });
});
