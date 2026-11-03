/**
 * Two-Stage Fairness Engine — facade (thesis Fig 2, Table 22).
 *
 *   Stage 1  olsInference.ts   expected pace from runner + route covariates
 *   Stage 2  npiCalculator.ts  NPI = (expected − actual) / σ
 *            riiEvaluator.ts   RII_perf = PB pace / current pace
 *
 * evaluateRun() runs both stages for one finished run. The individual
 * functions are re-exported so existing imports keep working.
 */

import { predictExpectedPace, type RunnerCovariates, type RouteCovariates } from './olsInference';
import { calculateNPIScore, getNPIStatus, type NPIStatus } from './npiCalculator';
import { calculateRII, getRIIStatus } from './riiEvaluator';

export { calculateRII, calculateCumulativeRII, getRIIStatus, formatRII } from './riiEvaluator';
export { calculateNPIScore, calculateNPI, getNPIStatus, formatNPI } from './npiCalculator';
export type { NPIStatus, NPIResult } from './npiCalculator';
export {
  NPI_MODEL,
  calculateBMI,
  predictExpectedPace,
  getModelInterpretation,
  getModelQuality,
} from './olsInference';
export type { NpiModel, RunnerCovariates, RouteCovariates } from './olsInference';

export interface RunEvaluation {
  expectedPace: number;
  npi: number;
  npiStatus: NPIStatus;
  /** 0 when there is no personal best yet. */
  rii: number;
  riiStatus: { label: string; emoji: string; color: string };
}

/** Both fairness scores for one run. */
export function evaluateRun(
  runner: RunnerCovariates,
  route: RouteCovariates,
  actualPaceSPerKm: number,
  pbPaceSPerKm: number | null,
): RunEvaluation {
  const expectedPace = predictExpectedPace(runner, route);
  const npi = calculateNPIScore(expectedPace, actualPaceSPerKm);
  const rii = pbPaceSPerKm !== null ? calculateRII(pbPaceSPerKm, actualPaceSPerKm) : 0;
  return {
    expectedPace,
    npi,
    npiStatus: getNPIStatus(npi),
    rii,
    riiStatus: getRIIStatus(rii),
  };
}
