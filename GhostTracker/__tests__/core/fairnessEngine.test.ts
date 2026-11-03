/**
 * Two-Stage Fairness Engine (Phase D): thesis Table 26 UT-03 / UT-04,
 * Table 32 (Kasun vs Nimal), Table B.2 rating tiers, model single source.
 *
 * Expected values are recomputed from the trained model file, not copied
 * from the thesis. Where the thesis prints a different number, the comment
 * says so; the thesis text is what needs correcting.
 */
import trainedModel from '../../scripts/analysis_output/npi_model_coefficients.json';
import bundledModel from '../../src/core/fairness/model/npi_model_coefficients.json';
import {
  NPI_MODEL,
  predictExpectedPace,
  calculateBMI,
  getModelQuality,
  type NpiModel,
} from '../../src/core/fairness/olsInference';
import { calculateNPIScore, calculateNPI, getNPIStatus, formatNPI } from '../../src/core/fairness/npiCalculator';
import { calculateRII } from '../../src/core/fairness/riiEvaluator';
import { evaluateRun } from '../../src/core/fairness/riiEngine';
import { haversineDistanceM } from '../../src/core/spatial/haversine';

describe('model file (single source of truth)', () => {
  it('the copy bundled with the app equals the training script output', () => {
    expect(bundledModel).toEqual(trainedModel);
  });

  it('NPI_MODEL carries the trained coefficients and sigma', () => {
    expect(NPI_MODEL.intercept).toBe(190.2703);
    expect(NPI_MODEL.age).toBe(1.7579);
    expect(NPI_MODEL.bmi).toBe(3.3918);
    expect(NPI_MODEL.altitudeM).toBe(0.036477);
    expect(NPI_MODEL.distanceM).toBe(0.0047);
    expect(NPI_MODEL.genderFemale).toBe(13.8648);
    expect(NPI_MODEL.sigma).toBe(24.158);
  });

  it('model quality shown in the app comes from the file', () => {
    const q = Object.fromEntries(getModelQuality().map(r => [r.metric, r.value]));
    expect(q['R²']).toBe('0.7507');
    expect(q['R² (test)']).toBe('0.7248');
    expect(q['Training Samples']).toBe('1,200');
  });
});

describe('UT-03: haversine against a WGS84 1,000.0 m baseline', () => {
  // End points of exact 1,000.000 m WGS84 geodesics from Colombo
  // (6.8418 N, 79.8916 E), computed with Vincenty's direct formula.
  const start = { lat: 6.8418, lon: 79.8916 };
  const ends = [
    { az: 0, lat: 6.8508424, lon: 79.8916 },
    { az: 45, lat: 6.8481939, lon: 79.89799739 },
    { az: 90, lat: 6.84179991, lon: 79.90064715 },
  ];

  it('is within the spherical-model error (< 0.6%) in every direction', () => {
    for (const e of ends) {
      const d = haversineDistanceM(start.lat, start.lon, e.lat, e.lon);
      expect(Math.abs(d - 1000) / 1000).toBeLessThan(0.006);
    }
  });

  it('measures the real error: about +0.55% north-south, -0.12% east-west', () => {
    const ns = haversineDistanceM(start.lat, start.lon, ends[0].lat, ends[0].lon);
    const ew = haversineDistanceM(start.lat, start.lon, ends[2].lat, ends[2].lon);
    expect(ns).toBeCloseTo(1005.47, 1);
    expect(ew).toBeCloseTo(998.83, 1);
    // The thesis (Table 26) states 1,000.02 m / < 0.01%; that holds only for a
    // baseline measured on the same 6,371 km sphere (next test), not WGS84.
  });

  it('is exact on its own sphere (a 1,000 m meridian arc of a 6,371 km sphere)', () => {
    const dLatDeg = (1000 / 6371000) * (180 / Math.PI);
    expect(haversineDistanceM(6.8418, 79.8916, 6.8418 + dLatDeg, 79.8916)).toBeCloseTo(1000, 6);
  });
});

describe('UT-04: Kandy Lake case (F, 40, BMI 24.0, 510 m, 5,000 m, 375.0 s/km)', () => {
  const runner = { age: 40, bmi: 24.0, gender: 'F' as const };
  const route = { altitudeM: 510, distanceM: 5000 };

  it('expected pace is 397.96 s/km with the trained coefficients', () => {
    expect(predictExpectedPace(runner, route)).toBeCloseTo(397.9576, 4);
    expect(Math.round(predictExpectedPace(runner, route) * 100) / 100).toBe(397.96);
  });

  it('gives the thesis 397.97 s/km with the altitude coefficient rounded to 0.0365 (as printed in Eq. 4.1)', () => {
    const printed: NpiModel = { ...NPI_MODEL, altitudeM: 0.0365 };
    expect(Math.round(predictExpectedPace(runner, route, printed) * 100) / 100).toBe(397.97);
  });

  it('NPI = +0.95 with the trained sigma 24.158', () => {
    expect(calculateNPI(runner, { ...route, avgPaceSPerKm: 375 }).npi).toBeCloseTo(0.95, 2);
  });

  it('NPI = +1.02 with sigma 22.50, the value the thesis states (Table 26)', () => {
    const expected = predictExpectedPace(runner, route);
    expect(calculateNPIScore(expected, 375, 22.5)).toBeCloseTo(1.02, 2);
  });
});

describe('Table 32: Kasun vs Nimal (5,000 m, 510 m altitude)', () => {
  const route = { altitudeM: 510, distanceM: 5000 };
  const kasun = evaluateRun({ age: 22, bmi: 20.4, gender: 'M' }, route, 245, 240);
  const nimal = evaluateRun({ age: 48, bmi: 27.6, gender: 'M' }, route, 380, 420);

  it('RII_perf matches the thesis: Kasun 0.980, Nimal 1.105, Nimal ranks first', () => {
    expect(kasun.rii).toBeCloseTo(0.98, 3);
    expect(nimal.rii).toBeCloseTo(1.105, 3);
    expect(nimal.rii).toBeGreaterThan(kasun.rii);
  });

  it('expected paces from the model: Kasun 340.24, Nimal 410.37 s/km', () => {
    // Thesis prints 254.45 (Kasun) and 411.05 (Nimal); Eq. 4.1 with the trained
    // coefficients cannot give 254.45 for a 22-year-old (intercept + age alone > 228).
    expect(kasun.expectedPace).toBeCloseTo(340.24, 2);
    expect(nimal.expectedPace).toBeCloseTo(410.37, 2);
  });

  it('NPI from the model: Kasun +3.94, Nimal +1.26 (thesis prints +0.42 / +1.38)', () => {
    expect(kasun.npi).toBeCloseTo(3.94, 2);
    expect(nimal.npi).toBeCloseTo(1.26, 2);
    // With the model's own numbers Kasun leads on NPI; Nimal still wins on RII.
    expect(kasun.npi).toBeGreaterThan(nimal.npi);
  });
});

describe('Table B.2 rating tiers', () => {
  // Standard normal upper tail, for checking the percentile labels
  const upperTail = (z: number) => {
    // Abramowitz-Stegun 7.1.26 erf approximation (|error| < 1.5e-7)
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
    const cdf = z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
    return 1 - cdf;
  };

  it('keeps the thesis thresholds', () => {
    expect(getNPIStatus(2.0).label).toBe('Exceptional');
    expect(getNPIStatus(1.99).label).toBe('Outstanding');
    expect(getNPIStatus(1.5).label).toBe('Outstanding');
    expect(getNPIStatus(1.0).label).toBe('Above Average');
    expect(getNPIStatus(0).label).toBe('As Expected');
    expect(getNPIStatus(-0.01).label).toBe('Below Average');
    expect(getNPIStatus(-1.0).label).toBe('Below Average');
    expect(getNPIStatus(-1.01).label).toBe('Needs Improvement');
  });

  it('percentile labels match the normal distribution at each threshold', () => {
    expect((upperTail(2.0) * 100).toFixed(1)).toBe('2.3');
    expect(getNPIStatus(2.0).percentile).toBe('Top 2.3%');
    expect((upperTail(1.5) * 100).toFixed(1)).toBe('6.7');
    expect(getNPIStatus(1.5).percentile).toBe('Top 6.7%');
    expect((upperTail(1.0) * 100).toFixed(1)).toBe('15.9');
    expect(getNPIStatus(1.0).percentile).toBe('Top 15.9%');
    expect(getNPIStatus(0).percentile).toBe('Top 50%');
    // Below −1: everyone under the 15.9th percentile (not "bottom 2.5%")
    expect(((1 - upperTail(-1.0)) * 100).toFixed(1)).toBe('15.9');
    expect(getNPIStatus(-1.5).percentile).toBe('Bottom 15.9%');
    expect(getNPIStatus(-0.5).percentile).toBe('16th–50th percentile');
  });
});

describe('helpers', () => {
  it('BMI', () => {
    expect(calculateBMI(68, 175)).toBe(22.2);
    expect(calculateBMI(0, 175)).toBe(0);
  });

  it('formats NPI with a sign', () => {
    expect(formatNPI(0.95)).toBe('+0.95');
    expect(formatNPI(-1.234)).toBe('-1.23');
    expect(formatNPI(Infinity)).toBe('-.--');
  });

  it('guards invalid input', () => {
    expect(calculateNPIScore(400, 0)).toBe(0);
    expect(calculateNPIScore(NaN, 300)).toBe(0);
    expect(calculateRII(0, 300)).toBe(0);
    expect(evaluateRun({ age: 30, bmi: 22, gender: 'M' }, { altitudeM: 0, distanceM: 1000 }, 300, null).rii).toBe(0);
  });
});
