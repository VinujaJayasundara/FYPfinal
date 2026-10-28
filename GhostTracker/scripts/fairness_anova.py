"""
Ghost-Tracker — NPI Demographic Parity Test (ANOVA + Levene)
=============================================================

Tests Hypothesis Set 1: does NPI remove the age/sex trend that raw pace shows?

Method:
  1. Runner-level grouped 80/20 split (160 train / 40 unseen test runners),
     identical to fit_npi_model.py and evaluate_npi_model.py.
  2. Fit the 5-feature OLS model on the training runners only.
  3. On the held-out test sessions, compute NPI = (Expected - Actual) / sigma_train.
  4. One-way ANOVA across age cohorts (18-29, 30-44, 45-59, 60-75) and sex,
     for raw pace and for NPI. Levene's test checks equal variances.

Output:
  - analysis_output/npi_fairness_anova.txt
"""

import csv
import os
import sys
import io
import numpy as np
from scipy import stats

if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'analysis_output')

AGE_COHORTS = [(18, 29), (30, 44), (45, 59), (60, 75)]
ALPHA = 0.05


def load_training_data():
    csv_path = os.path.join(OUTPUT_DIR, 'npi_training_data.csv')
    with open(csv_path, 'r', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def build_matrix(rows):
    X = np.array([[1, int(r['age']), float(r['bmi']), float(r['altitude_m']),
                   float(r['route_distance_m']), 1 if r['gender'] == 'F' else 0] for r in rows])
    y = np.array([float(r['avg_pace_s_per_km']) for r in rows])
    return X, y


def run_tests(label, groups, lines):
    groups = [(name, vals) for name, vals in groups if len(vals) >= 2]
    if len(groups) < 2:
        lines.append(f'  {label}: not enough populated groups to test')
        return
    samples = [vals for _, vals in groups]
    f_stat, p_anova = stats.f_oneway(*samples)
    w_stat, p_levene = stats.levene(*samples, center='mean')
    lines.append(f'  {label}')
    for name, vals in groups:
        lines.append(f'    {name:<10} n={len(vals):>3}  mean={np.mean(vals):>8.3f}  sd={np.std(vals, ddof=1):>7.3f}')
    lines.append(f'    ANOVA:  F = {f_stat:.2f}, p = {p_anova:.4g}  -> '
                 f'{"reject H0 (means differ)" if p_anova < ALPHA else "retain H0 (no significant difference)"}')
    lines.append(f'    Levene: W = {w_stat:.2f}, p = {p_levene:.4g}  -> '
                 f'{"variances differ" if p_levene < ALPHA else "equal variances"}')
    lines.append('')


def main():
    data = load_training_data()

    np.random.seed(42)
    runner_ids = np.array([r['runner_id'] for r in data])
    unique_runners = np.random.permutation(np.unique(runner_ids))
    train_runners = set(unique_runners[:int(len(unique_runners) * 0.8)])
    train = [r for r in data if r['runner_id'] in train_runners]
    test = [r for r in data if r['runner_id'] not in train_runners]

    X_train, y_train = build_matrix(train)
    X_test, y_test = build_matrix(test)

    beta = np.linalg.inv(X_train.T @ X_train) @ X_train.T @ y_train
    residuals = y_train - X_train @ beta
    sigma = np.sqrt(np.sum(residuals ** 2) / (len(y_train) - X_train.shape[1]))

    npi_test = (X_test @ beta - y_test) / sigma
    ages = X_test[:, 1]
    female = X_test[:, 5] == 1

    def by_age(values):
        return [(f'{lo}-{hi}', values[(ages >= lo) & (ages <= hi)]) for lo, hi in AGE_COHORTS]

    def by_sex(values):
        return [('Male', values[~female]), ('Female', values[female])]

    lines = [
        'NPI DEMOGRAPHIC PARITY TEST (held-out test runners)',
        '=' * 60,
        f'Train: {len(set(r["runner_id"] for r in train))} runners, {len(train)} sessions',
        f'Test:  {len(set(r["runner_id"] for r in test))} runners, {len(test)} sessions',
        f'Sigma (train residual SE): {sigma:.4f} s/km',
        f'Alpha: {ALPHA}',
        '',
        'AGE COHORTS',
        '-' * 60,
    ]
    run_tests('Raw pace (s/km)', by_age(y_test), lines)
    run_tests('NPI', by_age(npi_test), lines)
    lines += ['SEX', '-' * 60]
    run_tests('Raw pace (s/km)', by_sex(y_test), lines)
    run_tests('NPI', by_sex(npi_test), lines)

    report = '\n'.join(lines)
    print(report)

    out_path = os.path.join(OUTPUT_DIR, 'npi_fairness_anova.txt')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(report + '\n')
    print(f'\n  Report saved: {out_path}')


if __name__ == '__main__':
    main()
