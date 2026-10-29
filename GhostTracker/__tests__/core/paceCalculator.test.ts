/**
 * Unit Tests: Pace Calculator
 */

import { calculateInstantPace, calculateAvgPace, formatPace, paceToSpeed, speedToPace, RollingPaceWindow } from '../../src/core/spatial/paceCalculator';
import { EARTH_RADIUS_M } from '../../src/utils/constants';

/** Latitude `metres` north of 6.8413 on the same meridian. */
function northOf(metres: number): number {
  return 6.8413 + (metres / EARTH_RADIUS_M) * (180 / Math.PI);
}
import { TelemetryPoint } from '../../src/data/models';

function makePoint(overrides: Partial<TelemetryPoint> = {}): TelemetryPoint {
  return {
    id: 'test',
    sessionId: 'session',
    latitude: 6.8413,
    longitude: 79.8815,
    timestamp: 1000,
    velocity: null,
    accuracy: null,
    seqIndex: 0,
    ...overrides,
  };
}

describe('Pace Calculator', () => {
  describe('calculateInstantPace', () => {
    test('should calculate pace for a known distance/time', () => {
      // Two points ~100m apart, 20s between them
      // Pace = 20s / 0.1km = 200 s/km = 3:20 min/km
      const prev = makePoint({ latitude: 6.8413, longitude: 79.8815, timestamp: 0 });
      const curr = makePoint({ latitude: 6.8422, longitude: 79.8815, timestamp: 20000 }); // ~100m, 20s
      const pace = calculateInstantPace(prev, curr);
      expect(pace).toBeGreaterThan(150);
      expect(pace).toBeLessThan(250);
    });

    test('should return Infinity for zero distance', () => {
      const prev = makePoint({ timestamp: 0 });
      const curr = makePoint({ timestamp: 1000 }); // Same location
      expect(calculateInstantPace(prev, curr)).toBe(Infinity);
    });

    test('should return Infinity for zero time delta', () => {
      const prev = makePoint({ latitude: 6.8413, timestamp: 1000 });
      const curr = makePoint({ latitude: 6.8422, timestamp: 1000 });
      expect(calculateInstantPace(prev, curr)).toBe(Infinity);
    });
  });

  describe('calculateAvgPace', () => {
    test('should calculate 5:00 min/km for 5km in 25min', () => {
      const pace = calculateAvgPace(5000, 1500); // 5km, 1500s
      expect(pace).toBe(300); // 300 s/km = 5:00 min/km
    });

    test('should return Infinity for zero distance', () => {
      expect(calculateAvgPace(0, 1500)).toBe(Infinity);
    });
  });

  describe('formatPace', () => {
    test('should format 300 s/km as 5:00 /km', () => {
      expect(formatPace(300)).toBe('5:00 /km');
    });

    test('should format 330 s/km as 5:30 /km', () => {
      expect(formatPace(330)).toBe('5:30 /km');
    });

    test('should handle single-digit seconds padding', () => {
      expect(formatPace(305)).toBe('5:05 /km');
    });

    test('should return placeholder for Infinity', () => {
      expect(formatPace(Infinity)).toBe('--:-- /km');
    });
  });

  describe('paceToSpeed / speedToPace', () => {
    test('should convert 300 s/km to 12 km/h', () => {
      expect(paceToSpeed(300)).toBe(12);
    });

    test('should convert 12 km/h to 300 s/km', () => {
      expect(speedToPace(12)).toBe(300);
    });

    test('should be inverse operations', () => {
      const pace = 330;
      expect(speedToPace(paceToSpeed(pace))).toBeCloseTo(pace, 5);
    });
  });

  // ── Thesis §3.6.4: 10-second sliding window (Eq. 3.25) ──────────────

  describe('RollingPaceWindow', () => {
    /** One accepted 1 Hz fix per second at a constant speed (m/s). */
    function feed(window: RollingPaceWindow, seconds: number, speedMs: number, startS = 0, startM = 0): number {
      let pace = 0;
      for (let s = 0; s <= seconds; s++) {
        pace = window.push(makePoint({ timestamp: (startS + s) * 1000, latitude: northOf(startM + s * speedMs) }));
      }
      return pace;
    }

    test('constant 5:00 /km run gives 300 s/km', () => {
      const pace = feed(new RollingPaceWindow(), 60, 1000 / 300);
      expect(pace).toBeCloseTo(300, 6);
    });

    test('keeps only the last 10 s: 11 points at 1 Hz', () => {
      const window = new RollingPaceWindow();
      feed(window, 60, 3);
      expect(window.size).toBe(11);
    });

    test('standing still returns the idle sentinel 0', () => {
      const window = new RollingPaceWindow();
      for (let s = 0; s <= 15; s++) {
        expect(window.push(makePoint({ timestamp: s * 1000 }))).toBe(0);
      }
    });

    test('fewer than two points returns 0', () => {
      const window = new RollingPaceWindow();
      expect(window.getRollingPace()).toBe(0);
      expect(window.push(makePoint({ timestamp: 0 }))).toBe(0);
    });

    test('pace follows a speed change within one window', () => {
      const window = new RollingPaceWindow();
      feed(window, 30, 1000 / 360); // 6:00 /km for 30 s
      const distanceAt30 = 30 * (1000 / 360);
      const pace = feed(window, 10, 1000 / 240, 30, distanceAt30); // then 4:00 /km for 10 s
      expect(pace).toBeCloseTo(240, 6);
    });

    test('gaps from dropped fixes are handled: the window spans time, not point count', () => {
      const window = new RollingPaceWindow();
      // every other second missing, still 5:00 /km
      let pace = 0;
      for (let s = 0; s <= 40; s += 2) {
        pace = window.push(makePoint({ timestamp: s * 1000, latitude: northOf(s * (1000 / 300)) }));
      }
      expect(pace).toBeCloseTo(300, 6);
      expect(window.size).toBe(6);
    });

    test('never returns NaN or Infinity', () => {
      const window = new RollingPaceWindow();
      for (let s = 0; s < 30; s++) {
        const pace = window.push(makePoint({ timestamp: s * 1000, latitude: northOf(s % 3 === 0 ? 0 : s) }));
        expect(Number.isFinite(pace)).toBe(true);
      }
    });

    test('reset empties the window', () => {
      const window = new RollingPaceWindow();
      feed(window, 20, 3);
      window.reset();
      expect(window.size).toBe(0);
      expect(window.getRollingPace()).toBe(0);
    });
  });
});
