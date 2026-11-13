import { geoidHeightM, toSeaLevelAltitude, RunAltitude } from '../../src/core/spatial/geoid';

// Reference values printed by scripts/geoid_grid.py (PROJ EGM96 15' grid).
// The 0.5° table is interpolated, so allow 1.5 m.
describe('EGM96 geoid height over Sri Lanka', () => {
  it.each([
    ['Galle Face', 6.9271, 79.845, -97.76],
    ['KDU Ratmalana', 6.82, 79.88, -97.67],
    ['Kandy Lake', 7.2906, 80.6413, -93.26],
    ['Horton Plains', 6.802, 80.8063, -92.89],
  ])('%s', (_name, lat, lon, expected) => {
    expect(Math.abs(geoidHeightM(lat as number, lon as number) - (expected as number))).toBeLessThan(1.5);
  });

  it('returns the table value exactly on a grid node', () => {
    expect(geoidHeightM(7.0, 80.5)).toBeCloseTo(-93.4, 6);
  });

  it('uses the nearest edge outside the table', () => {
    expect(geoidHeightM(4.0, 78.0)).toBeCloseTo(-105.3, 6);
    expect(geoidHeightM(12.0, 85.0)).toBeCloseTo(-97.2, 6);
  });
});

describe('toSeaLevelAltitude', () => {
  it('turns the ellipsoid reading at Galle Face into a height near sea level', () => {
    // A phone at ~3 m ASL reports about 3 + N ≈ −94.8 m
    const h = toSeaLevelAltitude(-94.8, 6.9271, 79.845)!;
    expect(h).toBeGreaterThan(1);
    expect(h).toBeLessThan(5);
  });

  it('keeps null and non-finite as null', () => {
    expect(toSeaLevelAltitude(null, 7, 80)).toBeNull();
    expect(toSeaLevelAltitude(undefined, 7, 80)).toBeNull();
    expect(toSeaLevelAltitude(NaN, 7, 80)).toBeNull();
  });
});

describe('RunAltitude', () => {
  it('averages the accepted altitudes and ignores missing ones', () => {
    const a = new RunAltitude();
    expect(a.meanM).toBeNull();
    a.push(500);
    a.push(null);
    a.push(520);
    expect(a.meanM).toBe(510);
    expect(a.samples).toBe(2);
    a.reset();
    expect(a.meanM).toBeNull();
  });
});
