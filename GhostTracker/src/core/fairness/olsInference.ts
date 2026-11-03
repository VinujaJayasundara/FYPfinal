/**
 * OLS inference — Stage 1 of the Two-Stage Fairness Engine (thesis Fig 2,
 * §3.5.2, Table 22, Eq. 4.1).
 *
 *   Expected pace = β0 + β1·Age + β2·BMI + β3·Altitude + β4·Distance + β5·Female
 *
 * The coefficients are read from the trained model file (single source of
 * truth): model/npi_model_coefficients.json, a copy of
 * scripts/analysis_output/npi_model_coefficients.json written by the
 * training script. A test checks the two files are identical.
 */

import model from './model/npi_model_coefficients.json';

export interface NpiModel {
  version: string;
  trainedAt: string;
  nTrainingSamples: number;
  intercept: number;
  age: number;
  bmi: number;
  altitudeM: number;
  distanceM: number;
  genderFemale: number;
  /** Residual standard error of the fit (s/km), the NPI normalizer. */
  sigma: number;
  quality: { rSquared: number; adjRSquared: number; fStatistic: number; rSquaredTest: number };
}

export const NPI_MODEL: NpiModel = Object.freeze({
  version: model.version,
  trainedAt: model.trained_at,
  nTrainingSamples: model.n_training_samples,
  intercept: model.coefficients.intercept,
  age: model.coefficients.age,
  bmi: model.coefficients.bmi,
  altitudeM: model.coefficients.altitude_m,
  distanceM: model.coefficients.distance_m,
  genderFemale: model.coefficients.gender_female,
  sigma: model.sigma,
  quality: Object.freeze({
    rSquared: model.model_quality.r_squared,
    adjRSquared: model.model_quality.adj_r_squared,
    fStatistic: model.model_quality.f_statistic,
    rSquaredTest: model.model_quality.r_squared_test,
  }),
});

/** Runner covariates (who is running). */
export interface RunnerCovariates {
  age: number;
  bmi: number;
  gender: 'M' | 'F';
  /** Accepted for convenience (the app passes its whole profile); the model uses BMI. */
  weightKg?: number;
  heightCm?: number;
}

/** Route covariates (where and how far). */
export interface RouteCovariates {
  altitudeM: number;
  distanceM: number;
}

/** BMI = kg / m², rounded to 0.1. Returns 0 for invalid input. */
export function calculateBMI(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100;
  if (heightM <= 0 || weightKg <= 0) return 0;
  return Math.round((weightKg / (heightM * heightM)) * 10) / 10;
}

/** Expected pace (s/km) for this runner on this route, Eq. 4.1. */
export function predictExpectedPace(
  runner: RunnerCovariates,
  route: RouteCovariates,
  m: NpiModel = NPI_MODEL,
): number {
  return (
    m.intercept +
    m.age * runner.age +
    m.bmi * runner.bmi +
    m.altitudeM * route.altitudeM +
    m.distanceM * route.distanceM +
    m.genderFemale * (runner.gender === 'F' ? 1 : 0)
  );
}

/** Coefficient explanations for the profile screen. */
export function getModelInterpretation(m: NpiModel = NPI_MODEL): { factor: string; effect: string; coefficient: number }[] {
  return [
    { factor: 'Age', effect: `+${m.age.toFixed(2)} s/km per year`, coefficient: m.age },
    { factor: 'BMI', effect: `+${m.bmi.toFixed(2)} s/km per unit`, coefficient: m.bmi },
    { factor: 'Altitude', effect: `+${(m.altitudeM * 100).toFixed(2)} s/km per 100 m`, coefficient: m.altitudeM },
    { factor: 'Distance', effect: `+${(m.distanceM * 1000).toFixed(2)} s/km per km`, coefficient: m.distanceM },
    { factor: 'Gender (F)', effect: `+${m.genderFemale.toFixed(2)} s/km`, coefficient: m.genderFemale },
  ];
}

/** Model quality figures for the profile screen (from the model file). */
export function getModelQuality(m: NpiModel = NPI_MODEL): { metric: string; value: string }[] {
  return [
    { metric: 'R²', value: m.quality.rSquared.toFixed(4) },
    { metric: 'Adjusted R²', value: m.quality.adjRSquared.toFixed(4) },
    { metric: 'R² (test)', value: m.quality.rSquaredTest.toFixed(4) },
    { metric: 'Standard Error σ', value: `${m.sigma.toFixed(2)} s/km` },
    { metric: 'Training Samples', value: m.nTrainingSamples.toLocaleString('en-US') },
    { metric: 'F-statistic', value: m.quality.fStatistic.toFixed(1) },
    { metric: 'Features', value: '5' },
  ];
}
