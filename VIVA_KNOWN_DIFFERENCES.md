# Known differences between the thesis and the implementation

**Thesis:** *A Privacy-Preserving P2P Edge-Consensus Framework for Fair Fitness Competition* (submitted 29 Oct 2026)
**Implementation:** tag `viva-v1.0` (master) plus the 16 Nov freeze fixes · **Viva:** 19 Nov 2026

The thesis text was fixed on 29 Oct, but the code and the measurements kept improving after that. Where the two disagree, **the code and the script outputs are the correct version**. Every number below comes from a script in the repo (`GhostTracker/scripts/`) and says where it was measured: laptop, emulator, phone or simulation.

---

## 1. Numbers in the thesis that are wrong (the code is right)

| Thesis says | Correct value | Where it comes from |
|---|---|---|
| σ = 22.50 s/km (NPI denominator) | **σ = 24.16 s/km** (residual standard error, n − k − 1) | `npi_model_coefficients.json`; this is the value the app uses |
| R² train 0.7480, test 0.7458, gap 0.0022 | **Train 0.7555, test 0.7248, gap 0.031** | `fit_npi_model.py`, runner-level 160/40 split, seed 42 |
| MAE 19.34, RMSE 24.16 (test) | **MAE 19.21, RMSE 23.61 s/km** (24.16 is σ, not the test RMSE) | same script |
| Appendix: R² 0.8399, F 1042.86 | **Full fit: R² 0.7507, adjusted 0.7496, F 718.9** | same script |
| Feature importance: Distance 32, Gender 25, BMI 21, Age 14, Altitude 8 | **Altitude 34, Age 27, BMI 18, Distance 14, Sex 7 %** (share of standardised β) | same script |
| ANOVA raw pace F 84.62; NPI F 0.13, p 0.942 | **Raw pace F 44.17, p < 0.0001; NPI F 0.10, p 0.961** (age cohorts, test runners) | `thesis_figures.py` |
| "Parity across age **and sex**" | Age parity holds. **Sex does not: NPI still differs, F 6.30, p 0.013.** | same; this is a limitation |
| Case study, Kasun: expected pace 254.45, NPI +0.42 | Eq. 4.1 gives **340.25** for his profile, so the case study numbers are inconsistent | worked by hand from Eq. 4.1 |
| UT-04: NPI +1.02 | **+0.95** with σ = 24.16 | `fairnessEngine.test.ts` |
| Table B.2 percentile tiers (e.g. "< −1.0 = bottom 2.5 %") | Normal-distribution values: **< −1.0 = bottom 15.9 %**, ≥ +2.0 = top 2.3 % | fixed in `npiCalculator.ts` |
| "Altitude = cumulative elevation gain" | **The route's altitude above sea level** (the model was trained on this) | generator and model inputs |
| Ghost checkpoints every 100 m (one place) | **Every 10 m** (FRS-06 and the code) | `ghostComparator.ts` |
| t_sync target 15 s (SO-5) | **10 s**, as everywhere else in the thesis | consistency fix |

**What to say:** "The coefficients in the thesis are correct. Some evaluation numbers came from an earlier run, before I switched to a runner-level split. I re-ran everything with seed 42. The corrected values are on this sheet, and the scripts reproduce them."

---

## 2. Results the thesis reports that were not measured

| Thesis claim | What was really measured | Status |
|---|---|---|
| Inference 0.04 ms | **≈ 89 ns per call** (laptop, Node.js, 300,000 calls); 5.6 µs on an emulator; **phones: OnePlus 7 1.05 µs, Samsung Galaxy A03s 4.87 µs** (mean per call from batches, Diagnostics, 17 Nov, plugged in over USB) | Measured. Well under the 0.04 ms (40 µs) target on all |
| WAL 1.12 ms vs rollback 14.80 ms (13.2×) | **0.055 ms vs ≈ 3.3 ms, ≈ 60×** (laptop); 7.5 vs 34.4 ms, 4.6× (emulator); **phones: OnePlus 7 1.99 vs 12.07 ms, 6.1×; Samsung A03s 5.90 vs 18.23 ms, 3.1×** (mean per insert, 1,000 rows, last of 3 runs, plugged in over USB) | Measured. WAL is faster everywhere, but by less than 13.2× on phones |
| 8 physical BLE nodes converge in 1.42–9.46 s | **Simulation** of the real gossip code: 8 nodes at 15 % loss, mean 2.56 rounds (≤ 6.4 s); at 30 % loss ≤ 12.1 s, **which misses the 10 s target**. Real Bluetooth sync works on 2 emulators and 2 phones (OnePlus 7, POCO X3 NFC). | Timed phone trials pending |
| Frame sizes 128 / 210 / 298 / 384 B, 353-byte payload | **171 B for one entry, + 88.8 B per extra entry**; 16-byte state hash. One 512-byte frame holds up to 4 entries; larger payloads are split into frames. | Measured from the real encoder |
| GPS field trials in 3 cities (0.37 / 0.50 / 0.64 % error) | Not done. One real 2 km two-phone test showed one phone 32 m ahead from GPS noise. That led to the Kalman pipeline (section 3). | One known-distance route pending |
| Battery < 6.8 %/h | Battery logger built (`BatteryLogger`); no 30-minute measurement yet | Pending |
| 60 FPS / < 16 ms rendering | Not measured | Future work |
| "0 bytes" to the WAN (Wireshark) | By design and by tests: **no coordinates in any sync, race or leaderboard message**. No packet capture was done. | Code inspection + unit tests |
| Bit-identical results on ARM64 vs x86 (1,000,000 evaluations) | **Confirmed:** laptop (x86_64) hash `1ca3436b7154fb59`, pinned in a test. **OnePlus 7 and Samsung A03s (ARM64) give the same hash: all 3,000,000 values bit-identical** (Diagnostics, 17 Nov) | Measured on 2 phones |
| Lab equipment: Ellisys analyzer, Monsoon monitor, Garmin 945, Nedo wheel, nRF52840 dongles; 6 handsets, 6 operators | Not used. Real equipment: development laptop, Android emulators, OnePlus 7, POCO X3 NFC, Samsung Galaxy A03s | — |

**What to say:** "Those values were the targets and the planned protocol. I didn't have the lab equipment. What I measured is labelled laptop, emulator, phone or simulation, and I don't mix them."

---

## 3. Deliberate design changes

| Thesis | Implementation | Why |
|---|---|---|
| Vector clocks for anti-entropy | **16-byte state hash → digest → delta**, with LWW timestamps for conflicts and a G-Counter (one counter per device, merged by max, much like a version vector) | Peers exchange 16 bytes per round when nothing changed; a full vector comparison is only needed when the hashes differ |
| GPS accuracy gate 50 m | **20 m**, plus a 3-fix warm-up, a Kalman filter and confirmed distance | Introduced after the real two-phone test drifted 32 m |
| Fixed 6-tab bar with a BLE Sync tab (Table A.1) | **5 tabs.** You connect from the Run screen ("Connect with a friend"); the sync log is a debug screen | Simpler flow for runners |
| Scores shown from the first run | NPI and RII shown **after 5 calibration runs** | A UI rule; the formulas are unchanged |
| Every run is scored | Runs **under 200 m** are kept in history as "too short": no pace, NPI or RII, and they don't count for the baseline, PB or leaderboard | Over a few metres the average pace is mostly standing time and GPS noise (120 m in 14 min would give NPI ≈ −281). The model was trained on 1–10 km routes |
| "Witness signatures" | **Witness records:** who relayed each entry. They are not cryptographic signatures | Signing is post-viva work (section 4) |

---

## 4. Described in the thesis but not implemented

| Thesis | Current state | Plan |
|---|---|---|
| "Encrypted local SQLite databases" | **Not encrypted.** Data is protected by the Android app sandbox | SQLCipher + key in the Android Keystore (first post-viva item) |
| Secure transport | Bluetooth link without app-level encryption; the Wi-Fi relay is plain `ws://` and only used for testing | Encryption and authenticated peers after the viva |
| Signed entries, anti-cheating, hardware attestation, zk-SNARK proofs | Not built | Future work (thesis Table 40) |
| Heart-rate and wearable inputs, multi-hop mesh, LoRaWAN | Not built | Future work |
| Real runner data | **Training data is synthetic** (200 runners × 6 sessions) | Collect real data; re-fit and re-test the model |

---

## 5. Built beyond the thesis (an extension, not a claim)

- A live race between two phones over Bluetooth: start, live gap, finish, results.
- Background run tracking with crash recovery.
- Full data export and a raw GPS log for field evidence.
- An offline built-in Sri Lanka map.
- A model comparison against 7 other methods. It is separate from the app and not part of the thesis. No method beat OLS on unseen runners, and OLS is also the fastest and smallest model. The data is synthetic.
