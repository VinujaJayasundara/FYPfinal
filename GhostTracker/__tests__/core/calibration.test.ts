/** 5-run baseline (calibration) rules. */
import {
  calibrationStatus,
  runNumber,
  scoresVisibleForRun,
  relativeToBaseline,
  formatVsBaseline,
  CALIBRATION_RUNS,
} from '../../src/core/fairness/calibration';

describe('calibrationStatus', () => {
  it('counts only valid runs and is not calibrated before 5', () => {
    const s = calibrationStatus([360, null, 0, 350, Infinity, 340]);
    expect(s).toEqual({ runs: 3, needed: CALIBRATION_RUNS, calibrated: false, baselinePace: null });
  });

  it('baseline = mean of the first 5 valid runs, fixed after that', () => {
    const five = [360, 350, 340, 330, 320];
    expect(calibrationStatus(five).baselinePace).toBe(340);
    // later (faster) runs do not move the baseline
    expect(calibrationStatus([...five, 200, 210]).baselinePace).toBe(340);
    expect(calibrationStatus([...five, 200]).calibrated).toBe(true);
  });
});

describe('runNumber / scoresVisibleForRun', () => {
  const paces = [360, null, 350, 340, 330, 320, 300];
  it('numbers valid runs from 1 and skips invalid ones', () => {
    expect(runNumber(paces, 0)).toBe(1);
    expect(runNumber(paces, 1)).toBeNull();
    expect(runNumber(paces, 5)).toBe(5);
    expect(runNumber(paces, 6)).toBe(6);
  });
  it('shows scores from the 5th valid run', () => {
    expect(scoresVisibleForRun(4)).toBe(false);
    expect(scoresVisibleForRun(5)).toBe(true);
    expect(scoresVisibleForRun(null)).toBe(false);
  });
});

describe('relativeToBaseline', () => {
  it('is baseline / pace (like RII)', () => {
    expect(relativeToBaseline(340, 323)).toBeCloseTo(1.0526, 4);
    expect(formatVsBaseline(relativeToBaseline(340, 323))).toBe('+5.3% vs baseline');
    expect(formatVsBaseline(relativeToBaseline(300, 330))).toBe('-9.1% vs baseline');
  });
  it('is null when a value is missing', () => {
    expect(relativeToBaseline(null, 300)).toBeNull();
    expect(relativeToBaseline(300, 0)).toBeNull();
    expect(formatVsBaseline(null)).toBe('—');
  });
});
