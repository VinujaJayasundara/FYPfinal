/**
 * A3 — Sync payload sizes.
 *
 * For 1, 2, 4, 6, 8, 20 and 40 leaderboard entries, reports:
 *   - binary payload bytes (encodeBinaryPayload, protocol v2)
 *   - JSON payload bytes (encodeStateVector, the old format) for comparison
 *   - number of frames at the 512-byte BLE limit (4-byte frame header)
 *   - the 16-byte state hash and the digest size (JSON, as sent over the relay)
 *
 * Entries mimic the app's records (14-char IDs, 29-char device ID, real alias
 * and route names). The crdtState holds one counter per device that
 * contributed entries; the case "1 device" has all entries from one runner,
 * "N devices" spreads one entry per runner.
 *
 * Output: benchmarks_output/payload.json
 */

import { machineInfo, makeDevice, prng, writeJson } from './common';
import { encodeBinaryPayload, encodeStateVector, splitIntoFrames, utf8Encode } from '../../src/core/crdt/stateVector';
import { createDigest, stateHash } from '../../src/core/crdt/antiEntropy';
import { BLE_MAX_PAYLOAD_BYTES } from '../../src/utils/constants';
import { LeaderboardEntry, SyncPayload } from '../../src/data/models';

const ENTRY_COUNTS = [1, 2, 4, 6, 8, 20, 40];
const SEED = 7;
const BASE_TIME = 1_793_000_000_000; // fixed timestamp so the output is reproducible
const ALIASES = ['Vinuja', 'Kasun', 'Nimal', 'Ayesha', 'Dilani', 'Tharindu', 'Sachini', 'Ruwan'];

function measure(entries: LeaderboardEntry[], crdtState: Record<string, number>, senderId: string) {
  const payload: SyncPayload = {
    deviceId: senderId,
    timestamp: BASE_TIME,
    crdtState,
    leaderboardEntries: entries,
    version: 1,
  };
  const binary = encodeBinaryPayload(payload);
  const json = utf8Encode(encodeStateVector(payload)).length;
  const frames = splitIntoFrames(binary, 1, BLE_MAX_PAYLOAD_BYTES);
  const digest = createDigest(senderId, crdtState, entries);
  return {
    entries: entries.length,
    devices: Object.keys(crdtState).length,
    binaryBytes: binary.length,
    jsonBytes: json,
    binaryVsJson: +(binary.length / json).toFixed(3),
    frames512: frames.length,
    framedBytesOnAir: frames.reduce((s, f) => s + f.length, 0),
    digestJsonBytes: utf8Encode(JSON.stringify(digest)).length,
    stateHashBytes: stateHash(digest).length,
  };
}

function main() {
  const random = prng(SEED);

  // Case 1: every entry comes from one runner (one route each).
  const singleDevice = ENTRY_COUNTS.map(n => {
    const dev = makeDevice(random, 'Vinuja', n, BASE_TIME);
    return measure(dev.leaderboard, { [dev.deviceId]: n }, dev.deviceId);
  });

  // Case 2: one entry per runner, up to 8 distinct runners, then wrap around.
  const devices = ALIASES.map((alias, i) => makeDevice(random, alias, 40, BASE_TIME + i * 1000));
  const multiDevice = ENTRY_COUNTS.map(n => {
    const entries: LeaderboardEntry[] = [];
    const crdt: Record<string, number> = {};
    for (let k = 0; k < n; k++) {
      const dev = devices[k % devices.length];
      entries.push(dev.leaderboard[Math.floor(k / devices.length)]);
      crdt[dev.deviceId] = (crdt[dev.deviceId] ?? 0) + 1;
    }
    return measure(entries, crdt, devices[0].deviceId);
  });

  // Per-entry marginal cost from the single-device series.
  const a = singleDevice[0];
  const b = singleDevice[singleDevice.length - 1];
  const bytesPerEntry = (b.binaryBytes - a.binaryBytes) / (b.entries - a.entries);

  const result = {
    benchmark: 'A3 sync payload sizes (binary protocol v2 vs JSON)',
    machine: machineInfo(),
    config: { entryCounts: ENTRY_COUNTS, maxFrameBytes: BLE_MAX_PAYLOAD_BYTES, frameHeaderBytes: 4, seed: SEED },
    binaryBytesPerAdditionalEntry: bytesPerEntry,
    singleDevice,
    multiDevice,
  };

  const file = writeJson('payload.json', result);
  console.log('A3 payload sizes');
  console.log('  entries | 1 device: binary / json / frames | N devices: binary / json / frames');
  ENTRY_COUNTS.forEach((n, i) => {
    const s = singleDevice[i];
    const m = multiDevice[i];
    console.log(
      `  ${String(n).padStart(7)} | ${String(s.binaryBytes).padStart(6)} / ${String(s.jsonBytes).padStart(6)} / ${s.frames512}` +
        `            | ${String(m.binaryBytes).padStart(6)} / ${String(m.jsonBytes).padStart(6)} / ${m.frames512}`,
    );
  });
  console.log(`  bytes per extra entry: ${bytesPerEntry.toFixed(1)}`);
  console.log(`  -> ${file}`);
}

main();
