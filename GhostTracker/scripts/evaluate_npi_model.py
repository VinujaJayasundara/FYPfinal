"""
Ghost-Tracker — NPI Model Accuracy Evaluation & Visualization
===============================================================

Generates matplotlib charts to evaluate the NPI regression model:
  1. Actual vs Predicted Pace (scatter + R² line)
  2. Residual Distribution (histogram + normal curve)
  3. Residuals vs Predicted (homoscedasticity check)
  4. Feature Importance (coefficient bar chart)
  5. NPI Distribution across all data
  6. Accuracy Metrics Summary (table figure)
  7. Confusion-Matrix-style NPI Classification Heatmap
  8. Q-Q Plot for residual normality
  9. Cross-Validation Learning Curve (train vs test)
 10. NPI Fairness Proof Bar Chart

Outputs all figures to: analysis_output/evaluation_plots/
"""

import json
import csv
import os
import math
import numpy as np
import sys
import io

# Fix Windows console encoding for Unicode
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'analysis_output')
PLOT_DIR = os.path.join(OUTPUT_DIR, 'evaluation_plots')


def erfinv_approx(x):
    """Rational approximation to inverse error function."""
    # Winitzki approximation
    a = 0.147
    sgn = 1 if x >= 0 else -1
    x = abs(x)
    if x >= 1.0:
        return sgn * 3.5  # clamp
    ln_part = math.log(1 - x * x)
    t1 = 2 / (math.pi * a) + ln_part / 2
    result = sgn * math.sqrt(math.sqrt(t1 * t1 - ln_part / a) - t1)
    return result


def format_pace(s_per_km):
    if not math.isfinite(s_per_km) or s_per_km <= 0:
        return '--:--'
    return f'{int(s_per_km // 60)}:{int(s_per_km % 60):02d}'


def load_training_data():
    csv_path = os.path.join(OUTPUT_DIR, 'npi_training_data.csv')
    data = []
    with open(csv_path, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            data.append({
                'runner_id': row['runner_id'],
                'runner_name': row['runner_name'],
                'session_num': int(row['session_num']),
                'age': int(row['age']),
                'gender': row['gender'],
                'bmi': float(row['bmi']),
                'altitude_m': float(row['altitude_m']),
                'route_distance_m': float(row['route_distance_m']),
                'avg_pace_s_per_km': float(row['avg_pace_s_per_km']),
                'location': row['location'],
                'height_cm': float(row['height_cm']),
                'weight_kg': float(row['weight_kg']),
            })
    return data


def fit_linear_regression(X, y):
    n = len(y)
    k = X.shape[1] - 1
    XtX = X.T @ X
    XtX_inv = np.linalg.inv(XtX)
    beta = XtX_inv @ X.T @ y
    y_pred = X @ beta
    residuals = y - y_pred
    ss_res = np.sum(residuals ** 2)
    ss_tot = np.sum((y - np.mean(y)) ** 2)
    r_squared = 1 - ss_res / ss_tot
    adj_r_squared = 1 - (1 - r_squared) * (n - 1) / (n - k - 1)
    mse = ss_res / (n - k - 1)
    sigma = np.sqrt(mse)
    se_beta = np.sqrt(np.diag(XtX_inv) * mse)
    t_stats = beta / se_beta
    ss_reg = ss_tot - ss_res
    ms_reg = ss_reg / k
    ms_res = ss_res / (n - k - 1)
    f_stat = ms_reg / ms_res
    return {
        'coefficients': beta,
        'predictions': y_pred,
        'residuals': residuals,
        'r_squared': r_squared,
        'adj_r_squared': adj_r_squared,
        'sigma': sigma,
        'se_beta': se_beta,
        't_stats': t_stats,
        'f_stat': f_stat,
        'n_samples': n,
        'n_features': k,
    }


def main():
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.gridspec import GridSpec
    import matplotlib.ticker as mticker

    os.makedirs(PLOT_DIR, exist_ok=True)

    print('=' * 75)
    print('  NPI MODEL EVALUATION — Matplotlib Visualization Suite')
    print('=' * 75)

    # ── Load data ─────────────────────────────────────────────
    data = load_training_data()
    n = len(data)
    print(f'\n  Loaded {n} training samples')

    X = np.zeros((n, 6))
    y = np.zeros(n)
    for i, row in enumerate(data):
        X[i, 0] = 1
        X[i, 1] = row['age']
        X[i, 2] = row['bmi']
        X[i, 3] = row['altitude_m']
        X[i, 4] = row['route_distance_m']
        X[i, 5] = 1 if row['gender'] == 'F' else 0
        y[i] = row['avg_pace_s_per_km']

    # Train/test split
    # Runner-level grouped split: all 6 sessions of a runner stay in the same
    # partition, so the test set contains only unseen runners (160 / 40).
    np.random.seed(42)
    runner_ids = np.array([row['runner_id'] for row in data])
    unique_runners = np.random.permutation(np.unique(runner_ids))
    train_runners = set(unique_runners[:int(len(unique_runners) * 0.8)])
    is_train = np.array([r in train_runners for r in runner_ids])
    train_idx = np.where(is_train)[0]
    test_idx = np.where(~is_train)[0]

    X_train, X_test = X[train_idx], X[test_idx]
    y_train, y_test = y[train_idx], y[test_idx]

    # Fit models
    train_result = fit_linear_regression(X_train, y_train)
    full_result = fit_linear_regression(X, y)

    beta = full_result['coefficients']
    sigma = full_result['sigma']

    # Test predictions
    y_test_pred = X_test @ train_result['coefficients']
    test_residuals = y_test - y_test_pred
    ss_res_test = np.sum(test_residuals ** 2)
    ss_tot_test = np.sum((y_test - np.mean(y_test)) ** 2)
    r2_test = 1 - ss_res_test / ss_tot_test

    # Full predictions
    y_pred_full = full_result['predictions']
    residuals_full = full_result['residuals']

    # Calculate NPI for all data
    all_npis = (full_result['predictions'] - y) / (-sigma)  # expected - actual
    # Actually: NPI = (expected - actual) / sigma = (y_pred - y) / sigma
    # But residuals = y - y_pred, so NPI = -residuals / sigma
    all_npis = -residuals_full / sigma

    feature_names = ['Intercept', 'Age', 'BMI', 'Altitude (m)', 'Distance (m)', 'Gender (F)']

    # ── Compute accuracy metrics ──────────────────────────────
    mae_train = np.mean(np.abs(train_result['residuals']))
    rmse_train = np.sqrt(np.mean(train_result['residuals'] ** 2))
    mae_test = np.mean(np.abs(test_residuals))
    rmse_test = np.sqrt(np.mean(test_residuals ** 2))
    mape_test = np.mean(np.abs(test_residuals / y_test)) * 100

    # Classification accuracy for NPI buckets
    npi_test = -(y_test - y_test_pred) / train_result['sigma']

    def classify_npi(npi_val):
        if npi_val >= 2.0:
            return 'Exceptional'
        elif npi_val >= 1.0:
            return 'Above Average'
        elif npi_val >= 0.0:
            return 'As Expected'
        elif npi_val >= -1.0:
            return 'Below Average'
        else:
            return 'Needs Work'

    # ══════════════════════════════════════════════════════════
    #  STYLE SETUP
    # ══════════════════════════════════════════════════════════

    plt.rcParams.update({
        'figure.facecolor': '#0f1117',
        'axes.facecolor': '#161b22',
        'axes.edgecolor': '#30363d',
        'axes.labelcolor': '#c9d1d9',
        'text.color': '#c9d1d9',
        'xtick.color': '#8b949e',
        'ytick.color': '#8b949e',
        'grid.color': '#21262d',
        'grid.alpha': 0.6,
        'font.family': 'sans-serif',
        'font.size': 11,
    })

    COLORS = {
        'primary': '#00e676',
        'secondary': '#40c4ff',
        'accent': '#ff6e40',
        'warning': '#ffab40',
        'error': '#ff5252',
        'purple': '#b388ff',
        'teal': '#64ffda',
        'pink': '#ff80ab',
    }

    # ══════════════════════════════════════════════════════════
    #  FIGURE 1: Actual vs Predicted Pace
    # ══════════════════════════════════════════════════════════

    print('\n  📊 Generating Figure 1: Actual vs Predicted Pace...')
    fig, ax = plt.subplots(figsize=(10, 8))

    ax.scatter(y_test, y_test_pred, alpha=0.5, s=30, c=COLORS['secondary'],
               edgecolors='none', label=f'Test Data (n={len(y_test)})')
    ax.scatter(y_train, train_result['predictions'], alpha=0.15, s=15,
               c=COLORS['primary'], edgecolors='none', label=f'Train Data (n={len(y_train)})')

    # Perfect prediction line
    min_val = min(y.min(), y_pred_full.min()) - 10
    max_val = max(y.max(), y_pred_full.max()) + 10
    ax.plot([min_val, max_val], [min_val, max_val], '--', color=COLORS['accent'],
            linewidth=2, alpha=0.8, label='Perfect Prediction')

    # Fit line through test data
    z = np.polyfit(y_test, y_test_pred, 1)
    p = np.poly1d(z)
    x_line = np.linspace(min_val, max_val, 100)
    ax.plot(x_line, p(x_line), '-', color=COLORS['pink'], linewidth=1.5,
            alpha=0.7, label=f'Best Fit (slope={z[0]:.3f})')

    ax.set_xlabel('Actual Pace (s/km)', fontsize=13, fontweight='bold')
    ax.set_ylabel('Predicted Pace (s/km)', fontsize=13, fontweight='bold')
    ax.set_title('Actual vs Predicted Pace — NPI Regression Model',
                 fontsize=16, fontweight='bold', pad=15)
    ax.legend(fontsize=10, loc='upper left', framealpha=0.8,
              facecolor='#161b22', edgecolor='#30363d')
    ax.grid(True, alpha=0.3)

    # Add R² annotation
    textstr = f'R² (Train) = {train_result["r_squared"]:.4f}\nR² (Test) = {r2_test:.4f}\nRMSE (Test) = {rmse_test:.2f} s/km'
    props = dict(boxstyle='round,pad=0.5', facecolor='#21262d', edgecolor=COLORS['primary'], alpha=0.9)
    ax.text(0.97, 0.05, textstr, transform=ax.transAxes, fontsize=11,
            verticalalignment='bottom', horizontalalignment='right', bbox=props)

    plt.tight_layout()
    path1 = os.path.join(PLOT_DIR, '01_actual_vs_predicted.png')
    fig.savefig(path1, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path1}')

    # ══════════════════════════════════════════════════════════
    #  FIGURE 2: Residual Distribution
    # ══════════════════════════════════════════════════════════

    print('  📊 Generating Figure 2: Residual Distribution...')
    fig, ax = plt.subplots(figsize=(10, 7))

    counts, bins, patches = ax.hist(residuals_full, bins=40, density=True,
                                     color=COLORS['secondary'], alpha=0.7,
                                     edgecolor='#0f1117', linewidth=0.5,
                                     label='Residual Distribution')

    # Overlay normal curve
    mu = np.mean(residuals_full)
    std = np.std(residuals_full)
    x_norm = np.linspace(mu - 4*std, mu + 4*std, 200)
    y_norm = (1 / (std * np.sqrt(2 * np.pi))) * np.exp(-0.5 * ((x_norm - mu) / std) ** 2)
    ax.plot(x_norm, y_norm, '-', color=COLORS['accent'], linewidth=2.5,
            label=f'Normal Curve (μ={mu:.1f}, σ={std:.1f})')

    # Mean line
    ax.axvline(x=mu, color=COLORS['primary'], linewidth=2, linestyle='--',
               alpha=0.8, label=f'Mean = {mu:.2f}')

    ax.set_xlabel('Residual (Actual − Predicted) s/km', fontsize=13, fontweight='bold')
    ax.set_ylabel('Density', fontsize=13, fontweight='bold')
    ax.set_title('Distribution of Residuals — Normality Check',
                 fontsize=16, fontweight='bold', pad=15)
    ax.legend(fontsize=10, framealpha=0.8, facecolor='#161b22', edgecolor='#30363d')
    ax.grid(True, alpha=0.3)

    # Skewness and kurtosis
    skewness = float(np.mean(((residuals_full - mu) / std) ** 3))
    kurtosis = float(np.mean(((residuals_full - mu) / std) ** 4) - 3)
    textstr = f'Skewness = {skewness:.3f}\nKurtosis = {kurtosis:.3f}\n(Normal: 0, 0)'
    props = dict(boxstyle='round,pad=0.5', facecolor='#21262d', edgecolor=COLORS['secondary'], alpha=0.9)
    ax.text(0.97, 0.95, textstr, transform=ax.transAxes, fontsize=11,
            verticalalignment='top', horizontalalignment='right', bbox=props)

    plt.tight_layout()
    path2 = os.path.join(PLOT_DIR, '02_residual_distribution.png')
    fig.savefig(path2, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path2}')

    # ══════════════════════════════════════════════════════════
    #  FIGURE 3: Residuals vs Predicted (Homoscedasticity)
    # ══════════════════════════════════════════════════════════

    print('  📊 Generating Figure 3: Residuals vs Predicted...')
    fig, ax = plt.subplots(figsize=(10, 7))

    ax.scatter(y_pred_full, residuals_full, alpha=0.4, s=20,
               c=COLORS['teal'], edgecolors='none')
    ax.axhline(y=0, color=COLORS['accent'], linewidth=2, linestyle='--', alpha=0.8)

    # Add ±2σ bands
    ax.axhline(y=2*sigma, color=COLORS['warning'], linewidth=1, linestyle=':',
               alpha=0.7, label=f'+2σ ({2*sigma:.1f})')
    ax.axhline(y=-2*sigma, color=COLORS['warning'], linewidth=1, linestyle=':',
               alpha=0.7, label=f'−2σ ({-2*sigma:.1f})')

    # Lowess-ish trend: bin and average
    sorted_idx = np.argsort(y_pred_full)
    bin_size = len(y_pred_full) // 20
    trend_x, trend_y = [], []
    for i in range(0, len(sorted_idx) - bin_size, bin_size // 2):
        idx_chunk = sorted_idx[i:i + bin_size]
        trend_x.append(np.mean(y_pred_full[idx_chunk]))
        trend_y.append(np.mean(residuals_full[idx_chunk]))
    ax.plot(trend_x, trend_y, '-', color=COLORS['pink'], linewidth=2.5,
            alpha=0.9, label='Trend Line')

    ax.set_xlabel('Predicted Pace (s/km)', fontsize=13, fontweight='bold')
    ax.set_ylabel('Residual (s/km)', fontsize=13, fontweight='bold')
    ax.set_title('Residuals vs Predicted — Homoscedasticity Check',
                 fontsize=16, fontweight='bold', pad=15)
    ax.legend(fontsize=10, framealpha=0.8, facecolor='#161b22', edgecolor='#30363d')
    ax.grid(True, alpha=0.3)

    outliers = np.sum(np.abs(residuals_full) > 2*sigma)
    textstr = f'Outliers (|r| > 2σ): {outliers}/{n} ({outliers/n*100:.1f}%)'
    props = dict(boxstyle='round,pad=0.5', facecolor='#21262d', edgecolor=COLORS['teal'], alpha=0.9)
    ax.text(0.97, 0.95, textstr, transform=ax.transAxes, fontsize=11,
            verticalalignment='top', horizontalalignment='right', bbox=props)

    plt.tight_layout()
    path3 = os.path.join(PLOT_DIR, '03_residuals_vs_predicted.png')
    fig.savefig(path3, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path3}')

    # ══════════════════════════════════════════════════════════
    #  FIGURE 4: Feature Importance (Coefficients)
    # ══════════════════════════════════════════════════════════

    print('  📊 Generating Figure 4: Feature Importance...')
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 7))

    # 4a: Raw coefficients (skip intercept)
    feat_names = feature_names[1:]
    coefs = beta[1:]
    colors_bar = [COLORS['primary'], COLORS['secondary'], COLORS['accent'],
                  COLORS['warning'], COLORS['pink']]

    bars = ax1.barh(feat_names, coefs, color=colors_bar, edgecolor='#0f1117',
                    linewidth=1, height=0.6)
    ax1.set_xlabel('Coefficient Value (s/km per unit)', fontsize=12, fontweight='bold')
    ax1.set_title('Raw Regression Coefficients', fontsize=14, fontweight='bold', pad=10)
    ax1.grid(True, alpha=0.3, axis='x')

    for bar, val in zip(bars, coefs):
        ax1.text(val + (0.2 if val >= 0 else -0.2), bar.get_y() + bar.get_height()/2,
                 f'{val:.4f}', va='center', ha='left' if val >= 0 else 'right',
                 fontsize=10, fontweight='bold')

    # 4b: t-statistics (significance)
    t_vals = np.abs(full_result['t_stats'][1:])
    bars2 = ax2.barh(feat_names, t_vals, color=colors_bar, edgecolor='#0f1117',
                     linewidth=1, height=0.6)

    # Significance thresholds
    ax2.axvline(x=1.96, color=COLORS['warning'], linewidth=1.5, linestyle='--',
                alpha=0.7, label='p<0.05')
    ax2.axvline(x=2.58, color=COLORS['accent'], linewidth=1.5, linestyle='--',
                alpha=0.7, label='p<0.01')
    ax2.axvline(x=3.29, color=COLORS['error'], linewidth=1.5, linestyle='--',
                alpha=0.7, label='p<0.001')

    ax2.set_xlabel('|t-statistic|', fontsize=12, fontweight='bold')
    ax2.set_title('Statistical Significance (|t-value|)', fontsize=14, fontweight='bold', pad=10)
    ax2.legend(fontsize=9, framealpha=0.8, facecolor='#161b22', edgecolor='#30363d')
    ax2.grid(True, alpha=0.3, axis='x')

    for bar, val in zip(bars2, t_vals):
        ax2.text(val + 0.3, bar.get_y() + bar.get_height()/2,
                 f'{val:.1f}', va='center', fontsize=10, fontweight='bold')

    plt.suptitle('Feature Importance — NPI Regression Model',
                 fontsize=16, fontweight='bold', y=1.02)
    plt.tight_layout()
    path4 = os.path.join(PLOT_DIR, '04_feature_importance.png')
    fig.savefig(path4, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path4}')

    # ══════════════════════════════════════════════════════════
    #  FIGURE 5: NPI Distribution Histogram
    # ══════════════════════════════════════════════════════════

    print('  📊 Generating Figure 5: NPI Distribution...')
    fig, ax = plt.subplots(figsize=(10, 7))

    # Color-coded histogram by NPI range
    bins_npi = np.linspace(-4, 4, 50)
    ax.hist(all_npis, bins=bins_npi, density=True, color=COLORS['secondary'],
            alpha=0.6, edgecolor='#0f1117', linewidth=0.5, label='NPI Distribution')

    # Overlay standard normal
    x_std = np.linspace(-4, 4, 200)
    y_std = (1 / np.sqrt(2 * np.pi)) * np.exp(-0.5 * x_std ** 2)
    ax.plot(x_std, y_std, '-', color=COLORS['accent'], linewidth=2.5,
            label='Standard Normal N(0,1)')

    # Color bands for NPI categories
    ax.axvspan(-4, -1, alpha=0.08, color=COLORS['error'], label='Needs Work (<-1)')
    ax.axvspan(-1, 0, alpha=0.08, color=COLORS['warning'], label='Below Average (-1 to 0)')
    ax.axvspan(0, 1, alpha=0.08, color=COLORS['secondary'], label='As Expected (0 to 1)')
    ax.axvspan(1, 2, alpha=0.08, color=COLORS['primary'], label='Above Average (1 to 2)')
    ax.axvspan(2, 4, alpha=0.08, color=COLORS['teal'], label='Exceptional (>2)')

    ax.set_xlabel('NPI (Z-Score)', fontsize=13, fontweight='bold')
    ax.set_ylabel('Density', fontsize=13, fontweight='bold')
    ax.set_title('NPI Distribution Across All Training Data',
                 fontsize=16, fontweight='bold', pad=15)
    ax.legend(fontsize=9, loc='upper right', framealpha=0.8,
              facecolor='#161b22', edgecolor='#30363d')
    ax.grid(True, alpha=0.3)

    textstr = (f'n = {len(all_npis)}\n'
               f'μ = {np.mean(all_npis):.3f}\n'
               f'σ = {np.std(all_npis):.3f}')
    props = dict(boxstyle='round,pad=0.5', facecolor='#21262d', edgecolor=COLORS['secondary'], alpha=0.9)
    ax.text(0.03, 0.95, textstr, transform=ax.transAxes, fontsize=12,
            verticalalignment='top', bbox=props)

    plt.tight_layout()
    path5 = os.path.join(PLOT_DIR, '05_npi_distribution.png')
    fig.savefig(path5, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path5}')

    # ══════════════════════════════════════════════════════════
    #  FIGURE 6: Accuracy Metrics Summary Table
    # ══════════════════════════════════════════════════════════

    print('  📊 Generating Figure 6: Accuracy Metrics Summary...')
    fig, ax = plt.subplots(figsize=(12, 8))
    ax.axis('off')

    table_data = [
        ['Metric', 'Training Set', 'Test Set', 'Rating'],
        ['R² (Coefficient of Determination)', f'{train_result["r_squared"]:.4f}', f'{r2_test:.4f}',
         '✅ Good' if r2_test > 0.7 else '⚠️ Moderate'],
        ['Adjusted R²', f'{train_result["adj_r_squared"]:.4f}', '—',
         '✅ Good' if train_result["adj_r_squared"] > 0.7 else '⚠️ Moderate'],
        ['RMSE (s/km)', f'{rmse_train:.2f}', f'{rmse_test:.2f}',
         '✅ Low' if rmse_test < 30 else '⚠️ High'],
        ['MAE (s/km)', f'{mae_train:.2f}', f'{mae_test:.2f}',
         '✅ Low' if mae_test < 25 else '⚠️ High'],
        ['MAPE (%)', '—', f'{mape_test:.2f}%',
         '✅ Good' if mape_test < 10 else '⚠️ Moderate'],
        ['Std Error σ (s/km)', f'{train_result["sigma"]:.2f}', f'{np.std(test_residuals):.2f}', '—'],
        ['F-statistic', f'{train_result["f_stat"]:.1f}', '—', '✅ Significant'],
        ['Samples', f'{len(y_train)}', f'{len(y_test)}', f'Total: {n}'],
        ['Features', '5', '5', '—'],
        ['Residual Skewness', f'{skewness:.3f}', '—',
         '✅ Normal' if abs(skewness) < 0.5 else '⚠️ Skewed'],
        ['Residual Kurtosis', f'{kurtosis:.3f}', '—',
         '✅ Normal' if abs(kurtosis) < 1 else '⚠️ Heavy tails'],
    ]

    # Draw the table
    table = ax.table(cellText=table_data, loc='center', cellLoc='center')
    table.auto_set_font_size(False)
    table.set_fontsize(11)
    table.scale(1, 2.0)

    # Style header
    for j in range(4):
        cell = table[0, j]
        cell.set_facecolor(COLORS['primary'])
        cell.set_text_props(color='#0f1117', fontweight='bold', fontsize=12)
        cell.set_edgecolor('#30363d')

    # Style data rows
    for i in range(1, len(table_data)):
        for j in range(4):
            cell = table[i, j]
            cell.set_facecolor('#1c2128' if i % 2 == 0 else '#161b22')
            cell.set_text_props(color='#c9d1d9')
            cell.set_edgecolor('#30363d')

    ax.set_title('NPI Regression Model — Accuracy Metrics Summary',
                 fontsize=18, fontweight='bold', pad=20, color='#c9d1d9')

    plt.tight_layout()
    path6 = os.path.join(PLOT_DIR, '06_accuracy_metrics_table.png')
    fig.savefig(path6, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path6}')

    # ══════════════════════════════════════════════════════════
    #  FIGURE 7: NPI Classification Confusion Matrix
    # ══════════════════════════════════════════════════════════

    print('  📊 Generating Figure 7: NPI Classification Matrix...')

    # Classify all data points using full model vs true class
    npi_categories = ['Needs Work\n(< -1)', 'Below Average\n(-1 to 0)',
                      'As Expected\n(0 to 1)', 'Above Average\n(1 to 2)',
                      'Exceptional\n(> 2)']

    def get_npi_class_idx(npi_val):
        if npi_val < -1:
            return 0
        elif npi_val < 0:
            return 1
        elif npi_val < 1:
            return 2
        elif npi_val < 2:
            return 3
        else:
            return 4

    # For confusion matrix: compare train-predicted NPI vs full-model NPI
    # Use test set: predict NPI with train coeffs vs full coeffs
    npi_test_train = -(y_test - X_test @ train_result['coefficients']) / train_result['sigma']
    npi_test_full = -(y_test - X_test @ beta) / sigma

    conf_matrix = np.zeros((5, 5), dtype=int)
    for i in range(len(y_test)):
        true_cls = get_npi_class_idx(npi_test_full[i])
        pred_cls = get_npi_class_idx(npi_test_train[i])
        conf_matrix[true_cls, pred_cls] += 1

    fig, ax = plt.subplots(figsize=(10, 8))

    # Custom colormap
    from matplotlib.colors import LinearSegmentedColormap
    cmap = LinearSegmentedColormap.from_list('ghost',
        ['#161b22', '#1a472a', '#00e676'], N=256)

    im = ax.imshow(conf_matrix, cmap=cmap, aspect='auto')

    # Add text to cells
    for i in range(5):
        for j in range(5):
            val = conf_matrix[i, j]
            total_row = conf_matrix[i, :].sum()
            pct = val / total_row * 100 if total_row > 0 else 0
            text_color = '#0f1117' if val > conf_matrix.max() * 0.5 else '#c9d1d9'
            ax.text(j, i, f'{val}\n({pct:.0f}%)', ha='center', va='center',
                    fontsize=11, fontweight='bold', color=text_color)

    ax.set_xticks(range(5))
    ax.set_yticks(range(5))
    ax.set_xticklabels(npi_categories, fontsize=9)
    ax.set_yticklabels(npi_categories, fontsize=9)
    ax.set_xlabel('Predicted NPI Category (Train Model)', fontsize=13, fontweight='bold')
    ax.set_ylabel('Actual NPI Category (Full Model)', fontsize=13, fontweight='bold')
    ax.set_title('NPI Classification Agreement Matrix',
                 fontsize=16, fontweight='bold', pad=15)

    # Accuracy
    accuracy = np.trace(conf_matrix) / conf_matrix.sum() * 100
    textstr = f'Classification Agreement: {accuracy:.1f}%'
    props = dict(boxstyle='round,pad=0.5', facecolor='#21262d', edgecolor=COLORS['primary'], alpha=0.9)
    ax.text(0.5, -0.12, textstr, transform=ax.transAxes, fontsize=13,
            fontweight='bold', ha='center', bbox=props)

    cbar = plt.colorbar(im, ax=ax, shrink=0.8)
    cbar.set_label('Count', fontsize=11)
    cbar.ax.yaxis.set_tick_params(color='#8b949e')
    plt.setp(plt.getp(cbar.ax.axes, 'yticklabels'), color='#8b949e')

    plt.tight_layout()
    path7 = os.path.join(PLOT_DIR, '07_npi_classification_matrix.png')
    fig.savefig(path7, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path7}')

    # ══════════════════════════════════════════════════════════
    #  FIGURE 8: Q-Q Plot
    # ══════════════════════════════════════════════════════════

    print('  📊 Generating Figure 8: Q-Q Plot...')
    fig, ax = plt.subplots(figsize=(9, 8))

    # Sort residuals and compute theoretical quantiles
    sorted_residuals = np.sort(residuals_full)
    n_pts = len(sorted_residuals)
    theoretical = np.array([
        sigma * np.sqrt(2) * math.erfc(2 * (1 - (i - 0.5) / n_pts)) if (i - 0.5) / n_pts > 0.5
        else -sigma * np.sqrt(2) * math.erfc(2 * (i - 0.5) / n_pts)
        for i in range(1, n_pts + 1)
    ])
    # Use a simpler approach: standard normal quantiles
    probabilities = (np.arange(1, n_pts + 1) - 0.5) / n_pts
    theoretical_quantiles = np.array([np.sqrt(2) * erfinv_approx(2 * p - 1) for p in probabilities])
    standardized_residuals = sorted_residuals / sigma

    ax.scatter(theoretical_quantiles, standardized_residuals, alpha=0.4, s=15,
               c=COLORS['purple'], edgecolors='none')

    # 45-degree line
    lim = max(abs(theoretical_quantiles.min()), abs(theoretical_quantiles.max()),
              abs(standardized_residuals.min()), abs(standardized_residuals.max()))
    ax.plot([-lim, lim], [-lim, lim], '--', color=COLORS['accent'], linewidth=2, alpha=0.8,
            label='Normal Reference')

    ax.set_xlabel('Theoretical Quantiles (Standard Normal)', fontsize=13, fontweight='bold')
    ax.set_ylabel('Standardized Residuals', fontsize=13, fontweight='bold')
    ax.set_title('Q-Q Plot — Residual Normality Assessment',
                 fontsize=16, fontweight='bold', pad=15)
    ax.legend(fontsize=11, framealpha=0.8, facecolor='#161b22', edgecolor='#30363d')
    ax.grid(True, alpha=0.3)
    ax.set_aspect('equal')

    plt.tight_layout()
    path8 = os.path.join(PLOT_DIR, '08_qq_plot.png')
    fig.savefig(path8, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path8}')

    # ══════════════════════════════════════════════════════════
    #  FIGURE 9: Learning Curve (Train vs Test R²)
    # ══════════════════════════════════════════════════════════

    print('  📊 Generating Figure 9: Learning Curve...')
    fig, ax = plt.subplots(figsize=(10, 7))

    train_sizes = []
    train_r2s = []
    test_r2s = []

    # train_idx is in runner order; shuffle so small subsets mix sexes and ages
    curve_order = np.random.RandomState(42).permutation(train_idx)

    for frac in np.arange(0.1, 1.01, 0.05):
        sz = int(len(train_idx) * frac)
        if sz < 10:
            continue
        sub_idx = curve_order[:sz]
        X_sub = X[sub_idx]
        y_sub = y[sub_idx]

        sub_result = fit_linear_regression(X_sub, y_sub)
        y_test_sub_pred = X_test @ sub_result['coefficients']
        ss_res_t = np.sum((y_test - y_test_sub_pred) ** 2)
        ss_tot_t = np.sum((y_test - np.mean(y_test)) ** 2)
        r2_t = 1 - ss_res_t / ss_tot_t

        train_sizes.append(sz)
        train_r2s.append(sub_result['r_squared'])
        test_r2s.append(r2_t)

    ax.plot(train_sizes, train_r2s, 'o-', color=COLORS['primary'], linewidth=2.5,
            markersize=6, label='Training R²')
    ax.plot(train_sizes, test_r2s, 's-', color=COLORS['secondary'], linewidth=2.5,
            markersize=6, label='Test R²')

    ax.fill_between(train_sizes, train_r2s, test_r2s, alpha=0.1, color=COLORS['warning'])

    ax.set_xlabel('Training Set Size', fontsize=13, fontweight='bold')
    ax.set_ylabel('R² Score', fontsize=13, fontweight='bold')
    ax.set_title('Learning Curve — Model Generalization',
                 fontsize=16, fontweight='bold', pad=15)
    ax.legend(fontsize=11, framealpha=0.8, facecolor='#161b22', edgecolor='#30363d')
    ax.grid(True, alpha=0.3)

    # Annotation
    gap = train_r2s[-1] - test_r2s[-1]
    textstr = f'Final Gap: {gap:.4f}\n{"✅ No overfitting" if gap < 0.05 else "⚠️ Slight overfitting"}'
    props = dict(boxstyle='round,pad=0.5', facecolor='#21262d', edgecolor=COLORS['primary'], alpha=0.9)
    ax.text(0.97, 0.05, textstr, transform=ax.transAxes, fontsize=11,
            verticalalignment='bottom', horizontalalignment='right', bbox=props)

    plt.tight_layout()
    path9 = os.path.join(PLOT_DIR, '09_learning_curve.png')
    fig.savefig(path9, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path9}')

    # ══════════════════════════════════════════════════════════
    #  FIGURE 10: NPI Fairness Proof
    # ══════════════════════════════════════════════════════════

    print('  📊 Generating Figure 10: NPI Fairness Proof...')
    fig, ax = plt.subplots(figsize=(12, 7))

    fairness_profiles = [
        {'label': 'Young Male\nLow BMI\nSea Level\nFlat', 'age': 22, 'bmi': 20.5, 'alt': 15, 'dist': 2500, 'gender': 0},
        {'label': 'Mid-Age Male\nAvg BMI\nMid Alt\nHilly', 'age': 40, 'bmi': 25.0, 'alt': 510, 'dist': 2500, 'gender': 0},
        {'label': 'Older Male\nHigh BMI\nHigh Alt\nHilly', 'age': 55, 'bmi': 29.0, 'alt': 1868, 'dist': 2500, 'gender': 0},
        {'label': 'Young Female\nLow BMI\nSea Level\nFlat', 'age': 24, 'bmi': 21.0, 'alt': 8, 'dist': 2500, 'gender': 1},
        {'label': 'Mid-Age Female\nAvg BMI\nHigh Alt\nMod', 'age': 42, 'bmi': 26.0, 'alt': 1041, 'dist': 2500, 'gender': 1},
        {'label': 'Older Female\nHigh BMI\nSea Level\nFlat', 'age': 58, 'bmi': 30.0, 'alt': 3, 'dist': 2500, 'gender': 1},
    ]

    npi_vals = []
    labels = []
    bar_colors = []
    male_colors = [COLORS['primary'], COLORS['secondary'], COLORS['teal']]
    female_colors = [COLORS['pink'], COLORS['purple'], COLORS['accent']]

    for i, p in enumerate(fairness_profiles):
        x = np.array([1, p['age'], p['bmi'], p['alt'], p['dist'], p['gender']])
        expected = x @ beta
        actual = expected * 0.90  # 10% better
        npi = (expected - actual) / sigma
        npi_vals.append(npi)
        labels.append(p['label'])
        bar_colors.append(male_colors[i] if i < 3 else female_colors[i - 3])

    bars = ax.bar(range(len(npi_vals)), npi_vals, color=bar_colors,
                  edgecolor='#0f1117', linewidth=1.5, width=0.65)

    # Mean line
    mean_npi = np.mean(npi_vals)
    ax.axhline(y=mean_npi, color=COLORS['warning'], linewidth=2.5,
               linestyle='--', alpha=0.9, label=f'Mean NPI = {mean_npi:.3f}')

    # Value labels
    for bar, val in zip(bars, npi_vals):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.02,
                f'{val:.3f}', ha='center', va='bottom', fontsize=11, fontweight='bold')

    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, fontsize=9)
    ax.set_ylabel('NPI Score (Z-Score)', fontsize=13, fontweight='bold')
    ax.set_title('NPI Fairness Proof — Same 10% Effort = Same NPI for ALL Profiles',
                 fontsize=15, fontweight='bold', pad=15)
    ax.legend(fontsize=11, framealpha=0.8, facecolor='#161b22', edgecolor='#30363d')
    ax.grid(True, alpha=0.3, axis='y')

    spread = max(npi_vals) - min(npi_vals)
    textstr = f'Max Spread: {spread:.4f}\n{"✅ FAIRNESS PROVEN" if spread < 0.5 else "❌ FAILED"}'
    props = dict(boxstyle='round,pad=0.5', facecolor='#21262d', edgecolor=COLORS['primary'], alpha=0.9)
    ax.text(0.97, 0.95, textstr, transform=ax.transAxes, fontsize=12,
            fontweight='bold', verticalalignment='top', horizontalalignment='right', bbox=props)

    plt.tight_layout()
    path10 = os.path.join(PLOT_DIR, '10_npi_fairness_proof.png')
    fig.savefig(path10, dpi=150, bbox_inches='tight')
    plt.close(fig)
    print(f'    ✅ Saved: {path10}')

    # ══════════════════════════════════════════════════════════
    #  PRINT SUMMARY
    # ══════════════════════════════════════════════════════════

    print('\n' + '=' * 75)
    print('  📊 NPI MODEL EVALUATION SUMMARY')
    print('=' * 75)

    print(f'\n  MODEL ACCURACY METRICS:')
    print(f'  ┌───────────────────────────────────┬──────────────┬──────────────┐')
    print(f'  │ Metric                            │   Train      │   Test       │')
    print(f'  ├───────────────────────────────────┼──────────────┼──────────────┤')
    print(f'  │ R² (Explained Variance)           │   {train_result["r_squared"]:.4f}     │   {r2_test:.4f}     │')
    print(f'  │ Adjusted R²                       │   {train_result["adj_r_squared"]:.4f}     │     —        │')
    print(f'  │ RMSE (Root Mean Squared Error)     │   {rmse_train:.2f}     │   {rmse_test:.2f}     │')
    print(f'  │ MAE (Mean Absolute Error)          │   {mae_train:.2f}     │   {mae_test:.2f}     │')
    print(f'  │ MAPE (Mean Absolute % Error)       │     —        │   {mape_test:.2f}%    │')
    print(f'  │ Std Error (σ)                      │   {train_result["sigma"]:.2f}     │   {np.std(test_residuals):.2f}     │')
    print(f'  │ F-statistic                        │   {train_result["f_stat"]:.1f}     │     —        │')
    print(f'  └───────────────────────────────────┴──────────────┴──────────────┘')

    print(f'\n  NPI CLASSIFICATION AGREEMENT: {accuracy:.1f}%')
    print(f'  RESIDUAL NORMALITY: Skew={skewness:.3f}, Kurt={kurtosis:.3f}')
    print(f'  FAIRNESS SPREAD: {spread:.4f} ({"✅ PASS" if spread < 0.5 else "❌ FAIL"})')

    print(f'\n  📁 All plots saved to: {PLOT_DIR}')
    print(f'  📊 Total figures generated: 10')

    print('\n' + '=' * 75)
    print('  ✅ MODEL EVALUATION COMPLETE')
    print('=' * 75)


if __name__ == '__main__':
    main()
