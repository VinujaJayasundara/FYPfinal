/**
 * Which run a runner's leaderboard entry shows. The Board ranks by NPI
 * (thesis Stage 1), so the best NPI wins. RII is relative to the runner's
 * own PB at the time (it falls as they improve), so it only decides when
 * NPI is missing (no profile) or tied. A tie takes the newer run.
 */
export function isBetterEntry(
  next: { npi: number | null; rii: number },
  current: { npi: number | null; rii: number },
): boolean {
  if (next.npi !== null && current.npi !== null && next.npi !== current.npi) return next.npi > current.npi;
  if (next.npi !== null && current.npi === null) return true;
  if (next.npi === null && current.npi !== null) return false;
  return next.rii >= current.rii;
}
