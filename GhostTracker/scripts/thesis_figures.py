"""
Ghost-Tracker — Thesis figures and NPI vs RII_perf correlation
==============================================================

A5  11_coefficient_recovery.png
    Full-data OLS fit (the coefficients shipped in the app). Left: |t| per
    feature. Right: each estimate with its 95% CI, as a percentage of the
    true value used by generate_npi_training_data.py.

A6  12_npi_by_age_cohort.png
    Held-out test runners (runner-level 80/20 split, seed 42, identical to
    fairness_anova.py). Raw pace and NPI by age cohort, with the one-way
    ANOVA result in each panel title.

A7  NPI vs RII_perf on the held-out test runners.
    RII_perf = personal-best pace before this session / pace this session
    (> 1 = faster than own PB). Sessions 2..6 of each runner (session 1 has
    no PB yet). Pearson and Spearman correlation.

Figures use a white background for print.

Outputs:
  analysis_output/evaluation_plots/11_coefficient_recovery.png
  analysis_output/evaluation_plots/12_npi_by_age_cohort.png
  benchmarks_output/figures.json
"""

import csv
import io
import json
import os
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.transforms
import numpy as np
from scipy import stats

if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, 'analysis_output')
PLOT_DIR = os.path.join(DATA_DIR, 'evaluation_plots')
BENCH_DIR = os.path.join(SCRIPT_DIR, 'benchmarks_output')

sys.path.insert(0, SCRIPT_DIR)
from generate_npi_training_data import TRUE_COEFFICIENTS  # noqa: E402

FEATURES = ['Intercept', 'Age', 'BMI', 'Altitude', 'Distance', 'Female']
TRUE_KEYS = ['intercept', 'age', 'bmi', 'altitude_m', 'distance_m', 'gender_female']
AGE_COHORTS = [(18, 29), (30, 44), (45, 59), (60, 75)]

INK = '#1f2328'
MUTED = '#6e7781'
BLUE = '#2f6fb3'
ORANGE = '#d1662b'
GRID = '#d0d7de'

plt.rcParams.update({
    'figure.facecolor': 'white',
    'axes.facecolor': 'white',
    'axes.edgecolor': GRID,
    'axes.labelcolor': INK,
    'text.color': INK,
    'xtick.color': MUTED,
    'ytick.color': INK,
    'axes.spines.top': False,
    'axes.spines.right': False,
    'font.family': 'sans-serif',
    'font.size': 11,
})


def load_rows():
    with open(os.path.join(DATA_DIR, 'npi_training_data.csv'), encoding='utf-8') as f:
        return list(csv.DictReader(f))


def build_matrix(rows):
    X = np.array([[1, int(r['age']), float(r['bmi']), float(r['altitude_m']),
                   float(r['route_distance_m']), 1 if r['gender'] == 'F' else 0] for r in rows])
    y = np.array([float(r['avg_pace_s_per_km']) for r in rows])
    return X, y


def ols(X, y):
    xtx_inv = np.linalg.inv(X.T @ X)
    beta = xtx_inv @ X.T @ y
    resid = y - X @ beta
    dof = len(y) - X.shape[1]
    sigma = np.sqrt(resid @ resid / dof)
    se = sigma * np.sqrt(np.diag(xtx_inv))
    return beta, se, sigma, dof


def figure_coefficients(rows):
    X, y = build_matrix(rows)
    beta, se, sigma, dof = ols(X, y)
    t = beta / se
    t_crit = stats.t.ppf(0.975, dof)
    true = np.array([TRUE_COEFFICIENTS[k] for k in TRUE_KEYS])
    pct = 100 * beta / true
    pct_lo = 100 * (beta - t_crit * se) / true
    pct_hi = 100 * (beta + t_crit * se) / true

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13.5, 4.8), gridspec_kw={'width_ratios': [1, 1.15]})
    ypos = np.arange(len(FEATURES))[::-1]

    ax1.barh(ypos, np.abs(t), color=BLUE, height=0.55)
    ax1.axvline(3.29, color=ORANGE, linestyle='--', linewidth=1.2)
    ax1.text(3.29, ypos[-1] - 0.5, ' p < 0.001', color=ORANGE, fontsize=9, va='bottom')
    for yp, tv in zip(ypos, np.abs(t)):
        ax1.text(tv + 0.6, yp, f'{tv:.2f}', va='center', fontsize=10)
    ax1.set_yticks(ypos, FEATURES)
    ax1.set_xlabel('|t| statistic')
    ax1.set_xlim(0, max(np.abs(t)) * 1.15)
    ax1.set_title('Significance of each coefficient', fontsize=12, loc='left')
    ax1.grid(axis='x', color=GRID, linewidth=0.6)

    ax2.axvline(100, color=MUTED, linewidth=1)
    ax2.hlines(ypos, pct_lo, pct_hi, color=BLUE, linewidth=2.5)
    ax2.plot(pct, ypos, 'o', color=BLUE, markersize=7)
    # Values in a column to the right of the axes so they never overlap the CIs.
    label_x = matplotlib.transforms.blended_transform_factory(ax2.transAxes, ax2.transData)
    ax2.text(1.03, ypos[0] + 0.6, 'β ± SE (recovery)', transform=label_x, fontsize=9.5, color=MUTED, va='bottom')
    for yp, b, s, p in zip(ypos, beta, se, pct):
        ax2.text(1.03, yp, f'{b:.4g} ± {s:.2g}  ({p:.1f}%)', transform=label_x, va='center', fontsize=9.5, color=INK)
    ax2.set_yticks(ypos, FEATURES)
    ax2.set_xlim(min(pct_lo) - 2, max(pct_hi) + 2)
    ax2.set_xlabel('Estimate as % of true generator value (95% CI)')
    ax2.set_title('Recovery of the true coefficients', fontsize=12, loc='left')
    ax2.grid(axis='x', color=GRID, linewidth=0.6)

    fig.suptitle(f'5-feature OLS model (n = {len(y)}, σ = {sigma:.2f} s/km)', fontsize=13, x=0.01, ha='left')
    fig.tight_layout()
    path = os.path.join(PLOT_DIR, '11_coefficient_recovery.png')
    fig.savefig(path, dpi=200, bbox_inches='tight')
    plt.close(fig)

    return path, {
        'n': len(y),
        'sigma': sigma,
        'features': [
            {'name': n, 'beta': float(b), 'se': float(s), 't': float(tv), 'true': float(tr),
             'recovery_pct': float(p), 'ci95_pct': [float(lo), float(hi)]}
            for n, b, s, tv, tr, p, lo, hi in zip(FEATURES, beta, se, t, true, pct, pct_lo, pct_hi)
        ],
    }


def split_runners(rows):
    np.random.seed(42)
    runner_ids = np.array([r['runner_id'] for r in rows])
    unique = np.random.permutation(np.unique(runner_ids))
    train_ids = set(unique[:int(len(unique) * 0.8)])
    return [r for r in rows if r['runner_id'] in train_ids], [r for r in rows if r['runner_id'] not in train_ids]


def figure_age_cohorts(train, test):
    X_tr, y_tr = build_matrix(train)
    X_te, y_te = build_matrix(test)
    beta, _, sigma, _ = ols(X_tr, y_tr)
    npi = (X_te @ beta - y_te) / sigma
    ages = X_te[:, 1]

    labels, pace_groups, npi_groups = [], [], []
    for lo, hi in AGE_COHORTS:
        mask = (ages >= lo) & (ages <= hi)
        if mask.sum() >= 2:
            labels.append(f'{lo}–{hi}\n(n={mask.sum()})')
            pace_groups.append(y_te[mask])
            npi_groups.append(npi[mask])

    f_pace, p_pace = stats.f_oneway(*pace_groups)
    f_npi, p_npi = stats.f_oneway(*npi_groups)

    def fmt_p(p):
        return 'p < 0.0001' if p < 1e-4 else f'p = {p:.3f}'

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 4.8))
    box = dict(patch_artist=True, widths=0.55, medianprops=dict(color=INK, linewidth=1.5),
               flierprops=dict(marker='o', markersize=3, markerfacecolor=MUTED, markeredgecolor='none'))

    b1 = ax1.boxplot(pace_groups, tick_labels=labels, **box)
    for patch in b1['boxes']:
        patch.set(facecolor='#f6d5c3', edgecolor=ORANGE)
    ax1.set_ylabel('Pace (s/km)')
    ax1.set_xlabel('Age cohort')
    ax1.set_title(f'Raw pace: F = {f_pace:.2f}, {fmt_p(p_pace)}', fontsize=12, loc='left')
    ax1.grid(axis='y', color=GRID, linewidth=0.6)

    b2 = ax2.boxplot(npi_groups, tick_labels=labels, **box)
    for patch in b2['boxes']:
        patch.set(facecolor='#cfe0f3', edgecolor=BLUE)
    ax2.axhline(0, color=MUTED, linewidth=1, linestyle='--')
    ax2.set_ylabel('NPI (z-score)')
    ax2.set_xlabel('Age cohort')
    ax2.set_title(f'NPI: F = {f_npi:.2f}, {fmt_p(p_npi)}', fontsize=12, loc='left')
    ax2.grid(axis='y', color=GRID, linewidth=0.6)

    n_runners = len(set(r['runner_id'] for r in test))
    fig.suptitle(f'Held-out test runners ({n_runners} runners, {len(y_te)} sessions): '
                 'raw pace differs by age, NPI does not', fontsize=13, x=0.01, ha='left')
    fig.tight_layout()
    path = os.path.join(PLOT_DIR, '12_npi_by_age_cohort.png')
    fig.savefig(path, dpi=200, bbox_inches='tight')
    plt.close(fig)

    return path, {'pace_anova': {'F': f_pace, 'p': p_pace}, 'npi_anova': {'F': f_npi, 'p': p_npi},
                  'sigma_train': sigma}, beta, sigma


def npi_vs_rii(test, beta, sigma):
    by_runner = {}
    for r in test:
        by_runner.setdefault(r['runner_id'], []).append(r)

    npi_vals, rii_vals = [], []
    for sessions in by_runner.values():
        sessions.sort(key=lambda r: int(r['session_num']))
        best = None
        for r in sessions:
            pace = float(r['avg_pace_s_per_km'])
            if best is not None:
                X, _ = build_matrix([r])
                npi_vals.append(float((X @ beta)[0] - pace) / sigma)
                rii_vals.append(best / pace)
            best = pace if best is None else min(best, pace)

    npi_arr, rii_arr = np.array(npi_vals), np.array(rii_vals)
    pr, pp = stats.pearsonr(npi_arr, rii_arr)
    sr, sp = stats.spearmanr(npi_arr, rii_arr)
    return {
        'definition': 'RII_perf = PB pace before the session / session pace; sessions 2-6 of held-out runners',
        'n_sessions': len(npi_arr),
        'n_runners': len(by_runner),
        'pearson': {'r': pr, 'p': pp},
        'spearman': {'rho': sr, 'p': sp},
        'rii_perf_mean': float(rii_arr.mean()),
        'share_rii_above_1': float((rii_arr > 1).mean()),
    }


def main():
    os.makedirs(PLOT_DIR, exist_ok=True)
    os.makedirs(BENCH_DIR, exist_ok=True)
    rows = load_rows()

    path_a5, coef = figure_coefficients(rows)
    print(f'A5 coefficient figure -> {path_a5}')
    for f in coef['features']:
        print(f'   {f["name"]:<9} beta {f["beta"]:>10.4f}  se {f["se"]:.4f}  t {f["t"]:>6.2f}  '
              f'recovery {f["recovery_pct"]:.1f}%  CI [{f["ci95_pct"][0]:.1f}, {f["ci95_pct"][1]:.1f}]')

    train, test = split_runners(rows)
    path_a6, anova, beta, sigma = figure_age_cohorts(train, test)
    print(f'A6 age-cohort figure -> {path_a6}')
    print(f'   raw pace F = {anova["pace_anova"]["F"]:.2f}, p = {anova["pace_anova"]["p"]:.3g}; '
          f'NPI F = {anova["npi_anova"]["F"]:.2f}, p = {anova["npi_anova"]["p"]:.3f}')

    corr = npi_vs_rii(test, beta, sigma)
    print(f'A7 NPI vs RII_perf ({corr["n_sessions"]} sessions, {corr["n_runners"]} runners): '
          f'Pearson r = {corr["pearson"]["r"]:.3f} (p = {corr["pearson"]["p"]:.3g}), '
          f'Spearman rho = {corr["spearman"]["rho"]:.3f} (p = {corr["spearman"]["p"]:.3g})')

    out = os.path.join(BENCH_DIR, 'figures.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'coefficients_full_fit': coef, 'age_cohort_anova_test': anova, 'npi_vs_rii_perf': corr},
                  f, indent=2, default=float)
        f.write('\n')
    print(f'   -> {out}')


if __name__ == '__main__':
    main()
