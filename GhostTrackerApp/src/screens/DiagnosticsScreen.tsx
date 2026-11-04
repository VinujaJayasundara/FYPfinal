/**
 * Diagnostics (Phase F3) — hidden screen, opened by long-pressing the
 * "GHOST TRACKER" title.
 *
 * Measures on this device the same workloads as the laptop benchmarks:
 *   - 10,000 fairness-engine inferences (expected pace → NPI → RII)
 *   - 1,000 single-row GPS inserts: WAL + NORMAL (the app) vs rollback + FULL
 * in a scratch database that is deleted afterwards (the user's data is not
 * touched). Also shows the battery log recorded during runs (Phase F4).
 *
 * Every result is labelled with the device and whether it is an emulator, and
 * can be shared as JSON / CSV for the thesis measurements (Phase G).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import {
  runInferenceBenchmark,
  runWalBenchmark,
  WAL_CONFIGS,
  type InferenceResult,
  type WalResult,
  type Stats,
} from '../../../GhostTracker/src/core/diagnostics/benchmarks';
import type { SqlDb } from '../../../GhostTracker/src/data/database/thesisSchema';
import { NPI_MODEL } from '../core/npiEngine';
import { batteryAvailable } from '../core/battery';
import {
  getBatteryLog,
  summarizeBatteryLog,
  batteryLogCsv,
  type BatteryRunSummary,
} from '../data/database';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const APP_VERSION: string = require('../../app.json').expo.version;

const C = {
  bg: '#000000',
  surface: '#1C1C1E',
  separator: '#38383A',
  accent: '#00FF87',
  amber: '#FF9F0A',
  red: '#FF3B30',
  text: '#FFFFFF',
  dim: '#8E8E93',
};

const now: () => number =
  typeof globalThis.performance?.now === 'function' ? () => globalThis.performance.now() : () => Date.now();

// ── Device description ─────────────────────────────────────

export interface DeviceInfo {
  os: string;
  osVersion: string;
  model: string;
  manufacturer: string;
  /** 'phone' or 'emulator' — every exported result carries this label. */
  environment: 'phone' | 'emulator' | 'unknown';
  appVersion: string;
  clock: 'performance.now' | 'Date.now';
}

function deviceInfo(): DeviceInfo {
  const c: any = Platform.constants ?? {};
  const model = String(c.Model ?? c.model ?? 'unknown');
  const fingerprint = String(c.Fingerprint ?? '');
  const emulator =
    /generic|emulator|sdk_gphone|google_sdk/i.test(fingerprint) || /sdk|emulator/i.test(model);
  return {
    os: Platform.OS,
    osVersion: String(c.Release ?? Platform.Version),
    model,
    manufacturer: String(c.Manufacturer ?? c.Brand ?? 'unknown'),
    environment: Platform.OS === 'web' ? 'unknown' : emulator ? 'emulator' : 'phone',
    appVersion: APP_VERSION,
    clock: typeof globalThis.performance?.now === 'function' ? 'performance.now' : 'Date.now',
  };
}

// ── Scratch database for the write benchmark ───────────────

function asSqlDb(conn: SQLite.SQLiteDatabase): SqlDb {
  return {
    exec: sql => conn.execAsync(sql),
    run: async (sql, params = []) => {
      await conn.runAsync(sql, params as SQLite.SQLiteBindParams);
    },
    all: <T,>(sql: string, params: unknown[] = []) => conn.getAllAsync<T>(sql, params as SQLite.SQLiteBindParams),
  };
}

async function runWalOnScratch(): Promise<WalResult[]> {
  const results: WalResult[] = [];
  for (const cfg of WAL_CONFIGS) {
    const name = `diagnostics-${cfg.name}.db`;
    const conn = await SQLite.openDatabaseAsync(name);
    try {
      results.push(await runWalBenchmark(asSqlDb(conn), cfg, now, 1000));
    } finally {
      await conn.closeAsync();
      await SQLite.deleteDatabaseAsync(name).catch(() => undefined);
    }
  }
  return results;
}

// ── Formatting ─────────────────────────────────────────────

/** ms → readable (µs below 0.1 ms). */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0.1) return `${(ms * 1000).toFixed(2)} µs`;
  return `${ms.toFixed(3)} ms`;
}

function StatsRow({ label, s }: { label: string; s: Stats }) {
  return (
    <View style={styles.statsRow}>
      <Text style={styles.statsLabel}>{label}</Text>
      <Text style={styles.statsValue}>
        mean {fmtMs(s.mean)} · p50 {fmtMs(s.p50)} · p99 {fmtMs(s.p99)}
      </Text>
    </View>
  );
}

interface Run {
  measuredAt: string;
  inference?: InferenceResult;
  wal?: WalResult[];
}

// ── Screen ─────────────────────────────────────────────────

export default function DiagnosticsScreen({
  visible,
  onClose,
  onOpenSyncLog,
}: {
  visible: boolean;
  onClose: () => void;
  /** Opens the hidden sync screen and log (debugging). */
  onOpenSyncLog?: () => void;
}) {
  const [device] = useState(deviceInfo);
  const [busy, setBusy] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [battery, setBattery] = useState<BatteryRunSummary[]>([]);
  const [batterySamples, setBatterySamples] = useState(0);

  const loadBattery = useCallback(async () => {
    try {
      const rows = await getBatteryLog();
      setBatterySamples(rows.length);
      setBattery(summarizeBatteryLog(rows));
    } catch (e) {
      console.warn('[Diagnostics] battery log:', e);
    }
  }, []);

  useEffect(() => {
    if (visible) loadBattery();
  }, [visible, loadBattery]);

  const runAll = useCallback(async (repeats: number) => {
    setError(null);
    try {
      for (let r = 1; r <= repeats; r++) {
        const label = repeats > 1 ? ` (${r}/${repeats})` : '';
        setBusy(`Inference: 10,000 calls${label}…`);
        // Let the spinner render before the synchronous loop blocks the JS thread
        await new Promise(res => setTimeout(res, 50));
        const inference = runInferenceBenchmark(now);
        setBusy(`SQLite: 2 × 1,000 inserts${label}…`);
        const wal = await runWalOnScratch();
        const run: Run = { measuredAt: new Date().toISOString(), inference, wal };
        console.log('[Diagnostics]', JSON.stringify({ device, ...run }));
        setRuns(prev => [...prev, run]);
      }
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }, [device]);

  const shareResults = useCallback(() => {
    const payload = {
      kind: 'equistride-diagnostics',
      note: `Measured on ${device.environment === 'phone' ? 'a phone' : device.environment === 'emulator' ? 'an Android emulator (not a phone)' : 'an unknown device'}.`,
      device,
      model: { sigma: NPI_MODEL.sigma },
      runs,
    };
    Share.share({ title: 'EquiStride diagnostics', message: JSON.stringify(payload, null, 2) });
  }, [device, runs]);

  const shareBattery = useCallback(async () => {
    const rows = await getBatteryLog();
    const csv = `# EquiStride battery log — ${device.manufacturer} ${device.model} (${device.environment})\n${batteryLogCsv(rows)}`;
    Share.share({ title: 'EquiStride battery log', message: csv });
  }, [device]);

  const last = runs[runs.length - 1];
  const walByName = (name: string) => last?.wal?.find(w => w.config === name);
  const walApp = walByName('wal-normal');
  const walDefault = walByName('rollback-full');

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>DIAGNOSTICS</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Close</Text>
          </TouchableOpacity>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
          {/* Device */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>DEVICE</Text>
            <Text style={styles.line}>
              {device.manufacturer} {device.model} · {device.os} {device.osVersion}
            </Text>
            <Text style={[styles.badge, device.environment === 'phone' ? styles.badgePhone : styles.badgeEmu]}>
              {device.environment === 'phone'
                ? 'PHONE'
                : device.environment === 'emulator'
                  ? 'EMULATOR — not phone numbers'
                  : 'UNKNOWN DEVICE'}
            </Text>
            <Text style={styles.small}>
              App {device.appVersion} · clock {device.clock} · model σ {NPI_MODEL.sigma.toFixed(3)} s/km
            </Text>
          </View>

          {/* Benchmarks */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>ON-DEVICE BENCHMARKS</Text>
            <Text style={styles.small}>
              Same workloads as the laptop scripts. The write test uses a scratch database that is deleted afterwards.
              Keep the screen on and the phone unplugged.
            </Text>
            <View style={styles.buttons}>
              <TouchableOpacity style={styles.button} disabled={!!busy} onPress={() => runAll(1)}>
                <Text style={styles.buttonText}>RUN ONCE</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.button} disabled={!!busy} onPress={() => runAll(3)}>
                <Text style={styles.buttonText}>RUN 3×</Text>
              </TouchableOpacity>
            </View>
            {busy && (
              <View style={styles.busy}>
                <ActivityIndicator color={C.accent} />
                <Text style={styles.small}>{busy}</Text>
              </View>
            )}
            {error && <Text style={[styles.line, { color: C.red }]}>Error: {error}</Text>}

            {last?.inference && (
              <>
                <Text style={styles.section}>Inference (expected pace → NPI → RII)</Text>
                <StatsRow label="Per call, from batches" s={last.inference.batchMsPerCall} />
                <StatsRow label="Per call, timed singly*" s={last.inference.perCallMs} />
                <StatsRow label="Clock read" s={last.inference.clockOverheadMs} />
                <Text style={styles.small}>*includes one clock read; the batch figure is the fair cost per call.</Text>
              </>
            )}
            {walApp && walDefault && (
              <>
                <Text style={styles.section}>SQLite insert, 1,000 rows, one transaction each</Text>
                <StatsRow label={`WAL + NORMAL (app) — ${walApp.journalMode}`} s={walApp.insertMs} />
                <StatsRow label={`Rollback + FULL (default) — ${walDefault.journalMode}`} s={walDefault.insertMs} />
                <Text style={styles.line}>
                  Mean ratio: {(walDefault.insertMs.mean / walApp.insertMs.mean).toFixed(1)}× faster with WAL
                </Text>
                <Text style={styles.small}>Includes the JS → native call, as the app pays it.</Text>
              </>
            )}
            {runs.length > 0 && (
              <>
                <Text style={styles.small}>{runs.length} run(s) this session.</Text>
                <TouchableOpacity style={[styles.button, { marginTop: 8 }]} onPress={shareResults}>
                  <Text style={styles.buttonText}>SHARE RESULTS (JSON)</Text>
                </TouchableOpacity>
              </>
            )}
          </View>

          {/* Sync log (the Sync tab is hidden from normal use) */}
          {onOpenSyncLog && (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>BLUETOOTH SYNC (DEBUG)</Text>
              <Text style={styles.small}>Peers, gossip status and the full sync log.</Text>
              <TouchableOpacity style={[styles.button, { marginTop: 10 }]} onPress={onOpenSyncLog}>
                <Text style={styles.buttonText}>OPEN SYNC LOG</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Battery */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>BATTERY LOG (RUNS)</Text>
            {!batteryAvailable() ? (
              <Text style={styles.small}>
                This build has no battery module — install the latest APK to record battery during runs.
              </Text>
            ) : battery.length === 0 ? (
              <Text style={styles.small}>No runs logged yet. The level is recorded every minute during a run.</Text>
            ) : (
              battery.slice(0, 10).map(b => (
                <View key={b.runStartedAt} style={styles.statsRow}>
                  <Text style={styles.statsLabel}>
                    {new Date(b.runStartedAt).toLocaleString()} · {b.minutes.toFixed(0)} min · {b.samples} samples
                    {b.bleRunning ? ' · Bluetooth on' : ''}
                    {b.charged ? ' · CHARGING (exclude)' : ''}
                  </Text>
                  <Text style={styles.statsValue}>
                    {b.startPct.toFixed(0)}% → {b.endPct.toFixed(0)}% ·{' '}
                    {b.drainPctPerHour === null ? 'too short for a rate (<10 min)' : `${b.drainPctPerHour.toFixed(1)} %/h`}
                  </Text>
                </View>
              ))
            )}
            {batterySamples > 0 && (
              <TouchableOpacity style={[styles.button, { marginTop: 8 }]} onPress={shareBattery}>
                <Text style={styles.buttonText}>SHARE BATTERY CSV ({batterySamples} rows)</Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.separator,
  },
  title: { color: C.text, fontSize: 16, fontWeight: '800', letterSpacing: 2 },
  close: { color: C.accent, fontSize: 15, fontWeight: '600' },
  card: { backgroundColor: C.surface, borderRadius: 14, padding: 14, marginBottom: 14 },
  cardTitle: { color: C.dim, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginBottom: 8 },
  line: { color: C.text, fontSize: 14, marginBottom: 4 },
  small: { color: C.dim, fontSize: 12, marginTop: 4, lineHeight: 17 },
  section: { color: C.text, fontSize: 13, fontWeight: '700', marginTop: 14, marginBottom: 4 },
  badge: {
    alignSelf: 'flex-start',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
    marginVertical: 4,
  },
  badgePhone: { backgroundColor: '#00FF8730', color: C.accent },
  badgeEmu: { backgroundColor: '#FF9F0A30', color: C.amber },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 10 },
  button: { flex: 1, backgroundColor: '#2C2C2E', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: C.accent, fontSize: 13, fontWeight: '700', letterSpacing: 1 },
  busy: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  statsRow: { marginTop: 6 },
  statsLabel: { color: C.dim, fontSize: 12 },
  statsValue: { color: C.text, fontSize: 13, fontVariant: ['tabular-nums'] },
});
