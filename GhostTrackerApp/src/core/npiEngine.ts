/**
 * NPI engine (app side) — a thin re-export of the core Two-Stage Fairness
 * Engine (GhostTracker/src/core/fairness). The coefficients live only in the
 * core model file, so the app and the trained model cannot drift apart.
 */

export {
  NPI_MODEL,
  calculateBMI,
  predictExpectedPace,
  calculateNPI,
  calculateNPIScore,
  getNPIStatus,
  formatNPI,
  getModelInterpretation,
  getModelQuality,
} from '../../../GhostTracker/src/core/fairness/riiEngine';
export type { NPIResult, NPIStatus } from '../../../GhostTracker/src/core/fairness/riiEngine';

/** Runner profile as stored by the app (extra fields are ignored by the model). */
export interface RunnerProfile {
  age: number;
  weightKg: number;
  heightCm: number;
  bmi: number;
  gender: 'M' | 'F';
}

/** Run conditions plus the achieved pace. */
export interface RunContext {
  altitudeM: number;
  distanceM: number;
  avgPaceSPerKm: number;
}
