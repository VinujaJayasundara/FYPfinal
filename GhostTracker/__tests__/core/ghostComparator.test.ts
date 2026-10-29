/**
 * Unit Tests: Ghost Comparator — distance-based ±Δt every 10 m (thesis FRS-06)
 */

import {
  buildGhostCheckpoints,
  interpolateCheckpoint,
  evaluateGhostDelta,
  ghostDistanceAtTime,
  GhostPacer,
} from '../../src/core/fairness/ghostComparator';
import { EARTH_RADIUS_M } from '../../src/utils/constants';

/** Latitude `metres` north of 6.8413 on the same meridian (haversine is exact there). */
function northOf(metres: number): number {
  return 6.8413 + (metres / EARTH_RADIUS_M) * (180 / Math.PI);
}

/** A 1 Hz track at constant speed (m/s) for `seconds`. */
function track(speedMs: number, seconds: number, t0 = 1_700_000_000_000) {
  return Array.from({ length: seconds + 1 }, (_, s) => ({
    latitude: northOf(s * speedMs),
    longitude: 79.8815,
    timestamp: t0 + s * 1000,
  }));
}

// Personal best: 4 m/s (4:10 /km) for 100 s = 400 m
const PB = buildGhostCheckpoints(track(4, 100));

describe('Ghost Comparator — 10 m checkpoints', () => {
  describe('buildGhostCheckpoints', () => {
    test('one checkpoint every 10 m from 0 to the end of the PB run', () => {
      expect(PB).toHaveLength(41);
      expect(PB[0]).toEqual({ distanceM: 0, elapsedS: 0 });
      expect(PB[40].distanceM).toBe(400);
    });

    test('elapsed time at each mark is interpolated between 1 Hz fixes', () => {
      PB.forEach(c => expect(c.elapsedS).toBeCloseTo(c.distanceM / 4, 6));
      // 3 m/s: the 10 m mark falls between the fixes at 3 s and 4 s
      const slow = buildGhostCheckpoints(track(3, 20));
      expect(slow[1].elapsedS).toBeCloseTo(10 / 3, 6);
    });

    test('a stop in the PB run delays the next checkpoints by its length', () => {
      // 4 m/s to 40 m (10 s), stand still 5 s, then 4 m/s again
      const metres = [...Array.from({ length: 11 }, (_, s) => s * 4), 40, 40, 40, 40, 40, ...Array.from({ length: 10 }, (_, s) => 44 + s * 4)];
      const points = metres.map((m, s) => ({ latitude: northOf(m), longitude: 79.8815, timestamp: s * 1000 }));
      const cps = buildGhostCheckpoints(points);
      expect(interpolateCheckpoint(cps, 40)).toBeCloseTo(10, 6);
      expect(interpolateCheckpoint(cps, 50)).toBeCloseTo(17.5, 6); // 10 s + 5 s stop + 2.5 s
    });

    test('a track shorter than one interval gives no checkpoints', () => {
      expect(buildGhostCheckpoints(track(1, 5))).toEqual([]);
      expect(buildGhostCheckpoints([])).toEqual([]);
    });
  });

  describe('interpolateCheckpoint', () => {
    test('between two checkpoints', () => {
      expect(interpolateCheckpoint(PB, 15)).toBeCloseTo(3.75, 6);
    });

    test('exactly on the last checkpoint', () => {
      expect(interpolateCheckpoint(PB, 400)).toBeCloseTo(100, 6);
    });

    test('outside the ghost run returns null', () => {
      expect(interpolateCheckpoint(PB, 400.5)).toBeNull();
      expect(interpolateCheckpoint(PB, -1)).toBeNull();
      expect(interpolateCheckpoint([], 10)).toBeNull();
    });
  });

  describe('evaluateGhostDelta', () => {
    test('running at exactly the PB pace gives Δt = 0', () => {
      for (let d = 10; d <= 400; d += 10) {
        expect(evaluateGhostDelta(PB, d, d / 4)).toBeCloseTo(0, 6);
      }
    });

    test('running 10% faster gives a negative Δt (ahead) that grows linearly', () => {
      const deltas = [100, 200, 300, 400].map(d => evaluateGhostDelta(PB, d, d / 4.4)!);
      deltas.forEach(dt => expect(dt).toBeLessThan(0));
      expect(deltas[1]).toBeCloseTo(2 * deltas[0], 6);
      expect(deltas[3]).toBeCloseTo(4 * deltas[0], 6);
      expect(deltas[3]).toBeCloseTo(400 / 4.4 - 100, 6); // −9.09 s at 400 m
    });

    test('running slower gives a positive Δt (behind)', () => {
      expect(evaluateGhostDelta(PB, 200, 60)).toBeCloseTo(10, 6);
    });

    test('past the end of the ghost run returns null', () => {
      expect(evaluateGhostDelta(PB, 410, 90)).toBeNull();
    });
  });

  describe('ghostDistanceAtTime', () => {
    test('position of the ghost after a given time', () => {
      expect(ghostDistanceAtTime(PB, 25)).toBeCloseTo(100, 6);
      expect(ghostDistanceAtTime(PB, 26.25)).toBeCloseTo(105, 6);
    });

    test('clamped to the start and the finish', () => {
      expect(ghostDistanceAtTime(PB, 0)).toBe(0);
      expect(ghostDistanceAtTime(PB, 500)).toBe(400);
    });
  });

  describe('GhostPacer (live)', () => {
    test('emits one split per 10 m mark, timed by interpolation', () => {
      const pacer = new GhostPacer(PB);
      const splits = [];
      for (let s = 1; s <= 20; s++) {
        splits.push(...pacer.update(s * 4.4, s)); // 10% faster than the PB
      }
      expect(splits.map(x => x.distanceM)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
      splits.forEach(x => expect(x.deltaS).toBeCloseTo(x.distanceM / 4.4 - x.distanceM / 4, 6));
      expect(pacer.latest?.distanceM).toBe(80);
    });

    test('a fix that jumps more than 10 m produces every mark in between', () => {
      const pacer = new GhostPacer(PB);
      const splits = pacer.update(35, 8.75);
      expect(splits.map(x => x.distanceM)).toEqual([10, 20, 30]);
      splits.forEach(x => expect(x.deltaS).toBeCloseTo(0, 6));
    });

    test('standing still produces no split', () => {
      const pacer = new GhostPacer(PB);
      pacer.update(12, 3);
      expect(pacer.update(12, 10)).toEqual([]);
      expect(pacer.latest?.distanceM).toBe(10);
    });

    test('no splits after the ghost finish, and finished becomes true', () => {
      const pacer = new GhostPacer(PB);
      pacer.update(395, 99);
      expect(pacer.finished).toBe(false);
      const splits = pacer.update(420, 104);
      expect(splits.map(x => x.distanceM)).toEqual([400]);
      expect(pacer.finished).toBe(true);
      expect(pacer.update(450, 110)).toEqual([]);
    });

    test('without a PB run it never emits', () => {
      const pacer = new GhostPacer([]);
      expect(pacer.update(100, 30)).toEqual([]);
      expect(pacer.latest).toBeNull();
    });
  });
});
