# EquiStride / Ghost-Tracker — Development Plan to the Viva

**Today:** 28 Oct 2026 · **Thesis due:** 30 Oct · **Viva:** 19 Nov 2026
**Goal:** by the viva, everything the thesis describes as *built* exists, is tested, and can be demonstrated. Every number shown at the viva is either measured or clearly labelled as simulated.

Companion file: [THESIS_CORRECTIONS.md](THESIS_CORRECTIONS.md) (what to change in the thesis text).

---

## Status overview

| Phase | What | Dates | Needs phones? | Status |
|---|---|---|---|---|
| 0 | Git snapshot | 28 Oct | No | ✅ Done (`5638847`) |
| 1 | Anti-entropy gossip over the Wi-Fi relay | 28 Oct | No | ✅ Done (`fc9e8a0`) |
| A | Real numbers and figures for the thesis | 29 Oct | No | ✅ |
| B | GPS pipeline: 1 Hz, 10 s pace window, 10 m ghost Δt | 31 Oct – 1 Nov | No | ✅ (29 Oct) |
| C | Bluetooth transport (dual role, GATT, frames) | 2 – 8 Nov | **Yes (2 Android)** | ⬜ |
| D | Fairness modules + the thesis unit tests | 9 – 10 Nov | No | ⬜ |
| E | Six-table database, PRAGMAs, hashed IDs | 11 – 12 Nov | No | ⬜ |
| F | CI pipeline + on-device benchmark screen | 13 Nov | No | ⬜ |
| G | Measurements on phones + new screenshots | 14 – 16 Nov | **Yes** | ⬜ |
| H | Code freeze, demo rehearsal, viva pack | 17 – 18 Nov | Yes | ⬜ |

**Why this order.**
- Phase A feeds the thesis due on the 30th.
- Phase B is quick and has no hardware dependency, so it gets done while the Bluetooth setup (dev build, phones) is prepared.
- Phase C is the biggest risk, so it gets the longest window, with 3 buffer days (D and E can shrink).
- D and E are low-risk and can be done in any order.
- G needs everything above.

**Rules for every phase**
- Work on a branch per phase, merge to `main` only when the done-criteria pass.
- Each phase ends with: core `tsc --noEmit` clean, all Jest tests green, Android bundle export OK, one commit.
- No phase changes the model coefficients or invents numbers.

---

## Phase A — Thesis numbers and figures (29 Oct)

Real values for the thesis sections that currently report unmeasured results.

| # | Task | Output | Replaces in thesis |
|---|---|---|---|
| A1 | Inference latency: 10,000 `predictExpectedPace` + NPI calls in Node.js, report mean / p50 / p99 | `GhostTracker/scripts/benchmarks/inference_latency.ts` → `benchmarks_output/inference.json` | 0.04 ms / < 0.01 ms (Table 10, NFR-01, 5.2.3, H2) |
| A2 | SQLite write latency, WAL vs rollback journal: 1,000 single-row inserts, same schema as `telemetry_points` | `scripts/benchmarks/sqlite_wal.py` → `wal.json` | 1.12 ms / 14.80 ms / 13.2× (Table 34, NFR-02, H2) |
| A3 | Binary payload sizes for 1, 2, 4, 6, 8, 20, 40 entries, and frame counts at 512 B | `scripts/benchmarks/payload_sizes.ts` → `payload.json` | 128/210/298/384 B, 353 B (NFR-04, IT-03, 4.4.4, App. B/C) |
| A4 | Simulated gossip convergence: 2/4/6/8 nodes × 0/15/30% loss × 100 seeds, using the real `GossipSession`; report rounds and seconds (rounds × 2.5 s), mean and p99 | `scripts/benchmarks/gossip_convergence.ts` → `gossip.json` + chart | Table 34, NFR-03, 5.2.4, H3 (labelled *simulated*) |
| A5 | Figure: 5-feature coefficients and \|t\| | `evaluation_plots/11_coefficients_tstats.png` | Fig 20 (old 6-feature image) |
| A6 | Figure: NPI by age cohort (box plot) with the ANOVA result in the title | `evaluation_plots/12_npi_by_age_cohort.png` | Fig 21 ("FAILED" chart) |
| A7 | NPI vs RII_perf correlation on the synthetic test runners | added to `fairness_anova.py` output | p. 58 "correlation analysis" |
| A8 | One summary file with every number and how it was produced | `GhostTracker/scripts/benchmarks_output/SUMMARY.md` | Copy-paste source for the thesis |

**Done when:** each script runs with one command, is seeded, and writes its JSON. SUMMARY.md lists the machine (CPU, OS, Node/Python versions) so you can write "measured on a development laptop".

---

## Phase B — GPS pipeline and live ghost (31 Oct – 1 Nov)

Makes thesis §3.6.1, §3.6.4, §4.4.3, FRS-03, FRS-06 and Fig 9 true.

**Problem today.** The app filters GPS with its own `algorithms.ts`, not the core `gpsFilter.ts`. Neither enforces 1 Hz. Pace is not a 10 s window. The ghost comparison is not per-10 m with ±Δt.

| # | Task | Files |
|---|---|---|
| B1 | Add a 1 Hz gate to the core filter: drop fixes < 1,000 ms after the last accepted fix (`MIN_INTERVAL_MS = GPS_SAMPLE_INTERVAL_MS`). Order: 1 Hz → accuracy ≤ 50 m → velocity ≤ 6.94 m/s, as in thesis Table 12. | `GhostTracker/src/core/spatial/gpsFilter.ts` |
| B2 | `RollingPaceWindow` class: keeps the last 10 s of accepted points, pace = ΣΔt / Σd × 1000 s/km, returns 0 when Σd = 0 (the thesis "idle sentinel") | `GhostTracker/src/core/spatial/paceCalculator.ts` |
| B3 | Ghost checkpoints: build a 10 m checkpoint table from the PB run (linear interpolation of time at each 10 m), `evaluateGhostDelta(distanceM, elapsedS)` → ±Δt seconds | `GhostTracker/src/core/fairness/ghostComparator.ts` |
| B4 | Switch the app to the core modules (same pattern as the CRDT adapter): RunContext uses `gpsFilter` + `RollingPaceWindow` + `ghostComparator`. Delete the duplicates in `algorithms.ts`. | `GhostTrackerApp/src/context/RunContext.tsx`, `src/core/algorithms.ts` |
| B5 | Show "+3.2 s ahead / −1.4 s behind" on the run screen, updated every 10 m | `GhostTrackerApp/src/screens/RunScreen.tsx` |
| B6 | Tests: UT-01 (r_acc 62.4 m rejected), UT-02 (9.20 m/s rejected), BVA 49.9/50.0/50.1 m and 6.93/6.94/6.95 m/s, 1 Hz gate (fixes at 0, 400, 1000, 1500, 2100 ms → 3 kept), rolling window (constant 5:00 pace → 300 s/km; standing still → 0), ghost Δt (same pace → 0 s; 10% faster → negative Δt growing linearly) | `GhostTracker/__tests__/core/gpsFilter.test.ts`, `paceCalculator.test.ts`, new `ghostComparator.test.ts` |
| B7 | Integration test IT-01: a recorded track with 20% injected spikes goes through filter → haversine → window with no NaN and the expected distance ± 1% | new `GhostTracker/__tests__/integration/spatialPipeline.test.ts`, input from `scripts/test_data/bellanwila_telemetry.json` |

**Done when:** all of B6–B7 pass. A simulated run in the web build shows a pace that changes smoothly and a ghost delta every 10 m.

**Result (29 Oct).** Done on branch `phase-b`.
- Core: `GpsFilter.sanitizeFix()` follows Table 12 (1 Hz → 50 m → 6.94 m/s, with speed measured between fixes). Added `RollingPaceWindow` (10 s window, idle sentinel 0), plus `buildGhostCheckpoints`, `interpolateCheckpoint`, `evaluateGhostDelta`, `ghostDistanceAtTime` and `GhostPacer`.
- App: `RunContext` uses the core pipeline. The ghost is now the saved PB run, replacing the fixed 6:00/km ghost, and the run screen shows "x.x s ahead/behind" at each 10 m mark. `algorithms.ts` now re-exports the core haversine, RII and pace functions, and its own copies of `isValidGPS`, `GCounter` and `distance3D` are deleted.
- Tests: 45 new tests (UT-01, UT-02, both BVA triples, the 1 Hz gate, the rolling window, the ghost Δt, and IT-01 with 20% noise, which keeps distance within 1%). The core suite now has 148 tests.
- Not done: the "simulated run in the web build" check. The app has no track-replay mode yet; it comes with the Phase H demo.
- Note: IT-01 uses a generated circle track with known length. `bellanwila_telemetry.json` is too noisy to use as ground truth: 35% of its 1-second steps exceed 6.94 m/s.

---

## Phase C — Bluetooth transport (2 – 8 Nov) ⚠️ highest risk

Makes thesis §2.7.1, §3.7.1, FRS-08, UC-05/06, Fig 6, Fig B.1 and ST-03 true. Reuses the `GossipSession` from Phase 1, so only the transport is new.

**Prerequisites (sort out before 2 Nov):**
- [ ] 2 Android phones (Android 8+; Bluetooth 5 preferred), USB cables, Developer Options + USB debugging on.
- [ ] Build route: **local** (Android Studio + JDK 17 + Android SDK on this laptop) **or EAS cloud build** (free Expo account). Local is faster to iterate; EAS needs no setup.
- [ ] Android only (iOS needs a Mac and an Apple developer account). Assumed unless you say otherwise.

**Technical approach.**
- **Central role** (scan, connect, write, subscribe): `react-native-ble-plx`. Mature, works with Expo dev builds via its config plugin.
- **Peripheral role** (advertise + GATT server): ble-plx can't do this. Plan: a small **local Expo module in Kotlin** (`modules/ble-peripheral`) wrapping Android's `BluetoothLeAdvertiser` + `BluetoothGattServer`. It has one service (`BLE_SERVICE_UUID`), one write characteristic and one notify characteristic, both already defined in `constants.ts`. About 200 lines of Kotlin.
- **Messages:** the same `GossipMessage` objects. Over BLE they are sent as bytes: a 1-byte kind tag + payload. Hash = 16 bytes. Frame = the existing ≤ 512-byte binary frame. Digest = compact binary. No base64 over BLE.
- **MTU:** request 517 → effective 512. If the phone negotiates less, `splitIntoFrames` is called with the negotiated size (already supported).

| # | Task | Files |
|---|---|---|
| C1 | Switch to an Expo development build. Add `react-native-ble-plx` + config plugin and Android permissions (`BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`, `BLUETOOTH_ADVERTISE`, location for Android ≤ 11). Make sure the app still runs. | `GhostTrackerApp/app.json`, `package.json` |
| C2 | Kotlin peripheral module: start/stop advertising with the service UUID + a short node tag, GATT server, `onWrite` → JS event, `notify(bytes)` | new `GhostTrackerApp/modules/ble-peripheral/` |
| C3 | `BluetoothSync.ts`: dual role. Advertise + scan, connect to peers found by service UUID (cap 7 links), negotiate MTU, deliver incoming messages to `GossipSession.receive`, send outgoing via write/notify, RSSI per peer, reconnect on drop | new `GhostTrackerApp/src/core/BluetoothSync.ts` |
| C4 | Binary codec for gossip messages over BLE (kind tag + fields), with round-trip tests | `GhostTracker/src/core/crdt/gossipCodec.ts` + test |
| C5 | Sync tab: transport selector **Bluetooth / Wi-Fi relay**. Peer list shows name, RSSI and status. The BLE simulator buttons are relabelled "Demo data". | `GhostTrackerApp/src/screens/SyncTab.tsx` |
| C6 | Record what the thesis needs: per-sync log of bytes, frames, MTU, RSSI and time from first mismatch to in-sync (t_sync) | `BluetoothSync.ts` → local log table |
| C7 | Test on 2 phones in airplane mode (Bluetooth on): add a run on phone A, it appears on phone B; measure t_sync 20 times | — |

**Fallback if the GATT server can't be made reliable by 6 Nov:** keep Bluetooth for *discovery* (advertise/scan shows nearby runners with RSSI) and run gossip over the Wi-Fi relay or a phone hotspot. Write the thesis accordingly. The protocol and tests are unaffected because the transport is pluggable.

**Done when:** C7 works repeatably with 2 phones, codec tests pass, and the Wi-Fi relay still works.

**Emulator status (3 Nov, two emulators with virtual Bluetooth — emulator numbers, not phone):** discovery, MTU 517 links, gossip convergence and run transfer all work. Fixed on the way: Bluetooth stopped on tab switch; endless gossip when only the G-Counter differed; a G-Counter increment lost to a concurrent merge save; 0 m runs becoming PB/leaderboard; renames not reaching the leaderboard; database lost on dev live reload.

**C8 — Consent (added 3 Nov at the user's request).** Links still form automatically so phones exchange names (`hello`), but leaderboard gossip flows only after an **invite** is **accepted** (or both invite each other). Run screen has a **Connect with a friend** button (visible while Bluetooth is on) with a nearby-runners sheet; invitations pop up as Accept / Decline on any screen. Pairing lasts while the link is up. Files: `BluetoothSync.ts` (control messages, marker byte 0xC0 + JSON), `context/BluetoothContext.tsx`, `components/FriendConnect.tsx`. Thesis §3.7.1 should mention the invitation step.

---

## Phase C+ — Connected race over Bluetooth (6 – 8 Nov)

Requested 3 Nov. Built after the Bluetooth merge (5 Nov) and before Phase D, so D–G move ~2 days later and use the 11 Nov and 16 Nov buffers. Builds on the C8 pairing; race messages travel on the same control channel. This feature is not in the thesis: present it as an extension at the viva.

**Decisions:** the inviter picks the target distance (1 / 2 / 3 / 5 km, default 1 km) and the friend sees it before starting. "Did not finish" after **15 min per km** from that runner's own start. Connected-run colour **purple** (`#BF5AF2`) with a 🔗 symbol; on the live map **you = blue, friend = orange**.

| # | Task |
|---|---|
| R1 | Race protocol on the control channel: `race-setup` (distance), `start`, `pos` (1 Hz: lat, lon, distance, elapsed, pace), `finish` (final time), `cancel`; per-runner status Not started / Running / Finished / DNF / Reconnecting |
| R2 | Start alert: local notification (`expo-notifications`, needs one native rebuild) plus an in-app banner "<name> has started the run 🏃" |
| R3 | Live race view: own and friend's pins (blue / orange), friend's stats card, "Waiting to start" until they start, ahead/behind by distance ("You're 120 m ahead") and by time at equal distance ("Jayavi is 0:15 ahead"); works whichever runner starts first |
| R4 | Finish at the target distance; DNF timer; results screen (winner, both times, both average paces, time difference) |
| R5 | Race results table + leaderboard section: wins/losses, best race time, connected-run count; cancelled races are not counted |
| R6 | Visual identity: purple card/route/badges and 🔗 on run cards, history, leaderboard and notifications |
| R7 | Edge cases: on link loss keep tracking locally, show "Reconnecting…" to the friend, resend the latest state and finish on reconnect; cancel notifies the friend and drops the race from the leaderboard |
| R8 | Tests: race-state reducer (start order, lead/gap maths, finish, DNF, cancel) with Jest; two-emulator demo with the fake-run script on both |

**Done when:** a two-emulator race with fake GPS on both runs end to end (start alert → live gap → finish → results → leaderboard), and cancel / DNF / reconnect each behave as specified.

---

## Phase D — Fairness modules and the thesis unit tests (9 – 10 Nov)

Makes Fig 2, §3.3.1, §3.5.2, §3.5.5, Table 22, Table 26 and Appendix B.2 true. The app and the core use one implementation.

| # | Task | Files |
|---|---|---|
| D1 | `olsInference.ts`: coefficients from `npi_model_coefficients.json` (single source), `predictExpectedPace(profile, route)` | new `GhostTracker/src/core/fairness/olsInference.ts` |
| D2 | `npiCalculator.ts`: NPI = (expected − actual) / σ, rating tiers with **correct** normal percentiles (≥2: top 2.3%, ≥1.5: 6.7%, ≥1: 15.9%, ≥0: 50%, ≥−1: 15.9–50th, < −1: bottom 15.9%) | new `.../fairness/npiCalculator.ts` |
| D3 | `riiEvaluator.ts`: RII_perf = PB pace / current pace (moved out of `riiEngine.ts`) | new `.../fairness/riiEvaluator.ts` |
| D4 | `riiEngine.ts` becomes the facade composing D1–D3, so the Ch 4/5 file names stay true | `.../fairness/riiEngine.ts` |
| D5 | App `npiEngine.ts` becomes a thin re-export of the core modules (no second copy of the coefficients) | `GhostTrackerApp/src/core/npiEngine.ts` |
| D6 | Tests: **UT-04** (age 40, BMI 24, F, 510 m, 5,000 m, 375 s/km → expected 397.97, NPI +0.95). Kasun/Nimal case (340.25 / +0.57; 410.38 / +1.26). Percentile tiers. Coefficients match the JSON file. | new `__tests__/core/npiCalculator.test.ts`, `olsInference.test.ts` |
| D7 | UT-03 check: haversine over a known 1,000.0 m baseline within 0.01% | `__tests__/core/haversine.test.ts` |

**Done when:** the thesis Table 26 rows UT-01…UT-05 each map to a named, passing test (UT-01/02 from Phase B, UT-05 = existing G-Counter tests).

**Status (3 Nov) ✅ code done.** `olsInference.ts`, `npiCalculator.ts`, `riiEvaluator.ts`, `riiEngine.ts` (facade + `evaluateRun`). Coefficients come from one file (`src/core/fairness/model/npi_model_coefficients.json`, test-checked identical to the training output); the app's `npiEngine.ts` is a re-export. Percentile labels corrected. `__tests__/core/fairnessEngine.test.ts` (18 tests); core 200/200.

**Thesis corrections found while checking every printed number against the trained model** (the code uses the model; the text should change):

| Where | Thesis says | Model / measurement gives | Suggested fix |
|---|---|---|---|
| Table 26 UT-03 | haversine 1,000.02 m, error < 0.01% vs WGS84 | Against an exact WGS84 1,000 m geodesic (Colombo): 998.83–1,005.47 m, −0.12% to +0.55% | "within 0.6% of a WGS84 geodesic (spherical-earth model); exact on the 6,371 km sphere" |
| σ everywhere (Eq 1.4, 2.10, 4.2, Table B.1) | σ = 22.50 s/km (also 24.412 in App. B) | Trained model file: σ = 24.158 (residual standard error, the value the app uses) | Use σ = 24.16 throughout; then UT-04 NPI = +0.95 (the thesis already gives this as the RMSE variant) |
| Table 26 UT-04 | Expected 397.97, NPI +1.02 | 397.96 with the stored coefficient 0.036477 (397.97 only with it rounded to 0.0365); NPI +0.95 with σ 24.158 | 397.96 s/km, NPI +0.95 |
| Table 32 / §4.5.5 / Ch 6 Kasun | Expected 254.45, NPI +0.42 | Expected 340.24, NPI +3.94 | Recompute; **with the model's numbers Kasun leads on NPI**, Nimal still wins on RII (1.105 vs 0.980). Rewrite the conclusion or choose new case-study inputs |
| Table 32 Nimal | Expected 411.05, NPI +1.38 | Expected 410.37, NPI +1.26 | Recompute |
| Model quality (§4.4, App. B) | R² 0.7480 / test 0.7458; elsewhere R² 0.8399 | Model file: R² 0.7507, adj 0.7496, test 0.7248, F 718.9 | Use the model file's figures |
| Table B.1 interpretations | "+1.614 s/km per year", "+3.543 per BMI", "+12.85 female", "+4.10 per km" | Coefficients are 1.7579, 3.3918, 13.8648, 4.70 per km | Match the coefficients |
| Table B.2 percentiles | Top 2.5% / 7.0% / 16.0%; NPI < −1 "bottom 2.5%" | Normal tails: 2.3% / 6.7% / 15.9%; NPI < −1 is the bottom 15.9% | Use the corrected labels (as the app now shows) |

---

## Phase E — Database to match the thesis (11 – 12 Nov)

Makes Table 15, §3.8.2, FRS-07, Fig 13 and §6.3.2–6.3.3 true.

| # | Task | Files |
|---|---|---|
| E1 | New schema = thesis Table 15 exactly: `users`, `sessions`, `gps_points`, `crdt_nodes`, `leaderboards`, `p2p_peers`, with the listed columns and indexes | `GhostTrackerApp/src/data/database.ts`, `GhostTracker/src/data/database/schema.ts` |
| E2 | One-time migration: copy `user_profile` → `users`, `run_sessions` → `sessions`, `telemetry_points` → `gps_points`, `leaderboard` → `leaderboards`, `crdt_state` → `crdt_nodes`. Inside a transaction; old tables are dropped only after row counts match. Ghost records and witnesses become columns or a side table as needed (document it). | `database.ts` |
| E3 | PRAGMAs: `journal_mode = WAL`, `synchronous = NORMAL`, `temp_store = MEMORY`, `cache_size = -64000` | `database.ts` |
| E4 | Hashed node IDs: the ID shared with peers is SHA-256(device UUID + app salt), first 16 hex chars (`expo-crypto`). The raw device UUID never leaves the phone. | `ProfileContext.tsx`, `sync.ts`, `BluetoothSync.ts` |
| E5 | `p2p_peers` filled by the Bluetooth transport (MAC/peer ID, RSSI, MTU, status) | `BluetoothSync.ts` |
| E6 | Tests: migration on a database with sample rows (counts equal, data intact), PRAGMA values read back | `GhostTrackerApp/src/data/database.test.ts` |

**Done when:** a phone with old data upgrades without losing runs, and the Sync tab still converges.

**Risk:** a migration bug can lose data, so back up the database file first (E2 copies before dropping).

**Status (3 Nov) ✅ done.** Schema + migration in core `src/data/database/thesisSchema.ts` (works on any SQLite via a small interface); the app's `database.ts` keeps its function names and row shapes through column aliases. Table 15 columns and indexes are present; extra columns the app needs are kept after them (documented in the file). Migration: one transaction, row counts checked, old tables dropped only on success, full rollback on any error (tested by fault injection). Node IDs = SHA-256(device ID + salt)[0..16), pure-TS SHA-256 checked against NIST vectors; every stored device/peer ID is remapped with the same function, so phones that upgrade keep recognising each other. PRAGMAs read back in tests (WAL, NORMAL, MEMORY, −64000, foreign keys ON). `p2p_peers` filled by the Bluetooth layer (status change or every 10 s). Tests: `__tests__/data/thesisSchema.test.ts` (10 + 1 opt-in for real database copies) and `sha256.test.ts` (5), run on real SQLite (node:sqlite). Migrated both emulator databases (copies first, then on device): every row kept, IDs consistent across the two phones.

Not matched (for the viva sheet): thesis Table 24 and Appendix C describe different column sets / a four-table layout; the code follows Table 15.

---

## Phase F — CI pipeline and on-device benchmarks (13 Nov)

Makes Table 30 (regression testing on push) true and prepares Phase G.

| # | Task | Files |
|---|---|---|
| F1 | Push the repository to a **private** GitHub repo (your account) | — |
| F2 | GitHub Actions: on every push run core `tsc`, core Jest, app sync tests, Python scripts smoke run, Android bundle export | `.github/workflows/ci.yml` |
| F3 | Hidden "Diagnostics" screen in the app (long-press the version label): runs 10,000 NPI inferences and 1,000 WAL inserts on the phone and shows mean/p99. This gives real *phone* numbers. | `GhostTrackerApp/src/screens/DiagnosticsScreen.tsx` |
| F4 | Battery log: records battery % every minute during a run (`expo-battery`) into a local table, exportable as CSV | `RunContext.tsx` |

**Status (3 Nov) ✅ built.**
- F1: code is on GitHub (`VinujaJayasundara/FYPfinal`). Check in the GitHub settings that the repo is private.
- F2: `.github/workflows/ci.yml` runs on every push in three jobs:
  - core: `tsc` and Jest
  - app: `tsc`, the sync tests (`GhostTrackerApp/jest.sync.config.js`) and an Android JS bundle export
  - Python: byte-compiles the scripts, checks that the app's model JSON matches `analysis_output`, and runs the WAL benchmark, uploaded as a runner artifact (not phone numbers)
  - The app type errors were fixed so the app job starts green: `absoluteFillObject` → `absoluteFill`, plus dead code in the App.tsx header.
- F3: long-press **GHOST TRACKER** in the header to open Diagnostics (`src/screens/DiagnosticsScreen.tsx`). The benchmark logic lives in core `src/core/diagnostics/benchmarks.ts` and uses the same inputs as the laptop scripts.
  - Inference: 10,000 calls, timed both as batches and per call, with the cost of reading the clock shown separately.
  - SQLite: 1,000 single-row inserts, WAL + NORMAL compared with rollback + FULL, in a scratch database that is deleted afterwards.
  - Every result is labelled phone or emulator and can be shared as JSON.
  - First emulator check (emulator-5554, x86_64, **not a phone**): 5.6 µs per inference; WAL 7.5 ms mean against rollback 34.4 ms (4.6×). Phase G still needs these numbers from a real phone.
- F4: `battery_log` table, filled by `BatteryLogger` (start of the run, every 60 s, end of the run), with the Bluetooth state recorded on each sample. Diagnostics shows drain in %/h for each run (only for runs of 10 minutes or more, and runs that were charging are flagged) and exports CSV.
  - `expo-battery` needs a new APK; on older builds the battery log is skipped and nothing else is affected.
- Tests: `diagnosticsBenchmarks.test.ts` (6, using real SQLite files) and `batteryLog.test.ts` (4). Core: 226 passed.

---

## Phase F+ — Profile and maps (3 Nov)

- **Profile:** the details form now has labelled fields with units, inline range errors, Next moves between fields, Male/Female is a two-button switch, and Save is offered only when something changed. A profile picture can be added from the gallery or the camera (expo-image-picker, cropped square). It is stored in app documents (`users.avatar_uri`, schema v3), shown in the header badge, and never sent over Bluetooth.
- **Maps:** Google Maps (react-native-maps) is replaced by **MapLibre + OpenFreeMap**, which needs no API key, account or card. The old map was blank even on a real phone because the key was only a placeholder.
  - "Offline map" chip on the Run screen: downloads about 10 × 10 km around the runner (zoom 10–14 vector tiles; MapLibre draws closer zooms from them), so the map works in airplane mode.
  - Builds without MapLibre show a placeholder instead of crashing (`RunMap.native.tsx` checks for the native module).
  - Attribution: © OpenStreetMap contributors, via the attribution button on the map.
- **Needs a new build** (native modules: MapLibre, image picker, battery). The build needs about 10 GB free on C:.
- **For the viva sheet:** if the thesis names Google Maps / react-native-maps, the implementation now uses MapLibre with OpenFreeMap tiles. Reasons: offline-first, no location requests to Google, no billing.

---

## Full emulator test (4 Nov)

Tested on two emulators (not phones):
- connect, decline and accept
- 1 km race (3:48 vs 4:41; both phones agree)
- board sync, ghost, the map while running and when finished
- offline map in airplane mode (5.2 MB)
- profile photo
- battery log, Diagnostics
- data kept after restart

Seven bugs fixed (commit bb19a3e):
1. A finished race was set up again by late snapshots.
2. The finished screen's RII used a hard-coded 6:00/km PB.
3. A run's NPI was never saved.
4. The leaderboard kept the best RII instead of the best NPI.
5. An unsaved profile could not be saved.
6. The idle screen slid under the OFFLINE/SYNC chips.
7. Overlays sat under the tab bar while running.

**Privacy (NFR-06):** race snapshots no longer contain coordinates. Only status, start time, elapsed time, distance, pace and finish time are sent, and there is no friend pin on the map. Coordinates in packets from older builds are dropped. Tests check that the sent snapshot has no coordinate fields. Leaderboard sync and the control messages contain no coordinates either.

---

## UX round (4 Nov): 5-run baseline, history, demo removal

- **5-run baseline:** scores (NPI, RII, vs-baseline) are shown from the 5th valid run; runs 1–4 show "Baseline: N of 5". The thesis formulas are unchanged (NPI against the model's expected pace; RII against PB). The extra personal number is pace vs the baseline (mean pace of the first 5 runs). Your own leaderboard entry is shared only once calibrated.
- **History:** every run, newest first, with a route map (start/finish markers). Peer runs (paired friend or connected race) are shown in purple, solo runs in green, everywhere. Filters: all / solo / with a friend, date range, one friend.
- **Board:** shows me plus real friends I have synced with (in p2p_peers), kept when they are out of range. Demo leaderboard removed; old demo entries are deleted from the database on start.
- **Demo data:** removed from the UI; the Sync demo buttons and the old Wi-Fi relay chip are behind dev-only flags (off).
- **Sync tab hidden:** it stays mounted for the gossip session; the sync log opens from Diagnostics (long-press the title).
- **Running screen:** the map is always visible (split layout), with large TIME / KM / PACE and a compact race strip.
- **For the viva sheet:**
  1. The thesis Table A.1 lists a fixed 6-tab bar including BLE Sync. The app has 5 tabs; connecting is done from the Run screen ("Connect with a friend") and the sync log is a hidden debug screen.
  2. Scores are shown after 5 calibration runs (a UI rule; the formulas are as in the thesis).

---

## GPS consistency (5 Nov) — from the first real two-phone race

**Real test:** OnePlus 7 and POCO X3 NFC in one hand, 2 km race. The POCO drifted and showed itself 32 m ahead. Cause: distance was the sum of raw fix-to-fix steps, and a noisier GPS zig-zags, which adds length.

**Fix:** `core/spatial/trackProcessor.ts`:
- 1 Hz gate.
- Accuracy ≤ 20 m (configurable; the thesis bound is 50 m).
- Velocity clamp of 6.94 m/s, measured from the predicted position and allowing for accuracy.
- 3-fix warm-up.
- Constant-velocity Kalman filter weighted by accuracy.
- Distance = filtered speed × time, confirmed by real steps, with a 15 s restart correction after stops; standing still adds nothing.
- The route, the map marker, the ghost and the race gap all use the filtered values.
- A debug raw GPS log (`gps_raw_log`) is saved with every run; Diagnostics → RAW GPS → Share last run (CSV).

**Simulated (seeded, not real) two-phone results over 2 km**, clean ±2 m vs noisy ±7 m phone:
- Steady: gap ≤ 15 m.
- Stop-and-go: gap ≤ 18 m.
- Tight 400 m track, 5 laps: gap ≤ 54 m (worst case).
- Raw sums: > 100 m apart.
- Standing still for 5 min: < 20 m with harsh noise (raw sum > 1 km).

**For the viva sheet:** the pipeline extends thesis Table 12 (accuracy 20 m instead of 50 m; warm-up, Kalman smoothing and confirmed distance are added). This is motivated by the field test above, and real phone results replace the simulated ones once re-tested.

---

## Phase G — Measurements and screenshots (14 – 16 Nov) — mainly you

| # | Measurement | How | Replaces |
|---|---|---|---|
| G1 | On-phone inference and WAL latency | Diagnostics screen (F3), each phone, 3 repeats | NFR-01/02, H2 |
| G2 | Bluetooth t_sync, 2 phones (3 if available), 20 trials | C6 log | ST-03, Table 34 (real rows next to the simulated ones) |
| G3 | One GPS route vs known distance (e.g. a 400 m track, or a route measured on a map) | run the app, compare distance | Table 33 with **one honest row** |
| G4 | Battery drain over a 30-min run with Bluetooth on | F4 | ST-05 |
| G5 | Coordinate privacy check: inspect the relay log / BLE payloads and confirm no lat/lon | relay console + frame decoder | NFR-06 ("0 bytes of coordinates") |
| G6 | Retake screenshots: Profile (5-feature model), Run with ghost Δt, Sync with Bluetooth peers, Board | phones | Appendix A figures |

---

## Phase H — Freeze and viva preparation (17 – 18 Nov)

- **17 Nov:** code freeze. Bug fixes only. Tag `viva-v1.0`. Full test run + build.
- **Demo script (5–7 min):**
  1. Profile → expected pace and the model card.
  2. Short run (or replay a recorded track) → live pace, ghost Δt, NPI.
  3. Two phones in airplane mode → Bluetooth discovery → leaderboards converge.
  4. Board → NPI ranking vs raw pace.
  5. Laptop: `npx jest` (all green) and the CI page.
- **Viva pack (I prepare):**
  - architecture walk-through
  - 25 likely examiner questions with answers
  - a one-page "known differences between thesis and implementation" list with reasons (e.g. synthetic data, sex parity, simulated vs real convergence)
- **Backup:** demo video recorded on 17 Nov in case Bluetooth fails on the day. Relay fallback ready.

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Android GATT server unreliable from RN | Medium | High | Kotlin module kept small; fallback = BLE discovery + relay (Phase C fallback). Decide by 6 Nov. |
| Dev build setup takes days | Medium | Medium | Start the toolchain or EAS on 31 Oct, in parallel with Phase B |
| Only one Android phone available | Medium | High | Borrow one now; else the 2nd peer = laptop running the relay demo, documented |
| Schema migration loses data | Low | High | Copy-then-verify-then-drop; test with sample DB |
| Phone numbers differ from thesis | Certain | Low | That's expected. Report what is measured. The correction file already removes invented numbers. |
| Time overrun | Medium | Medium | Phases D, E, F can each shrink to their tests-only core. C has 3 buffer days. |

---

## Traceability: thesis claim → phase

| Thesis claim | Phase |
|---|---|
| Anti-entropy gossip, 2.5 s, 16-byte hash, delta frames (§3.7.3, Table 13) | 1 ✅ |
| Real numbers for latency, WAL, payload size, convergence (sim) | A |
| 1 Hz downsampling, 10 s rolling pace, 10 m ghost Δt (§3.6, FRS-03/06) | B |
| UT-01, UT-02, UT-03, BVA tests, IT-01 (Table 26–27, §4.5.1) | B, D |
| Dual-role BLE, GATT, MTU frames (§2.7.1, §3.7.1, FRS-08, Fig 6, Fig B.1) | C |
| olsInference / npiCalculator / riiEvaluator / riiEngine (Fig 2, Table 22) | D |
| UT-04 with σ = 24.16, correct percentile tiers (App. B.2) | D |
| Six-table schema, PRAGMAs (Table 15, §3.8.2, FRS-07) | E |
| Hashed node identifiers (§6.3.2–6.3.3) | E |
| CI regression testing on push (Table 30) | F |
| On-device latency, battery, BLE t_sync, one GPS route (NFR-01..05, ST-03/05) | G |
| Appendix A screenshots | G |
