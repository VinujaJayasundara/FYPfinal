# Phase A — Measured numbers for the thesis

Every number below comes from a script in this repo. Run them all with:

```
cd GhostTracker
npm run bench
```

The scripts are seeded, so A3–A7 give exactly the same numbers on every run. A1 and A2 are timings and move slightly between runs. Round them as shown.

**Machine:**
- Development laptop: Intel Core i5-10200H, 2.40 GHz, 8 logical cores, 16 GB RAM
- Windows 11 (build 26300)
- Node.js 24.6.0, Python 3.14.6, SQLite 3.50.4
- Measured 28 Oct 2026

**Wording for the thesis:** "measured on a development laptop". **None of these are phone measurements.** On-phone values come in Phase G.

---

## A1 — Inference latency

`scripts/benchmarks/inference_latency.ts` → `inference.json`

The work timed per call: `predictExpectedPace` + `calculateNPI` (app `npiEngine.ts`) + `calculateRII` (core `riiEngine.ts`).

| Measure | Value |
|---|---|
| Mean per call (30 × 10,000 calls, wall time ÷ calls) | **≈ 89 ns = 0.00009 ms** |
| Per-call p99 (10,000 individually timed calls) | ≤ 1 µs (Windows clock resolution is 100 ns) |

**Thesis text.** The full fairness computation takes under 0.1 µs per session on a laptop (mean of 300,000 calls). That is far below the 0.04 ms target (NFR-01). Phone CPUs are slower, so an on-device figure is still needed (Phase G). Even at 100× slower it would stay under 0.01 ms.

**Replaces:** "0.04 ms / < 0.01 ms" claims in Table 10, NFR-01, 5.2.3 and H2.

---

## A2 — SQLite write latency, WAL vs rollback journal

`scripts/benchmarks/sqlite_wal.py` → `wal.json`

Setup:
- 1,000 single-row INSERTs, each in its own transaction (one per GPS fix), × 5 repeats.
- Table has the same columns as the app's `telemetry_points`.

| Configuration | Mean per insert | p50 | p99 | Inserts/s |
|---|---|---|---|---|
| Rollback journal, synchronous = FULL (SQLite default) | **≈ 3.3 ms** | 2.88 ms | 9.6 ms | ≈ 300 |
| Rollback journal, synchronous = NORMAL | 2.37 ms | 2.26 ms | 4.2 ms | ≈ 420 |
| WAL, synchronous = FULL | 0.54 ms | 0.50 ms | 0.94 ms | ≈ 1,860 |
| **WAL, synchronous = NORMAL (the app's setting)** | **0.055 ms** | 0.029 ms | 0.15 ms | ≈ 18,000 |

**Speed-up.** The app setting (WAL + NORMAL) is **≈ 55–60× faster** than the default (rollback + FULL), measured across two runs. With synchronous held at FULL, WAL alone is about 6× faster.

**Thesis text.** Write "WAL with synchronous = NORMAL reduced mean single-insert latency from about 3.3 ms to 0.055 ms (≈ 60×) on the development laptop."

**Honest caveat to include.** With synchronous = NORMAL in WAL mode, a commit is not fsynced to disk straight away. A power cut can lose the last few points. It cannot corrupt the database. For 1 Hz GPS logging that trade-off is acceptable.

**Replaces:** "1.12 ms / 14.80 ms / 13.2×" in Table 34, NFR-02 and H2.

---

## A3 — Sync payload sizes

`scripts/benchmarks/payload_sizes.ts` → `payload.json`

The entries are shaped like the app's real records: 14-character IDs, a 29-character device ID, and real alias and route names. The table shows the case where every entry comes from one runner.

| Entries | Binary v2 (bytes) | Old JSON (bytes) | Frames at 512 B |
|---|---|---|---|
| 1 | **171** | 427 | 1 |
| 2 | **259** | 694 | 1 |
| 4 | **435** | 1,235 | 1 |
| 6 | 611 | 1,769 | 2 |
| 8 | **787** | 2,298 | 2 |
| 20 | 1,853 | 5,529 | 4 |
| 40 | 3,633 | 10,915 | 8 |

Other figures:
- Each extra entry adds **88.8 bytes**.
- Binary is **≈ 33–40 % of the JSON size**, so 2.5–3× smaller.
- The state hash broadcast every round is **16 bytes**.
- With one entry per runner (8 different runners), 8 entries = 1,067 B (3 frames). Each new device also adds its counter to the state vector.

**Thesis text.** Replace "128 / 210 / 298 / 384 B" and "353 B" with the binary column. A single result fits one 512-byte BLE frame up to 4 entries. After that the payload is split into frames, each with a 4-byte header.

**Replaces:** values in NFR-04, IT-03, 4.4.4 and App. B/C.

---

## A4 — Gossip convergence (simulated)

`scripts/benchmarks/gossip_convergence.ts` → `gossip.json`

What was simulated:
- The real `GossipSession` code (hash → digest → framed delta) on an in-memory broadcast network.
- Grid: 2/4/6/8 nodes × 0/15/30 % message loss × 100 seeds per cell. Each node starts with 3 results no other node has.
- **All 1,200 runs converged**, with no errors.

| Nodes | Loss | Rounds, mean | Rounds, p99 | Time ≤ (mean) | Time ≤ (p99) |
|---|---|---|---|---|---|
| 2 | 0 % | 1.00 | 1 | 2.5 s | 2.5 s |
| 2 | 15 % | 2.12 | 5 | 5.3 s | 12.5 s |
| 2 | 30 % | 3.98 | 15 | 10.0 s | 37.5 s |
| 4 | 0 % | 1.00 | 1 | 2.5 s | 2.5 s |
| 4 | 15 % | 2.54 | 5 | 6.4 s | 12.5 s |
| 4 | 30 % | 4.82 | 9 | 12.1 s | 22.5 s |
| 6 | 0 % | 1.00 | 1 | 2.5 s | 2.5 s |
| 6 | 15 % | 2.45 | 3 | 6.1 s | 7.5 s |
| 6 | 30 % | 4.94 | 9 | 12.4 s | 22.5 s |
| **8** | **0 %** | **1.00** | **1** | **2.5 s** | **2.5 s** |
| **8** | **15 %** | **2.56** | **4** | **6.4 s** | **10.0 s** |
| **8** | **30 %** | **4.85** | **8** | **12.1 s** | **20.0 s** |

How to read the time columns:
- Time = rounds × 2.5 s (the gossip interval).
- The first round fires immediately, so this is an upper bound on protocol time.
- **It excludes BLE connection set-up and air time.**

Once converged, each round costs only one 16-byte hash per node: 128 B per round for 8 nodes. With 8 nodes and no loss, reaching convergence took about 35 KB in total.

**Thesis text.** Label this "simulated" everywhere. Suggested sentence: "In a protocol simulation of 8 nodes with 15 % message loss, all 100 trials converged, with a mean of 2.6 gossip rounds (≤ 6.4 s at the 2.5 s interval) and at most 4 rounds at p99. At 30 % loss the mean was 4.9 rounds (≤ 12.1 s)."

**Replaces:** "8 nodes within 9.46 s", Table 34, NFR-03, 5.2.4 and H3, where "8-node hybrid BLE testbed" becomes "8-node simulated network".

---

## A5 — Figure: coefficients, |t| and recovery

The figure is `analysis_output/evaluation_plots/11_coefficient_recovery.png`. It replaces **Fig 20** (the old 6-feature image).

Full-data fit, n = 1,200, σ = 24.16 s/km. The values match the app and thesis Table 31.

| Term | β | SE | t | True value | Recovery | 95 % CI (% of true) |
|---|---|---|---|---|---|---|
| Intercept | 190.2703 | 4.7667 | 39.92 | 205.0 | 92.8 % | 88.3 – 97.4 |
| Age | 1.7579 | 0.0537 | 32.74 | 1.85 | 95.0 % | 89.3 – 100.7 |
| BMI | 3.3918 | 0.1556 | 21.80 | 3.50 | 96.9 % | 88.2 – 105.6 |
| Altitude | 0.036477 | 0.00093 | 39.15 | 0.038 | 96.0 % | 91.2 – 100.8 |
| Distance | 0.0047 | 0.00029 | 16.32 | 0.0050 | 94.0 % | 82.7 – 105.3 |
| Female | 13.8648 | 1.4272 | 9.71 | 15.0 | 92.4 % | 73.8 – 111.1 |

**Viva point.** Every estimate is 3–8 % below its true value, and the intercept's CI does not contain 100 %. This is expected. The generator multiplies each pace by (1 − improvement %), with improvement 0.5–4 % per session. That shrinks every term by roughly the mean improvement. It is a property of the synthetic data, not a fitting error.

**Suggested caption:** "Figure 20: Significance (|t|) and recovery of the true generator coefficients for the 5-feature OLS model (95 % confidence intervals)."

---

## A6 — Figure: NPI by age cohort

The figure is `analysis_output/evaluation_plots/12_npi_by_age_cohort.png`. It replaces **Fig 21** (the "FAILED" chart).

Data: the held-out test runners (40 runners, 240 sessions), from the runner-level split with seed 42.

| | F | p |
|---|---|---|
| Raw pace by age cohort | **44.17** | **< 0.0001** |
| NPI by age cohort | **0.10** | **0.961** |

**Correction.** The earlier corrections file said p = 0.962. The exact value is 0.96147, which rounds to **0.961**. THESIS_CORRECTIONS.md has been updated.

**Cohort note.** The generator only produces ages 18–62, so the "60–75" cohort actually holds ages 60–62 (n = 30). You could label it "60+".

**Suggested caption:** "Figure 21: Raw pace and NPI by age cohort for the held-out test runners. Raw pace differs significantly by age; NPI does not."

---

## A7 — NPI vs RII_perf correlation (thesis p. 58)

The output is in `figures.json`.

Method:
- RII_perf = the personal-best pace before the session ÷ the pace in the session.
- Sample: sessions 2–6 of each of the 40 held-out runners, 200 sessions in total.

| | Value |
|---|---|
| Pearson r | **0.501** (p < 0.0001) |
| Spearman ρ | **0.492** (p < 0.0001) |

**Thesis text.** "NPI and RII_perf were moderately positively correlated (Pearson r = 0.50, p < 0.001, n = 200 sessions). The two indices are related but not redundant: NPI compares a runner with the population model, while RII_perf compares a runner with their own personal best."

Also drop the "Nedo optical distance measuring wheel" claim on p. 58, unless that comparison was actually done.
