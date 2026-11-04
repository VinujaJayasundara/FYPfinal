/**
 * Calibration (baseline) period: the first 5 valid runs.
 *
 * The thesis formulas are unchanged: NPI compares a run with the model's
 * expected pace for the runner's profile, RII compares it with their PB.
 * This module only decides WHEN scores are shown and gives one extra,
 * personal number: pace relative to the baseline (the mean pace of the first
 * 5 valid runs, fixed once reached).
 *
 *   runs 1-4 : no scores shown, "Baseline: N of 5 runs recorded"
 *   run 5+   : NPI (thesis), RII vs PB (thesis), and vs-baseline
 */

export const CALIBRATION_RUNS = 5;

export interface CalibrationStatus {
  /** Valid runs recorded so far. */
  runs: number;
  needed: number;
  calibrated: boolean;
  /** Mean pace (s/km) of the first CALIBRATION_RUNS valid runs; null before. */
  baselinePace: number | null;
}

const isValidPace = (p: number | null | undefined): p is number => typeof p === 'number' && isFinite(p) && p > 0;

/**
 * @param pacesOldestFirst average pace (s/km) of each run, oldest first;
 *        invalid entries (null, 0, Infinity: runs too short) are skipped.
 */
export function calibrationStatus(pacesOldestFirst: (number | null)[]): CalibrationStatus {
  const valid = pacesOldestFirst.filter(isValidPace);
  const calibrated = valid.length >= CALIBRATION_RUNS;
  const first = valid.slice(0, CALIBRATION_RUNS);
  return {
    runs: valid.length,
    needed: CALIBRATION_RUNS,
    calibrated,
    baselinePace: calibrated ? first.reduce((a, b) => a + b, 0) / CALIBRATION_RUNS : null,
  };
}

/** 1-based position of a run among the valid runs, or null if it is not valid. */
export function runNumber(pacesOldestFirst: (number | null)[], index: number): number | null {
  if (!isValidPace(pacesOldestFirst[index])) return null;
  return pacesOldestFirst.slice(0, index + 1).filter(isValidPace).length;
}

/** Scores are shown for a run once it is the 5th valid run or later. */
export function scoresVisibleForRun(runNo: number | null): boolean {
  return runNo !== null && runNo >= CALIBRATION_RUNS;
}

/**
 * Pace relative to the baseline, as a ratio like RII: baseline / pace.
 * 1.05 = 5 % faster than the baseline. Null if either value is missing.
 */
export function relativeToBaseline(baselinePace: number | null, pace: number | null): number | null {
  if (!isValidPace(baselinePace) || !isValidPace(pace)) return null;
  return baselinePace / pace;
}

/** "+5.0 % vs baseline" style text. */
export function formatVsBaseline(ratio: number | null): string {
  if (ratio === null) return '—';
  const pct = (ratio - 1) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs baseline`;
}
