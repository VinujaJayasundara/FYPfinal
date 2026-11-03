/**
 * NPI calculator — Stage 2a of the Two-Stage Fairness Engine (thesis §3.5.5,
 * Eq. 4.2, Table B.2).
 *
 *   NPI = (Expected pace − Actual pace) / σ
 *
 * Positive = faster than the model expects for this runner and route.
 * σ defaults to the trained model's residual standard error.
 *
 * Rating tiers keep the thesis thresholds; the percentile text is the
 * standard normal tail for each threshold (Φ):
 *   NPI ≥ +2.0 → top 2.3%   NPI ≥ +1.5 → top 6.7%   NPI ≥ +1.0 → top 15.9%
 *   NPI ≥ 0    → top 50%    NPI ≥ −1.0 → 16th–50th percentile
 *   NPI < −1.0 → bottom 15.9%
 */

import { NPI_MODEL, predictExpectedPace, type RouteCovariates, type RunnerCovariates } from './olsInference';

export interface NPIStatus {
  label: string;
  emoji: string;
  color: string;
  percentile: string;
}

export interface NPIResult {
  npi: number;
  expectedPace: number;
  actualPace: number;
  status: NPIStatus;
}

/** NPI from an expected and an actual pace (s/km). Returns 0 for invalid input. */
export function calculateNPIScore(expectedPace: number, actualPace: number, sigma: number = NPI_MODEL.sigma): number {
  if (!isFinite(expectedPace) || !isFinite(actualPace) || actualPace <= 0 || !(sigma > 0)) return 0;
  return (expectedPace - actualPace) / sigma;
}

/** Rating tier for an NPI score (thesis Table B.2 thresholds). */
export function getNPIStatus(npi: number): NPIStatus {
  if (npi >= 2.0) return { label: 'Exceptional', emoji: '🏆', color: '#FFD700', percentile: 'Top 2.3%' };
  if (npi >= 1.5) return { label: 'Outstanding', emoji: '⭐', color: '#FF6B35', percentile: 'Top 6.7%' };
  if (npi >= 1.0) return { label: 'Above Average', emoji: '🔥', color: '#22c55e', percentile: 'Top 15.9%' };
  if (npi >= 0.0) return { label: 'As Expected', emoji: '✅', color: '#3b82f6', percentile: 'Top 50%' };
  if (npi >= -1.0) return { label: 'Below Average', emoji: '😤', color: '#f59e0b', percentile: '16th–50th percentile' };
  return { label: 'Needs Improvement', emoji: '👻', color: '#ef4444', percentile: 'Bottom 15.9%' };
}

export function formatNPI(npi: number): string {
  if (!isFinite(npi)) return '-.--';
  return `${npi >= 0 ? '+' : ''}${npi.toFixed(2)}`;
}

/** Expected pace, NPI and tier for one run. */
export function calculateNPI(
  runner: RunnerCovariates,
  route: RouteCovariates & { avgPaceSPerKm: number },
  sigma: number = NPI_MODEL.sigma,
): NPIResult {
  const expectedPace = predictExpectedPace(runner, route);
  const npi = calculateNPIScore(expectedPace, route.avgPaceSPerKm, sigma);
  return {
    npi: Math.round(npi * 1000) / 1000,
    expectedPace: Math.round(expectedPace * 100) / 100,
    actualPace: route.avgPaceSPerKm,
    status: getNPIStatus(npi),
  };
}
