"""
A2 — SQLite write latency: WAL vs rollback journal
===================================================

Inserts 1,000 GPS points one at a time, each in its own transaction (as the
app does: one INSERT per accepted 1 Hz fix), into a table with the same
columns as the app's telemetry_points. Repeated 5 times per configuration
on a fresh database file.

Configurations:
  rollback-full  journal_mode=DELETE, synchronous=FULL    (SQLite default)
  rollback-norm  journal_mode=DELETE, synchronous=NORMAL
  wal-full       journal_mode=WAL,    synchronous=FULL
  wal-normal     journal_mode=WAL,    synchronous=NORMAL  (the app's setting)

Runs with Python's sqlite3 on the development laptop's disk, not on a phone:
absolute times depend on the storage device, the ratio is the useful result.

Output: benchmarks_output/wal.json
"""

import io
import json
import os
import platform
import random
import sqlite3
import statistics
import sys
import tempfile
import time
from datetime import datetime

if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, '..', 'benchmarks_output')

INSERTS = 1000
REPEATS = 5
SEED = 42

CONFIGS = [
    ('rollback-full', 'DELETE', 'FULL'),
    ('rollback-norm', 'DELETE', 'NORMAL'),
    ('wal-full', 'WAL', 'FULL'),
    ('wal-normal', 'WAL', 'NORMAL'),
]

SCHEMA = """
CREATE TABLE telemetry_points (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  altitude REAL,
  timestamp INTEGER NOT NULL,
  velocity REAL,
  accuracy REAL,
  seq_index INTEGER NOT NULL
)
"""

INSERT = """INSERT INTO telemetry_points
  (id, session_id, latitude, longitude, altitude, timestamp, velocity, accuracy, seq_index)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"""


def make_rows(rng):
    lat, lon, t0 = 6.8402, 79.8877, 1_793_000_000_000
    rows = []
    for i in range(INSERTS):
        lat += rng.uniform(-2e-5, 2e-5)
        lon += rng.uniform(-2e-5, 2e-5)
        rows.append((
            '%04x-%04x-%04x' % (rng.getrandbits(16), rng.getrandbits(16), rng.getrandbits(16)),
            'bench-session', lat, lon, 15.0 + rng.uniform(-1, 1), t0 + i * 1000,
            rng.uniform(2.0, 4.0), rng.uniform(3.0, 15.0), i,
        ))
    return rows


def run_config(journal, sync, rows, workdir):
    path = os.path.join(workdir, f'bench_{journal}_{sync}.db')
    for suffix in ('', '-wal', '-shm', '-journal'):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)

    conn = sqlite3.connect(path, isolation_level=None)  # autocommit: one transaction per INSERT
    mode = conn.execute(f'PRAGMA journal_mode = {journal}').fetchone()[0]
    conn.execute(f'PRAGMA synchronous = {sync}')
    conn.execute(SCHEMA)

    latencies_ms = []
    for row in rows:
        t0 = time.perf_counter_ns()
        conn.execute(INSERT, row)
        latencies_ms.append((time.perf_counter_ns() - t0) / 1e6)

    count = conn.execute('SELECT COUNT(*) FROM telemetry_points').fetchone()[0]
    conn.close()
    assert count == len(rows), f'expected {len(rows)} rows, found {count}'
    return mode, latencies_ms


def pct(sorted_vals, p):
    idx = min(len(sorted_vals) - 1, max(0, -(-p * len(sorted_vals) // 100) - 1))
    return sorted_vals[int(idx)]


def main():
    rng = random.Random(SEED)
    rows = make_rows(rng)
    results = {}

    with tempfile.TemporaryDirectory(prefix='gt_wal_') as workdir:
        for name, journal, sync in CONFIGS:
            all_lat, run_means = [], []
            for _ in range(REPEATS):
                mode, lat = run_config(journal, sync, rows, workdir)
                all_lat.extend(lat)
                run_means.append(statistics.mean(lat))
            s = sorted(all_lat)
            results[name] = {
                'journal_mode': mode,
                'synchronous': sync,
                'samples': len(all_lat),
                'mean_ms': statistics.mean(all_lat),
                'sd_ms': statistics.stdev(all_lat),
                'p50_ms': pct(s, 50),
                'p95_ms': pct(s, 95),
                'p99_ms': pct(s, 99),
                'max_ms': s[-1],
                'run_means_ms': run_means,
                'inserts_per_s': 1000 / statistics.mean(all_lat),
            }
            r = results[name]
            print(f'  {name:<14} mean {r["mean_ms"]:.3f} ms  p50 {r["p50_ms"]:.3f}  p99 {r["p99_ms"]:.3f}  '
                  f'({r["inserts_per_s"]:.0f} inserts/s)')

    base, app = results['rollback-full'], results['wal-normal']
    out = {
        'benchmark': 'A2 SQLite single-row insert latency, WAL vs rollback journal',
        'environment': 'Python sqlite3 on development machine disk (not a phone)',
        'machine': {
            'cpu': platform.processor() or platform.machine(),
            'os': f'{platform.system()} {platform.release()}',
            'python': platform.python_version(),
            'sqlite': sqlite3.sqlite_version,
            'measuredAt': datetime.now().isoformat(timespec='seconds'),
        },
        'config': {'inserts': INSERTS, 'repeats': REPEATS, 'seed': SEED, 'transaction': 'one per INSERT'},
        'results': results,
        'speedup_wal_normal_vs_rollback_full': {
            'mean': base['mean_ms'] / app['mean_ms'],
            'p50': base['p50_ms'] / app['p50_ms'],
        },
        'speedup_wal_full_vs_rollback_full': {
            'mean': base['mean_ms'] / results['wal-full']['mean_ms'],
        },
    }
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    path = os.path.abspath(os.path.join(OUTPUT_DIR, 'wal.json'))
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=2)
        f.write('\n')
    print(f'  speed-up (app WAL+NORMAL vs default rollback+FULL): '
          f'{out["speedup_wal_normal_vs_rollback_full"]["mean"]:.1f}x by mean')
    print(f'  -> {path}')


if __name__ == '__main__':
    print('A2 SQLite WAL vs rollback')
    main()
