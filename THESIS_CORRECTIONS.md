# Thesis Correction & Development Checklist

**Thesis:** *A Privacy-Preserving P2P Edge-Consensus Framework for Fair Fitness Competition* (Vinujathesis draft 2.pdf)
**Checked against:** the code in this repository and the script outputs as of 28 Oct 2026
**Submission:** 30 Oct 2026 · **Viva:** 19 Nov 2026

**Page numbers.** "p. 83" means the printed page number at the bottom of the page. The PDF viewer page is the printed number + 13 (so p. 83 is PDF page 96). Front matter uses roman numerals.

---

## 0. Tags used in this file

| Tag | Meaning | When |
|---|---|---|
| **[EDIT]** | Change the text. The correct value is given. | Before 30 Oct |
| **[FIG]** | Redo or replace a diagram, screenshot or plot | Before 30 Oct (plots are ready) / screenshots after the app update |
| **[MEASURE]** | The thesis reports a result that was never measured. Either measure it or reword it as planned/simulated. | Decide before 30 Oct |
| **[DEV]** | The thesis describes code that doesn't exist yet. It will be built before the viva, so the text can stay. | Before 19 Nov |
| **[CONSIST]** | Two parts of the thesis contradict each other. Pick one version and use it everywhere. | Before 30 Oct |

---

## 1. Correct values to use (single source of truth)

These all come from re-running `GhostTracker/scripts/` (seed 42, runner-level 160/40 split).

| Quantity | Thesis now | **Correct value** | Source |
|---|---|---|---|
| Equation coefficients | 190.2703, 1.7579, 3.3918, 0.0365, 0.0047, 13.8648 | **Unchanged (correct)** | `npi_model_coefficients.json` |
| σ (NPI denominator) | 22.50 | **24.16** | residual SE, full fit |
| R² train | 0.7480 / 0.8423 | **0.7555** | evaluate split |
| R² test | 0.7458 / 0.8262 | **0.7248** | evaluate split |
| Generalisation gap | 0.0022 | **0.031** | 0.7555 − 0.7248 |
| MAE (test) | 19.34 | **19.21 s/km** | |
| RMSE (test) | 24.16 / 23.81 | **23.61 s/km** | |
| Full-data fit (used for the equation) | — | **R² 0.7507, adj. R² 0.7496, F 718.9, n = 1,200** | `npi_regression_report.txt` |
| Importance (RII, Eq. 3.14–3.15, training set) | Distance 32, Gender 25, BMI 21, Age 14, Altitude 8 | **Altitude 34%, Age 27%, BMI 18%, Distance 14%, Sex 7%** | standardised β share |
| ANOVA raw pace (age) | F = 84.62 | **F = 44.17, p < 0.0001** | `npi_fairness_anova.txt` |
| ANOVA NPI (age) | F = 0.13, p = 0.942 | **F = 0.10, p = 0.961** | |
| Levene NPI (age) | W = 0.41, p = 0.746 | **W = 1.05, p = 0.371** | |
| ANOVA NPI (sex) | not reported | **F = 6.30, p = 0.013 → differs (limitation)** | |

**Table 31 (SE, t, recovery), true generator values in brackets:**
Intercept [205.0] 190.2703, SE 4.7667, t 39.92, recovery 92.8% · Age [1.85] SE 0.0537, t 32.74, 95.0% · BMI [3.50] SE 0.1556, t 21.80, 96.9% · Altitude [0.038] SE 0.0009, t 39.15, 96.0% · Distance [0.005] SE 0.0003, t 16.32, 94.0% · Female [15.0] SE 1.4272, t 9.71, 92.4%.

**What the synthetic dataset really contains** (from `generate_npi_training_data.py`):
- Age Uniform-integer **18–62**, not 18–75.
- BMI is derived from Gaussian height and weight, giving a range of **15.2–37.3**. It is not Normal(24.2, 3.5) clamped.
- Altitude is **one of 10 fixed Sri Lankan locations (3–2,160 m)**, not Uniform(0, 2000).
- Distance is **one of {1, 1.5, 1.8, 2, 2.5, 3, 4, 5, 7, 10} km**, not Uniform(1–21.1 km).
- Sex is 50/50.
- Noise σ = 12.
- Per-session improvement is 0.5–4.0%.
- True intercept is **205.0**, not 190.0.

### Find-and-replace order in Word (order matters)
1. RMSE "24.16" → **23.61**. Do this one occurrence at a time, only where the sentence says RMSE: pp. iii, 43, 74, 93, 100, 110, 112. Table 31's "23.81" also becomes 23.61.
2. Every "22.50" → **24.16**.
3. "0.7458" → **0.7248**. "0.7480" → **0.7555**. "0.0022" → **0.031**. "19.34" → **19.21**.
4. "F = 0.13" → **F = 0.10**. "p = 0.942" → **p = 0.961**. "84.62" → **44.17**. "W = 0.41" → **W = 1.05**. "0.746" → **0.371**.

---

## 2. The five biggest problems (fix these first)

1. **[MEASURE] Results nobody measured.** The thesis reports these as done:
   - GPS field trials in 3 cities
   - 0.04 ms inference and 1.12 ms / 14.80 ms WAL vs rollback
   - an 8-node BLE testbed with 6 phones + 2 nRF52840 boards
   - battery drain 6.8%/h
   - Wireshark audit and 60 FPS
   - UAT with 6 operators
   - a Horton Plains trail run

   Unless you really did these and have the data, reword them (section 4 lists every location). This is the highest-risk item for the viva.
2. **[EDIT] Kasun vs Nimal is mathematically wrong** (pp. 87–88, 94). Using the thesis's own Equation 4.1, Kasun's NPI beats Nimal's, so the conclusion is reversed. A fix is given in section 3, Chapter 4.
3. **[CONSIST] Four different database schemas.**
   - Table 15 (p. 53) has six tables.
   - Table 24 (p. 72) has six tables with different columns.
   - Fig 13 ER diagram has different columns again, including `altitude_gain_m`.
   - Appendix C (p. 139) has *four* tables with different names.

   Pick Table 15. [DEV] will build it. Then align Table 24, Fig 13 and Appendix C to it.
4. **[CONSIST] Research questions and objectives are numbered differently** in Ch 1 (p. 5), Table 6 (p. 33), Table 35 (p. 98), Table 36 (p. 100) and the SO table (p. 112). Use the Ch 1 wording and order everywhere.
5. **[FIG] The regression plots are from the old 6-feature model.**
   - Fig 16 shows R² 0.8423 / 0.8262.
   - Fig 19 and Fig "190" show *Elev Gain 0.1433*.
   - Appendix A screenshots show "6 (incl. elevation gain)" and R² 0.8399.

   Replace them with the new plots in `GhostTracker/scripts/analysis_output/evaluation_plots/`.

---

## 3. Page-by-page list

### Front matter

| Page | Tag | Change |
|---|---|---|
| i | [EDIT] | "this Thesis2 does" → "this Thesis does" (stray superscript). |
| i–ii, title | [CONSIST] | Supervisor name is spelled three ways: "DVD", "DV Dharani", "DVDS". Use one. |
| ii | [EDIT] | "Mrs. MKP Madushanka & Mrs. DVDS Abeysinghe &, for her unwavering support … Her constructive…" → "my supervisors, Mrs. MKP Madushanka and Mrs. DVD Abeysinghe, for their unwavering support … Their constructive…" |
| iii | [EDIT] | Importance % → Altitude 34%, Age 27%, BMI 18%, Distance 14%, Sex 7%. Also NPI "/22.50" → "/24.16"; R²_test 0.7458 → 0.7248; MAE 19.34 → 19.21; RMSE 24.16 → 23.61; ANOVA F 0.13 / p 0.942 → F 0.10 / p 0.961; raw F 84.62 → 44.17. |
| iii | [EDIT] | "≤384-byte frames within the ≤512-byte BLE MTU" → "frames of at most 512 bytes (4-byte header), fitting the BLE MTU". |
| iii | [MEASURE] | From "Across physical field trials…" to the end of the paragraph: replace with *"GPS distance accuracy on the Colombo, Kandy Lake and Horton Plains routes is planned for field validation. In an eight-node simulated anti-entropy network with 30% packet loss, all replicas converged to an identical leaderboard, supporting offline fitness tracking and covariate-adjusted comparison."* If you run the latency benchmarks (section 5), add the measured numbers here. |
| iii | [DEV] | "six-table … SQLite": keep. Step 5 of the dev plan builds it. |
| iv–vii | [EDIT] | TOC: "4.1 -Introduction" → "4.1 Introduction". Chapter titles in the TOC (Ch 4 "Analysis and Results", Ch 5 "Result and Discussion") don't match 1.9.4 and 1.9.5. Make them the same. Update the TOC after all edits (right-click → Update Field). |
| viii | [EDIT] | List of Figures is missing Figure 19 and Figure 22 and has wrong numbers (see p. 88). Regenerate it after fixing captions. Add the Appendix figures (A.1–A.6, B.1). |
| ix | [EDIT] | List of Tables: add captions for the unnumbered tables on pp. 112, 114, 117, 119 (Table 41–44) and Appendix tables A.1, B.1, B.2, C.1, then update. |
| xii | [EDIT] | Appendix page numbers (129, 135, 137) don't match the TOC (131, 137, 139). Update. |

### Chapter 1

| Page | Tag | Change |
|---|---|---|
| 3 | [EDIT] | "T For these problems" → "For these problems". |
| 5 | [CONSIST] | RQ1–RQ4 here are the master list. Table 6 has RQ2 = spatial, RQ3 = sync, RQ4 = privacy. Table 35 has RQ3 = storage, RQ4 = P2P. Make both tables follow this page. Ch 1 has no spatial RQ but Tables 6 and 35 do. Either add "RQ (Spatial)" here or fold spatial into RQ3. |
| 6 | [EDIT] | Objective 3: "/22.50 (s/km)" → "/σ, where σ = 24.16 s/km is the residual standard error". |
| 6 | [CONSIST] | The 5 objectives here differ from Table 36 (p. 100) and the SO table (p. 112). Make the later tables use these five, word for word. |
| 6–7 | [CONSIST] | H0,1 talks about "variance". The test reported is ANOVA on means plus Levene on variance. Change to "mean NPI and variance". |
| 8 | [EDIT] | Table 2: reorder rows to Altitude 34%, Age 27%, BMI 18%, Distance 14%, Gender 7%. Coefficients unchanged. |
| 8 | [EDIT] | Eq 1.4 and the sentence below: 22.50 → 24.16. |
| 9 | [EDIT] | Scope, Environmental Telemetry: "elapsed path distance (kilometres)" → "(metres)". |
| 9–10 | [EDIT] | "direct native bridges" / "Native C++/Java/Swift modules" → "React Native (Expo development build) with native BLE and SQLite modules". "Pandas … Scikit-Learn for validation" → "NumPy and SciPy". The scripts don't use pandas or sklearn. |
| 10 | [EDIT] | 1.8.3 ranges: "Age (18 to 75)" → "18 to 62". "BMI (18.5 to 35.0)" → "derived from height and weight (≈15–37)". "Altitude (0 to 2,000 m)" → "one of ten Sri Lankan sites (3–2,160 m)". "Distance (1 to 21.1 km)" → "1–10 km". |
| 10–11 | [MEASURE] | "physical telemetry logs are collected from three … terrains": change to "are planned to be collected", or keep only if done. Table 3 last row: same. |
| 11 | [EDIT] | "divided into the five major chapters" → "six chapters". Add 1.9.6 for Chapter 6. Retitle 1.9.5 to match Ch 5. |
| 11 | [MEASURE] | 1.9.4 "real-world field tests in coastal, lake basin and high-altitude areas": reword the same way. |

### Chapter 2

| Page | Tag | Change |
|---|---|---|
| 16 | [EDIT] | Garbled sentence "This decrease in EPpO reduces the Pg across…" → "This decrease in ambient PO₂ reduces the partial-pressure gradient across…". |
| 19 | [EDIT] | "with battery power needed" → "with minimal battery cost". |
| 19 | [EDIT] | After Eq 2.7 the text explains s_xj and s_y but the formula is missing. Insert **β_j\* = β_j · s_xj / s_y** before "For xj, sxj means…". |
| 19 | [EDIT] | Naming clash: "RII" means *Relative Importance Index* here and *Relative Improvement Index* (RII_perf) on p. 20. Add one sentence: "To avoid confusion, feature importance is written RII and personal improvement RII_perf throughout." Check p. 46 (wrong expansion there). |
| 20 | [EDIT] | Eq 2.10 and the following line: 22.50 → 24.16 (twice). |
| 27 | [EDIT] | Table 4, EquiStride row, Topographical Adaptation: "Continuous Elevation + Altitude" → "Continuous Altitude". Elevation gain was removed from the model. |

### Chapter 3

| Page | Tag | Change |
|---|---|---|
| 33 | [EDIT] | "Levine's test" → "Levene's test". |
| 33 | [EDIT] | RQ3 method "Vector Clock Anti-Entropy Gossip" → "Digest-based Anti-Entropy Gossip (16-byte state hash + per-entry timestamps)". This is what `antiEntropy.ts` implements. |
| 33–34 | [MEASURE] | RQ4 validation "Empirical battery telemetry logging … packet capture audits": keep only if done before the viva (dev step 7). |
| 35 | [FIG] [DEV] | Fig 2 shows `olsInference.ts`, `npiCalculator.ts`, `riiEvaluator.ts` (they don't exist; the code has `riiEngine.ts`), "BLE Mesh Engine" (not built) and "6 Relational Tables" (not yet). **Keep the figure.** Dev steps 1, 4 and 5 create these files. |
| 36 | [DEV] | 3.3.1 list matches Fig 2. Same as above. `antiEntropy.ts` and `lwwElementSet.ts` now exist. |
| 37 | [FIG] | Fig 3 box 4 says "NPI = (P_exp − P_rolling)/22.50". Edit to 24.16 (or "/σ"). Box 5 "Vector_Clock" → "G-Counter state". |
| 38 | [EDIT] | Table 8 stage 5: "assemble state payload with vector clocks" → "with G-Counter state". |
| 38–39 | [MEASURE] | 3.4.1 last sentence and Table 9 right column: field trials, "calibrated measuring wheel", "Optical Wheel & Garmin Forerunner". Keep only if true; otherwise describe as the planned validation protocol. |
| 39 | [EDIT] | Eq 3.1 → Age ~ UniformInt(18, 62). Eq 3.2 → BMI = weight/height², with height ~ N(172, 8) / N(162, 7) cm and weight ~ N(75, 12) / N(60, 10) kg (male/female). Eq 3.3 → Altitude ∈ {3, 8, 12, 15, 45, 370, 510, 1041, 1868, 2160} m (ten sites, uniform choice). Eq 3.4 → Distance ∈ {1000, 1500, 1800, 2000, 2500, 3000, 4000, 5000, 7000, 10000} m. Eq 3.5 is correct. |
| 40 | [EDIT] | Eq 3.6: "190.0 + 1.85 …" → **"205.0 + 1.85 …"**. γ range is correct. |
| 40 | [MEASURE] | 3.4.3 field routes and devices (iPhone 13, Galaxy S21, Pixel 6, Garmin 945, optical wheel): keep only what you really own and used. |
| 41 | [EDIT] | "GroupShuffleSplit grouped by runner_id" → "a runner-level grouped split (random permutation of the 200 runner IDs, seed 42)". |
| 41 | [EDIT] | "Gaussian elimination with partial pivoting within … scripts/train_ols_model.py" → "NumPy matrix inversion (`np.linalg.inv`) within `scripts/fit_npi_model.py`". |
| 41 | [DEV] | "embedded … into src/core/fairness/olsInference.ts": dev step 4 creates it. |
| 42 | [EDIT] | After Eq 3.10 add: *"Held-out metrics are from the 160/40 runner split. After evaluation, the final coefficients were refit on all 1,200 sessions (R² = 0.7507, adjusted R² = 0.7496, F = 718.9)."* |
| 42 | [CONSIST] [MEASURE] | Table 10 says "< 0.01 ms". Everywhere else says 0.04 ms. Use the measured value (section 5) in both places. |
| 42–43 | [EDIT] | R² 0.7480 → 0.7555, 0.7458 → 0.7248, gap 0.0022 → 0.031, MAE → 19.21, RMSE → 23.61. "minimal generalization gap … confirms" → "small generalization gap (0.031) indicates limited overfitting". |
| 43 | [EDIT] | Eq 3.16 → Altitude 34%, Age 27%, BMI 18%, Distance 14%, Gender 7%. Rewrite the next sentence: *"Within the synthetic cohort, altitude and age contribute most to expected-pace variance, followed by BMI, distance and sex. This ranking reflects the programmed generator and the covariate ranges, not a clinical finding."* |
| 44 | [FIG] | Fig 4: "σ_res = 22.50 s/km" and "/22.50" → 24.16. "< 0.01 ms" → measured value. |
| 45 | [EDIT] | Table 11 NPI "/22.50" → 24.16. Text "(σresidual = 22.50 s/km)" → 24.16. Eq 3.17 → 24.16. |
| 46 | [EDIT] | "(22.50 s/km faster)" → 24.16. "Personal Relative Importance Index (RIIperf)" → "Relative Improvement Index (RII_perf)". |
| 46 | [DEV] | 3.6.1 1 Hz downsampling (drop fixes < 1,000 ms apart): not in `gpsFilter.ts` yet. Dev step 3. |
| 48 | [EDIT] | Eq 3.25: the text says "seconds per kilometre" but the unit shows [min/km]. Write P_rolling = (ΣΔt / Σd) × 1000 [s/km]. |
| 48 | [DEV] | 10-second window in `paceCalculator.ts`: dev step 3. |
| 49 | [FIG] | Fig 6 step 1 "16-Byte Vector Clock" → "16-Byte State Hash". Step 3 "Compare Vector Clocks" → "Compare Digest". |
| 49–50 | [DEV] | BLE dual role, GATT: dev step 2. |
| 50 | [EDIT] | Table 13 Phase 2: "Evaluates vector clock state differences / Periodic Vector Clock Exchange" → "Compares state hash and per-entry timestamps / Periodic digest exchange (t_gossip = 2.5 s)". |
| 51 | [EDIT] | After Eq 3.28 add: *"If timestamp and node ID are both equal, the canonical JSON of the value is compared, so every replica resolves the tie identically."* This is what the code does. |
| 51 | [EDIT] | 3.7.3 step 1 "16-byte state digest vector summarizing its local vector clock state" → "16-byte state hash (four FNV-1a seeds)". Step 3 "into a single 512-byte MTU frame" → "into one or more frames of at most 512 bytes (4-byte header for reassembly)". |
| 52 | [EDIT] or [DEV] | "stored in encrypted local SQLite databases". There is no encryption. Remove "encrypted", or say "protected by the OS app sandbox". (SQLCipher is not in the dev plan.) |
| 52 | [EDIT] | Table 14 right column: "Vector Clock State Vector" → "G-Counter state". "Current Rolling Pace & Total Distance" → "NPI, RII_perf, total time". That is what the payload carries. |
| 53 | [DEV] | PRAGMAs `temp_store = MEMORY` and `cache_size = -64000`: the app has `cache_size = 2000`. Dev step 5. |
| 53–54 | [DEV] | Table 15 six tables: app tables are currently `run_sessions`, `user_profile`, `telemetry_points`, `ghost_records`, `leaderboard`, `crdt_state`, `device_profile`, `leaderboard_witnesses`. Dev step 5 renames them to Table 15. **Keep Table 15 as the master schema.** |
| 54–55 | [MEASURE] | 3.9.1 hardware: 6 phones, Garmin 945, Nedo wheel, **Ellisys BLE analyzer, Monsoon power monitor** (very expensive lab equipment), nRF52840 dongles. Replace with the equipment you really used (your phones, Android Profiler, laptop). |
| 55 | — | Table 16 targets are fine. Targets are not results. |
| 56 | [CONSIST] | Age cohorts "18-30, 31-45, 46-60, 61-75" → **18-29, 30-44, 45-59, 60-75**. These are the ones actually tested. Note the oldest synthetic runner is 62. |
| 56–57 | [MEASURE] | Table 17 and 3.10.1: "Monsoon constant power supply … 10,000 trials … controlled environments (22°C) … checked through system logs". Keep only what you do. The 10,000-trial benchmark can be done (section 5). |
| 57 | [EDIT] | 3.10.2: R²_test 0.7458 → 0.7248. Field validation sentence: [MEASURE]. |
| 58 | [MEASURE] | 3.10.3: "compared with … Nedo optical distance measuring wheel" [MEASURE]. "NPI values were compared with … RII_perf through correlation analysis": not done. Either remove it or I add it to a script (easy, synthetic data). |
| 59 | [EDIT] | Summary "R² score of 0.7458" → "R²_test of 0.7248". |

### Chapter 4

| Page | Tag | Change |
|---|---|---|
| 60 | [MEASURE] | "physical multi-elevation GPS field trials … hybrid BLE mesh convergence": reword to match what you keep. |
| 61 | [EDIT] | Domain analysis item 2: "cumulative elevation gain, and session length" → "route altitude, and distance". Table 18 row 1: "elevation" → "altitude". |
| 62 | [EDIT] | FRS-04 "route elevation" → "route altitude". |
| 63 | [DEV] | FRS-06 (10 m ghost Δt), FRS-07 (6 tables), FRS-08 (BLE): dev steps 3, 5, 2. |
| 63–64 | [MEASURE] | Table 20 "Achieved" column is all unmeasured (0.04 ms, 1.12 ms, 1.42–9.46 s, 384 bytes, 0.64%, packet inspection). Change the column header to "Validation method" and describe the test. Or fill it with real numbers after section 5. NFR-04 frame size can be measured now (section 5). |
| 66 | [FIG] | Fig 8 is fine. |
| 67 | [FIG] | Fig 9 class diagram, RIIEngine: "SIGMA_RES = 22.50" → 24.16. `GPSFilter.MIN_INTERVAL_MS = 1000` → [DEV] step 3. |
| 68 | [CONSIST] | Table 22 lists `fairness/riiEngine.ts`. Ch 3 lists `olsInference.ts` / `npiCalculator.ts` / `riiEvaluator.ts`. **Dev step 4 builds all of them, with `riiEngine.ts` as the facade**, so both chapters become true. Add one line: "riiEngine.ts composes olsInference, npiCalculator and riiEvaluator". Row 6: "Renders Leaflet route maps" → "react-native-maps (Leaflet on web)". |
| 69 | [FIG] | Fig 10: "R² = 0.7458, MAE = 19.34", "σ = 22.50", "6 Indexed Tables (1.12 ms Write)". Edit numbers. Remove "1.12 ms" unless measured. |
| 70 | [MEASURE] | Table 23 step 4 "within 1.12 ms" and step 5 "(<= 384 bytes)": replace with measured values or "≤ 512-byte frames". |
| 71 | [FIG] [CONSIST] | Fig 13 ER: `sessions.altitude_gain_m (Cumulative Elevation Gain)` → remove. Make all columns match Table 15. |
| 72–73 | [CONSIST] | Table 24 columns differ from Table 15 (e.g. users gender vs is_female; leaderboards rolling_pace vs rii_perf, rank_position; p2p_peers PK peer_id vs peer_mac). Make them identical to Table 15. |
| 73 | [FIG] | Fig 14: "μ = 1.12 ms, p99 2.35 ms, 13.2x faster" → measured values or remove. |
| 73 | [EDIT] | 4.4.1 generator bullet is correct (σ 12, 0.5–4%). |
| 74 | [EDIT] | "Altitude is total cumulative elevation gain in meters" → **"Altitude is the route's mean altitude above sea level in metres."** |
| 74 | [EDIT] | Refinement paragraph: final values → R²_train 0.7555, R²_test 0.7248, RMSE 23.61, σ 24.16, β₀ 190.2703. "five orthogonal covariates" → "five covariates" (they are not orthogonal). |
| 74 | [EDIT] | 4.4.2 step 1 "route parameters (elevation, distance)" → "(altitude, distance)". Step 2: sigma 22.50 → 24.16. Eq 4.2 → 24.16. |
| 74 | [EDIT] | Eq 4.3 typo "RIIₚerf" → "RII_perf". |
| 75 | [DEV] | 4.4.3 step 1 "snapped to a strict 1Hz temporal grid … buffered": dev step 3. 4.4.3 numbering "1. 1." doubled. Remove the inner numbers. |
| 75 | [EDIT] | 4.4.4: add `lwwElementSet.ts` and `antiEntropy.ts` to the file list. "vector clocks are compared" → "state hashes and per-entry timestamps are compared". "packed into 384 bytes or less" → measured size (section 5) "and split into ≤ 512-byte frames when larger". |
| 75–76 | [EDIT] | 4.4.5 "divided into three main views" → "six tabs (Run, Home, History, Board, Sync, Profile); the three core screens are…". |
| 76 | [FIG] | Fig 15 rich picture has many old numbers: R² 0.7480 / 0.7458, MAE 19.34, σ 22.50, RII 32/25/21/14/8, NPI /22.50, Kasun +0.42 / RII 0.980, Nimal +1.38, 0.04 ms, 1.12 ms, ≤384 B, 1.42–9.46 s, Error ≤ 0.64%. **Redo this image** with the corrected values, or remove the numbers from it. |
| 77 | [EDIT] | 4.5.1 list is numbered 4, 5, 6, 7 → 1, 2, 3, 4. |
| 77 | [MEASURE] / [DEV] | White-box "IEEE 754 bit-level … ARM64 vs x86_64": not done. Black-box BVA values (49.9 / 50.0 / 50.1 m, 6.93 / 6.94 / 6.95 m/s): dev step 4 adds these exact tests. Non-functional "packet capture … 0 bytes": [MEASURE]. |
| 78–79 | [DEV] | Table 26 UT-01 to UT-05 must exist as real Jest tests with these exact inputs. Dev step 4 adds UT-01, UT-02, UT-03, UT-04 (`gCounter.test.ts` already covers UT-05). **[EDIT] UT-04 expected output: NPI = +0.95** (σ 24.16), not +1.02. |
| 79–80 | [DEV] / [MEASURE] | IT-01: dev (pipeline test). IT-02 "< 2.35 ms": [MEASURE]. IT-03 "128-384 bytes": measure now. IT-04: done (8-node simulated test). IT-05 "60 FPS": [MEASURE] or remove the number. |
| 80 | [MEASURE] | ST-03 (4 phones, airplane mode, 3.40 s), ST-04 (1,000,000 evals, bit-identical), ST-05 (battery 6.8%/h): change "PASS" to "Planned", or run them after BLE (dev step 7). ST-01/ST-02 are manual. Do them before the viva. |
| 81 | [MEASURE] | 4.5.2.4 and Table 29 (6 handsets, Colombo / Kandy / Nuwara Eliya, Horton Plains trail, 6 operators): keep only what you really do. |
| 82 | [DEV] / [MEASURE] | Table 30 Regression row "CI/CD on git push" → dev step 6. Performance row (0.04 ms, 1.12 ms, 13.2x, 9.46 s) → [MEASURE]. Security row "Wireshark … fuzzing" → [MEASURE] / dev (decoder already rejects bad versions; add an oversized-frame test). |
| 83 | [EDIT] | 4.5.4 first line: "trained … N_train = 960 … tested N_test = 240" is fine. Add "final coefficients refit on all 1,200 (R² 0.7507)". |
| 83 | [EDIT] | **Table 31:** use the values in section 1. Rename row "Altitude Gain" → "Altitude (m a.s.l.)". Goodness-of-fit: R²_train 0.7555, R²_test 0.7248, gap 0.031 (change "confirming strong generalization" to "small"), MAE 19.21, RMSE 23.61, σ 24.16. |
| 83 | [EDIT] | "Distance (32%), Gender (25%) … Elevation Gain (8%)" → "Altitude (34%), Age (27%), BMI (18%), Distance (14%), Sex (7%)". |
| 84–86 | [FIG] | Replace Fig 16 → `01_actual_vs_predicted.png`, Fig 17 → `03_residuals_vs_predicted.png`, Fig 18 → `08_qq_plot.png`, Fig 19 → `04_feature_importance.png` (from `scripts/analysis_output/evaluation_plots/`). The current Fig 16 and Fig 19 are the old model. |
| 86 | [EDIT] | Case Study 1: keep 397.97. NPI sentence → "NPI = (397.97 − 375.00) / 24.16 = **+0.95**". Delete the second "using RMSE" calculation. |
| 87 | [EDIT] | **Case Study 2.** Kasun's expected pace from Eq 4.1 is **340.25** (not 254.45). With the current paces his NPI is +3.94, so he *beats* Nimal. Fix by making Kasun a "22-year-old **recreational** male runner": PB **320.0 s/km (5:20)**, actual **326.5 s/km (5:26.5)**, Expected **340.25** → RII 0.980, NPI **+0.57**. Nimal: Expected **410.38** (not 411.05), NPI **+1.26** (RII 1.105 unchanged). Nimal still wins on RII and NPI; Kasun still wins raw pace. |
| 87 | [EDIT] | ANOVA bullets: raw F = 44.17, p < 0.0001. NPI F = 0.10, p = 0.961. Levene W = 1.05, p = 0.371. Add: *"For sex, mean NPI still differed (F = 6.30, p = 0.013), so sex parity is not established in this synthetic cohort (see Section 5.5)."* |
| 87 | [EDIT] | "In Figure 21 … Figure 22" → "Figure 20 … Figure 21" (match the real captions). |
| 87–88 | [EDIT] | Table 32: Raw pace "4:05 (245)" → "5:26.5 (326.5)". Interpretation "young elite runner" → "young runner". NPI "+0.42 (Exp: 254.45)" → "+0.57 (Exp: 340.25)". "+1.38 (Exp: 411.05)" → "+1.26 (Exp: 410.38)". Text "+1.38 sigma vs Kasun (+0.42 sigma)" → "+1.26 σ vs +0.57 σ". |
| 88 | [FIG] [EDIT] | Captions "Figure 190" and "Figure 201" → "Figure 20" and "Figure 21". Fig 20 is the same old 6-feature image as Fig 19. Replace it with a coefficient/t-statistic plot of the 5-feature model (I can generate it). Fig 21 shows "**FAILED**, spread 0.7437". The new `10_npi_fairness_proof.png` still says FAILED (0.6393). **Recommend replacing Fig 21 with an "NPI by age cohort" box plot**, which supports the ANOVA (I can generate it), or explaining the FAILED label in the text. |
| 89 | [MEASURE] | 4.5.6 and Table 33 (GPS field trial distances): **unmeasured**. Remove the table and write the validation as planned. Or, if you do one real route before the viva, report only that route. |
| 89–90 | [MEASURE] | 4.5.7 and Table 34: "2 to 8 physical mobile nodes": unmeasured. **Replace with a simulated benchmark** (section 5): convergence rounds × 2.5 s gossip interval for 2/4/6/8 nodes at 0/15/30% loss, plus real binary payload sizes. WAL 1.12 ms vs rollback 14.80 ms: replace with the measured laptop benchmark. |
| 90 | [EDIT] | "shown in Figure 4.3" → no such figure. Remove, or add the benchmark chart. |
| 90–91 | [EDIT] | 4.6 summary items 1–4: update numbers. Item 2 "below 0.64%": [MEASURE]. Item 3: measured values. Item 4 "8 physical nodes": "8 simulated nodes". |

### Chapter 5

| Page | Tag | Change |
|---|---|---|
| 92 | [MEASURE] | 5.1 "empirical verification data collected during Sri Lankan field testing": reword. |
| 93 | [EDIT] | R² train / test, gap "0.0022 (ΔR² = 0.22%)" → "0.031", MAE, RMSE, σ. "negligible" → "small". |
| 93 | [EDIT] | RII list 1–5 → reorder: 1 Altitude 34%, 2 Age 27%, 3 BMI 18%, 4 Distance 14%, 5 Sex 7%. Altitude item: "energetic cost of vertical ascent" → "reduced oxygen partial pressure (hypoxia) at altitude". |
| 94 | [EDIT] | "altitude coefficient … effects of vertical work" → "effects of hypoxia". |
| 94 | [CONSIST] | Two-Stage list says Stage 1 = RII_perf, Stage 2 = NPI. Ch 3 says Stage 1 = expected pace, Stage 2 = NPI + RII_perf. Use the Ch 3 definition. NPI "/22.50" → 24.16. |
| 94 | [EDIT] | Case studies: "+1.02 (+0.95 using RMSE)" → "+0.95". Kasun: PB 320 (5:20), current 326.5 (5:26.5), recreational, NPI +0.57. Nimal NPI +1.26. |
| 94 | [CONSIST] | ANOVA "Group 1 Young Male Elite; Group 2 Masters Male; Group 3 Senior Female" → "four age cohorts (18-29, 30-44, 45-59, 60-75)". F 84.62 → 44.17. F 0.13 / p 0.942 → 0.10 / 0.961. |
| 95–96 | [MEASURE] | 5.2.2 field results (Galle Face +4.20 → +0.37%, etc.): remove or reword. |
| 95 | [CONSIST] | Pipeline order here is accuracy → 1 Hz → velocity. Ch 3 says 1 Hz → accuracy → velocity. Use the Ch 3 order. |
| 96 | [CONSIST] | "ghostComparator … at 100-meter segment intervals" → **10-metre** checkpoints. "rendering delay below 16 ms (60 FPS)": [MEASURE]. |
| 96 | [EDIT] | 5.2.3 "cryptographic keys": none exist. Remove. |
| 96 | [MEASURE] | Write latency 1.12 / 14.80 / 13.2-fold, inference 0.04 ms, "< 1.20 ms per second … 98% frame budget": measured values or remove. |
| 97 | [EDIT] | "Network Packet Inspection (NPI)": acronym clash with your main metric. Write "network packet inspection" in full. |
| 97 | [EDIT] | "0 bytes of WAN data egress" is not true when the Wi-Fi relay server is used. Change to "**0 bytes of GPS coordinate data** leave the device; only scalar leaderboard fields are shared". This is now true in code after the privacy fix. |
| 97 | [EDIT] | "logical vector clocks and monotonic timestamps" → "per-entry timestamps (LWW) and a G-Counter". |
| 97–98 | [MEASURE] [CONSIST] | 5.2.4 "empirical field experiments … 2 to 8 physical devices". The numbers here (2-node 30% → 2.85 s; 8-node 0% → 4.18 s) **don't match Table 34**. Replace them all with the simulated benchmark. |
| 98–99 | [CONSIST] [EDIT] | Table 35: RQ titles must follow Ch 1. RQ1 "ANOVA across age/sex cohorts … confirming parity" → "age cohorts: F = 0.10, p = 0.961 (parity retained); sex: p = 0.013 (not retained)". Status "Fully Resolved" → "Resolved for age (synthetic); sex remains a limitation". RQ2/RQ3/RQ4 numbers per section 5. |
| 100 | [EDIT] | Table 36 module paths don't exist: "src/database/sqliteSchema.ts, src/database/dbAdapter.ts" → `GhostTracker/src/data/database/schema.ts`, `GhostTrackerApp/src/data/database.ts`. Objective 1 numbers. "statistical parity confirmed (p = 0.942)" → "age parity retained (p = 0.961)". |
| 101 | [MEASURE] | Objective 5 "field trials … 100% Achieved" → "Partially achieved / planned" unless done. |
| 101–102 | [EDIT] | Table 37 H1: raw F 44.17, NPI F 0.10, p 0.961, Levene W 1.05, p 0.371. H2: measured values. H3: "8-node hybrid BLE testbed (6 phones + 2 nRF52840)" → "8-node simulated network" (and real phones if done). |
| 103 | [EDIT] | Table 38 row 1: "Distance, Gender, BMI, Age, and Elevation (R² = 0.7458)" → "Altitude, Age, BMI, Distance and Sex (R²_test = 0.7248)". Rows 3–4: measured values / "≤ 512-byte frames". |
| 104 | [EDIT] | 5.4.1 item 1: RII order and %, R²_test 0.7248. Item 2: ANOVA F 0.10, p 0.961. 5.4.2 item 2: "128 to 384 bytes … 8 mobile nodes within 9.46 s" → simulated benchmark values. |
| 104–106 | [EDIT] | 5.5: **add a 5th limitation (row 5 in Table 39):** *"Sex parity not established: mean NPI differed between male and female synthetic runners (F = 6.30, p = 0.013). Model trained on synthetic data only; ages 18–62 and distances 1–10 km."* Also limitation 1 text "(3 km to 21.1 km)" → "(1–10 km in the training data)". |
| 108 | [EDIT] / [MEASURE] | 5.7: R² 0.7458 → 0.7248. ANOVA → 0.10 / 0.961. 1.12 ms, 9.46 s → measured / simulated. Last paragraph "field trials were carried out …" → reword. |

### Chapter 6

| Page | Tag | Change |
|---|---|---|
| 109 | [MEASURE] | 6.1 "field validation across different Sri Lankan topologies" → reword. |
| 110 | [EDIT] | 6.2.1: fix the broken sentence "For testing, for model training and testing, … filtering., and good". R², MAE, RMSE, σ. "population standard deviation of residuals" → "residual standard error". RII percentages/order. NPI "/22.50" → 24.16. |
| 110 | [CONSIST] | "ANOVA … grouped by sex, age brackets, and BMI categories" → only age passed. Sex failed (p = 0.013). BMI was not tested. Rewrite accordingly with F 0.10, p 0.961. |
| 110–111 | [MEASURE] | 6.2.2 field trial results (+0.37 / +0.50 / +0.64%): reword. |
| 111 | [EDIT] | 6.2.3 "zero-knowledge local-first architecture" → "local-first architecture with on-device storage". "Zero-knowledge" means a cryptographic proof, which you don't use. 1.12 ms, 0.04 ms, 60 FPS, 0 bytes WAN → measured values / "0 bytes of coordinates". |
| 111 | [MEASURE] | 6.2.4: 1.42 s, 9.46 s, "≤ 384 bytes" → simulated benchmark values. |
| 112 | [EDIT] [CONSIST] | Unnumbered SO table → caption "Table 41". SO-1 numbers. SO-2: [MEASURE]. SO-3: measured. SO-4 "≤ 384 bytes" → measured. SO-5 target "t_sync ≤ 15 s" **conflicts with 10 s** used everywhere else. Use 10 s. "Fully Fulfilled" → honest status. |
| 113 | [EDIT] | 6.3.1 "route elevation profile" → "route altitude". 6.3.2 "zero-knowledge trajectory architecture" → "local-only trajectory architecture". |
| 113–114 | [DEV] | 6.3.2 / 6.3.3 "cryptographically hashed user/node identifier": dev step 5 (SHA-256 of the device ID). "384 bytes or fewer" → measured. |
| 114, 117, 119 | [EDIT] | Unnumbered tables → captions Table 42, 43, 44. Add them to the List of Tables. |
| 116 | [EDIT] | 6.4.3 "(t_sync > 9.46 s)" → "(t_sync above the 10 s target)". |
| 120 | [EDIT] | 6.6 "Synchronized leaderboard updates are securely shared": BLE payloads are not encrypted. Write "privately shared (no coordinates)". |

### References (pp. 121–130)

| Tag | Change |
|---|---|
| [EDIT] | **Check that every DOI opens the paper with the same title.** `arXiv:1309.5812` (Ward & Barker, 2013) is really titled *"Undefined By Data: A Survey of Big Data Definitions"*, not "An empirical study of execution latency in edge machine learning applications". Fix or remove it. Also check that these exist exactly as cited: **Townshend & Mase (2021)**, **Inman & Vincent (2020)**, **Gordon et al. (2020a, 2020b)**, **Alvero-Cruz et al. (2020b)**, **Chapman et al. (2014b)**. Examiners do click DOIs. |
| [EDIT] | Kometa et al. (1994) and Aibinu & Jagboro (2002) describe the *questionnaire* Relative Importance Index from construction management. Your RII is a standardized-coefficient share. Cite them as "adapted from", or cite a regression source (e.g. Montgomery et al., 2012) for β\*. |

### Appendix A: User Interfaces (pp. 131–136)

| Page | Tag | Change |
|---|---|---|
| 131 | [EDIT] | Table A.1 Profile row: "6-Feature OLS Edge ML" → "5-Feature". Sync row: "353-byte state exchange" → measured binary size. |
| 132 | [EDIT] | Step 3: "R² = 0.8399, Adjusted R² = 0.8391, σ = 24.4 s/km, F = 1042.86" → **R² = 0.7507, Adj. 0.7496, σ = 24.16, F = 718.9** (what the app shows now). |
| 133 | [FIG] | **Retake Fig A.2b.** The current screenshot shows "6 (incl. elevation gain)". The app now shows 5 features and the new R². Retake Fig A.2a too if the predicted pace changed. |
| 133 | [EDIT] | A.3 Step 2: "velocity spike filtering (< 12.0 m/s ceiling)" → **"≤ 6.94 m/s (25 km/h)"**. That is the code value and Ch 3. |
| 134–135 | [FIG] [DEV] | Fig A.5 screenshots show the panel labelled "**BLE SIMULATOR (MOCK PEERS)**". The text describes real RSSI −62 dBm discovery. Either describe it honestly as the simulator, or **retake after dev step 2** with real BLE. "10-Stage CRDT Merge Logs" but 9 are listed → "9-stage". |
| 135–136 | [FIG] | Fig A.6 Board tab NPI values (Kasun +1.75, Tharindu +1.31) were computed with the old model/σ. Retake after the app update. Update the numbers in the Step 2 text. |

### Appendix B (pp. 137–138)

| Page | Tag | Change |
|---|---|---|
| 137 | [EDIT] | Title "Production Six-Feature OLS" → "Five-Feature". Text: "R² = 0.8399, Adjusted R² = 0.8391, F = 1042.86, σ = 24.412" → R² 0.7507, Adj. 0.7496, F 718.9, σ 24.16. |
| 137 | [EDIT] | Table B.1 interpretation column uses old coefficients: "+1.614 s/km per year" → +1.758. "+3.543" → +3.392. "+3.50 per 100 m" → +3.65. "+4.10 per km" → +4.70. "+12.85" → +13.86. σ row 22.50 → 24.16. Intercept "3:15.6 /km" → 190.27 s = 3:10.3 /km. |
| 137 | [EDIT] [DEV] | Table B.2 percentiles are wrong for a normal distribution: ≥ +2.0 → top 2.3%; +1.5–2.0 → top 6.7%; +1.0–1.5 → top 15.9%; 0–1.0 → top 50%; −1.0–0 → 15.9th–50th percentile; **< −1.0 → bottom 15.9%** (not "bottom 2.5%"). The app (`npiEngine.ts` `getNPIRating`) has the same mistake. I fix it in code during dev. |
| 138 | [DEV] | Fig B.1 (GATT, 512-byte chunking): framing exists (`splitIntoFrames` / `FrameAssembler`). GATT comes in dev step 2. "353-byte SyncPayload" → measured binary size. |

### Appendix C (p. 139)

| Tag | Change |
|---|---|
| [CONSIST] | "four normalized SQLite tables" (`user_profile`, `runs`, `crdt_leaderboard_state`, `ble_sync_audit_log`) contradicts the six tables in Ch 3/4. **Rewrite Table C.1 as the six Table-15 tables**, plus the SyncPayload row. |
| [EDIT] | "353-byte SyncPayload (BLE Wire JSON)" → "binary SyncPayload (protocol v2), split into ≤ 512-byte frames". Fields: deviceId, timestamp, G-Counter map, entries (id, alias, route, RII, NPI, total time, created/updated). |

---

## 4. Every unmeasured claim in one place ([MEASURE])

For each one, decide: **(a)** really measure it (section 5), **(b)** call it *simulated*, or **(c)** call it *planned / future work*.

| Claim | Pages | Recommended |
|---|---|---|
| GPS field trials, 3 cities (0.37 / 0.50 / 0.64%) | iii, 10–11, 38–40, 57–58, 64, 89, 95–96, 99, 100–101, 108, 110–112 | (c), or (a) with one real route before the viva |
| Inference latency 0.04 ms (and < 0.01 ms) | iii, 42, 44, 63, 82, 96, 102, 103, 111, 112, 115 | **(a) now, on the laptop** |
| WAL 1.12 ms / rollback 14.80 ms / 13.2× | iii, 64, 70, 73, 82, 90, 96, 99, 102, 103, 108, 111, 112 | **(a) now, on the laptop** |
| BLE 8 nodes, 6 phones + 2 nRF52840, 1.42–9.46 s | iii, 64, 82, 89–90, 97–99, 100, 102, 104, 108, 111–112 | **(b) simulated benchmark now**, real 2-phone test after dev step 2 |
| Frame sizes 128 / 210 / 298 / 384 B, 353 B | iii, 64, 70, 75, 79, 90, 97, 99, 103, 104, 111–114, 131, 135, 137–139 | **(a) now**: compute from the real encoder |
| Battery 6.8%/h | 80 | (c), or (a) after BLE |
| 60 FPS / < 16 ms render | 80, 96, 103, 111 | (c) or remove |
| 0 bytes WAN (Wireshark) | iii, 64, 77, 82, 97, 99, 100, 103, 111, 112 | reword to "0 bytes of coordinates" (true by code inspection) |
| Bit-identical ARM64 vs x86 (1,000,000 evals) | 77, 80 | (c), or (a) after the dev build |
| Lab equipment: Ellisys, Monsoon, Garmin 945, Nedo wheel, 22 °C lab | 39–40, 54–58 | remove unless you have them |
| UAT: 6 handsets, 6 operators, Horton Plains trail | 81 | keep only what you do |
| NPI vs RII_perf correlation analysis | 58 | (a) I can add it to a script |

---

## 5. What I can produce for you before the 30th (real numbers)

These run on your laptop or in simulation, so you can honestly report them as such:

1. **Inference latency benchmark**: 10,000 calls of the NPI function in Node.js → mean / p99.
2. **SQLite WAL vs rollback write benchmark**: 1,000 inserts each mode → mean / p99 / speed-up.
3. **Binary payload sizes**: real `encodeBinaryPayload` sizes for 1, 2, 4, 6 and 8 entries, and frame counts at 512 B.
4. **Simulated gossip convergence**: 2 / 4 / 6 / 8 nodes × 0 / 15 / 30% loss, 100 runs each → mean / p99 rounds × 2.5 s.
5. **New figures**: 5-feature coefficient/t-stat plot (replaces Fig 20) and an NPI-by-age-cohort box plot (replaces Fig 21).
6. **NPI vs RII_perf correlation** on the synthetic test set (for p. 58).

Report 1–2 as "measured on a development laptop". Phone numbers come after the dev build.

---

## 6. Development needed before the viva ([DEV] summary)

| Dev step | Makes these thesis parts true | Files |
|---|---|---|
| 1. Gossip wiring (2.5 s, hash → digest → delta, framed) | Ch 3.7.3, Table 13, Fig 6 | `GhostTrackerApp/src/screens/SyncTab.tsx`, `src/core/p2pSync.ts`, new `src/core/gossipSession.ts`, `relay-server.js` |
| 2. BLE transport (dual role, GATT, MTU) | Ch 2.7.1, 3.7.1, FRS-08, Fig 6, Fig B.1, App. A.4 screenshots | new `GhostTrackerApp/src/core/BluetoothSync.ts`, `app.json`, Expo dev build |
| 3. 1 Hz downsampling, 10 s pace window, 10 m ghost Δt | 3.6.1, 3.6.4, 4.4.3, FRS-06, Fig 9 | `GhostTracker/src/core/spatial/gpsFilter.ts`, `paceCalculator.ts`, `fairness/ghostComparator.ts`, app `RunContext.tsx` / `RunScreen.tsx` |
| 4. `olsInference.ts`, `npiCalculator.ts`, `riiEvaluator.ts` (+ `riiEngine.ts` facade); UT-01 to UT-04 and BVA tests; fix NPI percentiles | Fig 2, 3.3.1, 3.5.2, 3.5.5, Table 22, Table 26, App. B.2 | `GhostTracker/src/core/fairness/`, `__tests__/core/`, app `npiEngine.ts` |
| 5. Six-table schema (Table 15), PRAGMAs, hashed node IDs | 3.8.2, 3.8.3, Table 15/24, FRS-07, 6.3.2–6.3.3, App. C | `GhostTrackerApp/src/data/database.ts`, `GhostTracker/src/data/database/schema.ts` |
| 6. Git + CI + benchmark scripts | Table 30 regression row, section 5 numbers | `.github/workflows/test.yml`, `GhostTracker/scripts/benchmarks/` |
| 7. Phone measurements (you) | ST-03, ST-05, real BLE convergence | — |
| 8. Retake screenshots | App. A Figs A.2–A.6 | — |

---

## 7. Suggested order for the next 48 hours

1. Section 1 find-and-replace: 45 min.
2. Table 31, Case Studies 1–2, Table 32, ANOVA paragraphs: 1 h.
3. Generator equations 3.1–3.6, `cumulative elevation gain` wording, RII order everywhere: 45 min.
4. Decide on every [MEASURE] row in section 4 and reword: 2–3 h. **This is the most important block.**
5. Replace Figs 16–21 with the new plots, edit the numbers in Figs 3, 4, 9, 10, 15: 1–2 h.
6. [CONSIST] items: RQ/objective numbering, schema tables, cohort names, 10 m vs 100 m, Stage 1/2: 1 h.
7. Appendix B numbers, references check, captions, update TOC / List of Figures / List of Tables: 1 h.
