/** Which run a runner's leaderboard entry keeps (the Board ranks by NPI). */
import { isBetterEntry } from '../../src/core/fairness/leaderboardEntry';

describe('isBetterEntry', () => {
  it('keeps the higher NPI even when its RII is lower', () => {
    // Emulator case: old entry NPI 0 / RII 1.41, new faster run NPI 1.2 / RII 1.18
    expect(isBetterEntry({ npi: 1.2, rii: 1.18 }, { npi: 0, rii: 1.41 })).toBe(true);
    expect(isBetterEntry({ npi: -0.5, rii: 1.9 }, { npi: 0.3, rii: 1.0 })).toBe(false);
  });
  it('uses RII only when NPI is missing or tied; a tie takes the newer run', () => {
    expect(isBetterEntry({ npi: null, rii: 1.1 }, { npi: null, rii: 1.0 })).toBe(true);
    expect(isBetterEntry({ npi: 0.5, rii: 1.0 }, { npi: 0.5, rii: 1.0 })).toBe(true);
    expect(isBetterEntry({ npi: 0.5, rii: 0.9 }, { npi: 0.5, rii: 1.0 })).toBe(false);
  });
  it('a run with an NPI beats one without, and not the other way round', () => {
    expect(isBetterEntry({ npi: -1, rii: 0.8 }, { npi: null, rii: 1.2 })).toBe(true);
    expect(isBetterEntry({ npi: null, rii: 1.5 }, { npi: -1, rii: 0.8 })).toBe(false);
  });
});
