# Evidence for the thesis claims: speed, connection, battery

**Thesis:** *A Privacy-Preserving P2P Edge-Consensus Framework for Fair Fitness Competition* · **Viva:** 19 Nov 2026
**Build:** tag `viva-v1.0` · **Compiled:** 17 Nov 2026

Every value says where it was measured. **Laptop** = development laptop (Intel i5-10200H, 16 GB, Windows 11, Node.js 24). **Emulator** = Android emulator, x86_64. **Phone** = a real handset. **Simulation** = the real app code on a simulated network. Laptop values come from scripts in `GhostTracker/scripts/` (outputs in `scripts/benchmarks_output/`). Phone values come from the app's Diagnostics screen and sync log.

**Phones:** OnePlus 7 (GM1900, Android 12), Samsung Galaxy A03s (SM-A037F, Android 13), POCO X3 NFC (Bluetooth trials on 5 Nov only).

---

## At a glance

| Claim | Target | Result | Where | Status |
|---|---|---|---|---|
| Model calculation time (NFR-01) | < 0.04 ms | 1.05 µs / 4.87 µs | Phones | ✅ Met |
| Bit-identical results, ARM64 vs x86 (ST-04) | identical | Same hash, 3,000,000 values | 2 phones + laptop | ✅ Met |
| WAL write speed-up (NFR-02) | 13.2× | 6.1× / 3.1× | Phones | ⚠️ Faster, but less than claimed |
| Bluetooth sync time (NFR-03) | ≤ 10 s | 2.51–5.07 s, 4 trials | Phones (2 at a time) | ✅ Met for 2 phones |
| 8-node convergence | ≤ 10 s | 6.4 s at 15 % loss; 12.1 s at 30 % loss | Simulation | ⚠️ Met at 15 %, missed at 30 % |
| Payload fits a BLE frame (NFR-04) | 512 B frame | 171 B for 1 entry; ≤ 4 entries per frame | Real encoder | ✅ Met |
| No coordinates leave the phone (NFR-06) | 0 bytes | No coordinate fields in any message | Unit tests | ✅ By design; no packet capture |
| Battery drain (ST-05) | < 6.8 %/h | Logger works; no run ≥ 10 min yet | Phones | ❌ Not measured |

---

## 1. Speed

### 1.1 Model calculation (expected pace → NPI → RII)

| Where | Mean per call | p99 | How |
|---|---|---|---|
| Laptop | 89 ns | ≤ 1 µs | 30 × 10,000 calls, `inference_latency.ts` |
| Emulator | 5.6 µs | — | Diagnostics |
| **OnePlus 7** | **1.05 µs** | 1.13 µs | Diagnostics, batches, last of 3 runs |
| **Samsung A03s** | **4.87 µs** | 5.97 µs | Diagnostics, batches, last of 3 runs |

The target is 40 µs. The slowest phone is about 8× below it.

### 1.2 Database writes: WAL vs the default (rollback) mode

1,000 single-row inserts, each in its own transaction (one per GPS fix).

| Where | WAL + NORMAL (the app) | Rollback + FULL (default) | Speed-up |
|---|---|---|---|
| Laptop | 0.055 ms | 3.3 ms | ≈ 60× |
| Emulator | 7.5 ms | 34.4 ms | 4.6× |
| **OnePlus 7** | **1.99 ms** | **12.07 ms** | **6.1×** |
| **Samsung A03s** | **5.90 ms** | **18.23 ms** | **3.1×** |

Phone values include the JavaScript → native call, as the app pays it. WAL is faster on every device, but the thesis figure of 13.2× was not reached on the phones.

### 1.3 Bit-identical results across processors

The phone recomputes 1,000,000 evaluations of expected pace, NPI and RII. It hashes the raw 64-bit values before rounding (3,000,000 values) and compares the hash with the laptop's.

| Device | Processor | Hash | Result |
|---|---|---|---|
| Laptop | x86_64 | `1ca3436b7154fb59` | reference, pinned in `determinism.test.ts` |
| **OnePlus 7** | ARM64 | `1ca3436b7154fb59` | **MATCH** (3.0 s) |
| **Samsung A03s** | ARM64 | `1ca3436b7154fb59` | **MATCH** (12.8 s) |

Two runners with the same inputs get exactly the same score on any of these devices.

*Phone measurements: 17 Nov 2026, phones plugged in over USB (Diagnostics recommends unplugged).*

---

## 2. Connection

### 2.1 Real Bluetooth syncs between phones

Read from the app's sync log on each phone.

| Date | Phones | Time to sync | Sent / received | Frames | MTU | RSSI |
|---|---|---|---|---|---|---|
| 5 Nov | OnePlus 7 ↔ POCO X3 NFC | **2.53 s** | 136 / 98 B | 1 | 517 | −61 dBm |
| 5 Nov | OnePlus 7 ↔ POCO X3 NFC | **2.55 s** | 76 / 798 B | 1 | 517 | −42 dBm |
| 11 Nov | OnePlus 7 ↔ Samsung A03s | **5.07 s** (Samsung: 5.06 s) | 157 / 203 B | 1 | 517 | −41 dBm |
| 16 Nov | OnePlus 7 ↔ Samsung A03s | **2.51 s** (Samsung: 2.52 s) | 97 / 336 B | 1 | 517 | −43 dBm |

- All 4 syncs finished within the 10 s target.
- Each took 1 or 2 gossip rounds (one round = 2.5 s).
- Where both phones logged the sync, their times agree to within 10 ms.
- **Measured from** the moment the phones detect their data differ **to** the moment both report "in sync". Bluetooth discovery and connection set-up are not included.
- **Limits:** 4 trials, 2 phones at a time.

### 2.2 Eight nodes (simulation)

The real `GossipSession` code (state hash → digest → framed delta) runs on an in-memory network with random message loss. There were 100 seeds per setting, and **all 1,200 runs converged**.

| Nodes | Loss | Mean rounds | Mean time | p99 time |
|---|---|---|---|---|
| 8 | 0 % | 1.00 | 2.5 s | 2.5 s |
| 8 | 15 % | 2.56 | 6.4 s | 10.0 s |
| 8 | 30 % | 4.85 | **12.1 s** | 20.0 s |

At 30 % loss the 10 s target is missed. Simulated times exclude Bluetooth set-up and air time.

### 2.3 Payload size (real encoder)

| Entries | Binary bytes | Old JSON bytes | 512-byte frames |
|---|---|---|---|
| 1 | 171 | 427 | 1 |
| 4 | 435 | 1,235 | 1 |
| 8 | 787 | 2,298 | 2 |

Each extra entry adds 88.8 B. When nothing has changed, a round costs one 16-byte state hash per phone. The real syncs above each used one frame.

### 2.4 Live race

- **Emulators (4 Nov):** a 1 km race between two emulators. Both showed the same result (3:48 vs 4:41).
- **Phones (5 Nov):** a real 2 km race on OnePlus 7 and POCO X3 NFC. One phone showed itself 32 m ahead because of GPS noise. This led to the Kalman GPS pipeline (section 4).

### 2.5 Privacy

Unit tests check that race snapshots, leaderboard sync and control messages contain no coordinate fields. Coordinates in packets from older builds are dropped. **No packet capture (Wireshark) was done.**

---

## 3. Battery

| What | Status |
|---|---|
| Battery logger | Built and working. It records battery % at the start, every 60 s and at the end of a run, with the Bluetooth state. It flags runs that were charging. The OnePlus holds 87 samples. |
| Drain rate | **Not measured.** A rate is shown only for runs of 10 minutes or more, and no logged run is that long yet. The longest was 6 min (98 % → 97 %). |
| Thesis claim < 6.8 %/h | **Unsupported until a 30-minute run with Bluetooth on is logged.** |

---

## 4. GPS distance (supporting evidence)

| What | Result | Where |
|---|---|---|
| Two-phone 2 km race before the fix | One phone 32 m ahead (GPS noise) | Phones |
| Same scenario after the fix (1 Hz gate, 20 m accuracy gate, velocity clamp, warm-up, Kalman filter) | Gap ≤ 15 m over 2 km steady; ≤ 18 m stop-and-go | Simulation |
| Standing still for 5 min, harsh noise | < 20 m (a plain sum of steps gives > 1 km) | Simulation |
| 6 runs recorded with Strava, put through the app's GPS pipeline | 2–4 % shorter than the raw GPX distance; on 14 Nov Strava showed 3.50 km and the app 3.47 km | Laptop |
| Thesis field trials in 3 cities | **Not done** | — |

---

## 5. Not yet measured

1. **Battery:** one 30-minute run, phone unplugged, Bluetooth on.
2. **More Bluetooth trials:** the plan was 20. There are 4 so far.
3. **Rendering at 60 FPS:** not measured (future work).
4. **Packet capture:** not done. Privacy rests on code inspection and tests.
5. **Lab equipment** (Ellisys analyzer, Monsoon power monitor, measuring wheel, 6 handsets): not used.

**What to say:** "Everything here is labelled by where it was measured: laptop, emulator, phone or simulation. The phone results support the claims about calculation time, bit-identical scoring and Bluetooth sync time for two phones. WAL is faster, but by less than I wrote. Eight-node convergence is a simulation. Battery is not measured yet."
