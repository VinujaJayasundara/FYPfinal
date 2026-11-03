/**
 * RII evaluator — Stage 2b of the Two-Stage Fairness Engine (thesis §3.5.5,
 * Table 22).
 *
 *   RII_perf = PB pace / Current pace
 *
 *   > 1.0  faster than the personal best (outperforming the ghost)
 *   = 1.0  matching the personal best
 *   < 1.0  slower than the personal best
 *
 * Competition is against the runner's own baseline, so a beginner who
 * improves by 10% scores the same as an elite runner who improves by 10%.
 */

import { RII_MIN_POINTS } from '../../utils/constants';

export function calculateRII(pbPaceSPerKm: number, currentPaceSPerKm: number): number {
  if (
    !isFinite(pbPaceSPerKm) ||
    !isFinite(currentPaceSPerKm) ||
    pbPaceSPerKm <= 0 ||
    currentPaceSPerKm <= 0
  ) {
    return 0;
  }
  return pbPaceSPerKm / currentPaceSPerKm;
}

/**
 * RII from per-point pace arrays: average PB pace over average current pace,
 * up to the shorter of the two, ignoring invalid points.
 */
export function calculateCumulativeRII(pbPaces: number[], currentPaces: number[]): number {
  if (currentPaces.length < RII_MIN_POINTS || pbPaces.length < RII_MIN_POINTS) return 0;

  const length = Math.min(pbPaces.length, currentPaces.length);
  let pbSum = 0;
  let currentSum = 0;
  let validCount = 0;
  for (let i = 0; i < length; i++) {
    if (isFinite(pbPaces[i]) && isFinite(currentPaces[i]) && pbPaces[i] > 0 && currentPaces[i] > 0) {
      pbSum += pbPaces[i];
      currentSum += currentPaces[i];
      validCount++;
    }
  }
  if (validCount < RII_MIN_POINTS) return 0;
  return calculateRII(pbSum / validCount, currentSum / validCount);
}

export function getRIIStatus(riiScore: number): { label: string; emoji: string; color: string } {
  if (riiScore <= 0) return { label: 'Calculating...', emoji: '⏳', color: '#888888' };
  if (riiScore >= 1.1) return { label: 'Crushing It!', emoji: '🔥', color: '#22c55e' };
  if (riiScore >= 1.0) return { label: 'On Pace', emoji: '✅', color: '#3b82f6' };
  if (riiScore >= 0.95) return { label: 'Slightly Behind', emoji: '😤', color: '#f59e0b' };
  return { label: 'Behind Ghost', emoji: '👻', color: '#ef4444' };
}

export function formatRII(riiScore: number): string {
  if (riiScore <= 0) return '-.--';
  return riiScore.toFixed(2);
}
