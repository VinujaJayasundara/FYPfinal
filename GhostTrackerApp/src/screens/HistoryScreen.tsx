/**
 * Run history: every run, newest first, with filters (all / solo / with a
 * friend, date range, one friend). Tapping a run opens its detail with the
 * route on the map (start and finish markers). Runs with a friend use the
 * peer colour everywhere (badge and route), solo runs the solo colour.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useRun } from '../context/RunContext';
import { getRunHistory, getSessionTelemetry } from '../data/database';
import {
  filterRuns,
  peersInHistory,
  isPeerRun,
  type DateRangeFilter,
  type RunFilter,
  type RunHistoryItem,
  type RunKindFilter,
} from '../../../GhostTracker/src/core/history/runHistory';
import { CALIBRATION_RUNS, scoresVisibleForRun } from '../../../GhostTracker/src/core/fairness/calibration';
import { formatNPI, getNPIStatus } from '../core/npiEngine';
import { FinishedMap } from '../components/RunMap';
import RunScores from '../components/RunScores';
import { PEER_COLOR, SOLO_COLOR, runColor } from '../theme/runColors';

const C = {
  bg: '#000000',
  surface: '#1C1C1E',
  elevated: '#2C2C2E',
  separator: '#38383A',
  text: '#FFFFFF',
  dim: '#8E8E93',
  faint: '#636366',
  red: '#FF3B30',
};

// ── Formatting ─────────────────────────────────────────────

function fmtPace(s: number | null): string {
  if (!s || !isFinite(s)) return '--:--';
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}
function fmtDuration(s: number): string {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtDate(ms: number): string {
  const d = new Date(ms);
  const date = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${date} · ${time}`;
}
function fmtKm(m: number): string {
  return (m / 1000).toFixed(2);
}

function peerLabel(r: RunHistoryItem): string {
  if (!isPeerRun(r)) return 'SOLO';
  const race = r.peers.find(p => p.kind === 'race');
  const names = r.peers.map(p => p.alias).join(', ');
  return race ? `🔗 RACE · ${names}` : `🔗 ${names}`;
}

// ── Filter chips ───────────────────────────────────────────

function Chip({ label, active, color, onPress }: { label: string; active: boolean; color?: string; onPress: () => void }) {
  const c = color ?? SOLO_COLOR;
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.chip, active && { backgroundColor: c + '25', borderColor: c }]}
      activeOpacity={0.8}
    >
      <Text style={[styles.chipText, active && { color: c }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const KIND_OPTIONS: { key: RunKindFilter; label: string }[] = [
  { key: 'all', label: 'All runs' },
  { key: 'solo', label: 'Solo' },
  { key: 'peer', label: 'With a friend' },
];
const RANGE_OPTIONS: { key: DateRangeFilter; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
];

// ── Run detail ─────────────────────────────────────────────

function RunDetail({ run, baselinePace, onClose }: { run: RunHistoryItem; baselinePace: number | null; onClose: () => void }) {
  const mapRef = useRef<any>(null);
  const [route, setRoute] = useState<{ latitude: number; longitude: number }[] | null>(null);
  const color = runColor(isPeerRun(run));

  useEffect(() => {
    getSessionTelemetry(run.sessionId)
      .then(pts => setRoute(pts.map(p => ({ latitude: p.latitude, longitude: p.longitude }))))
      .catch(() => setRoute([]));
  }, [run.sessionId]);

  const region = route && route.length > 0
    ? { latitude: route[0].latitude, longitude: route[0].longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 }
    : { latitude: 6.8448, longitude: 79.8999, latitudeDelta: 0.01, longitudeDelta: 0.01 };

  return (
    <View style={styles.detail}>
      <View style={styles.detailHeader}>
        <TouchableOpacity onPress={onClose} hitSlop={12}>
          <Text style={styles.back}>‹ History</Text>
        </TouchableOpacity>
        <View style={[styles.badge, { backgroundColor: color + '25', borderColor: color }]}>
          <Text style={[styles.badgeText, { color }]} numberOfLines={1}>{peerLabel(run)}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={styles.detailDate}>{fmtDate(run.startTime)}</Text>

        <View style={styles.mapBox}>
          {route === null ? null : route.length >= 2 ? (
            <FinishedMap mapRef={mapRef} initialRegion={region} routeCoords={route} color={color} interactive />
          ) : (
            <View style={styles.noRoute}>
              <Text style={styles.noRouteText}>No route recorded for this run</Text>
            </View>
          )}
        </View>

        <View style={styles.statGrid}>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{fmtKm(run.distanceM)}</Text>
            <Text style={styles.statLabel}>km</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{fmtDuration(run.durationS)}</Text>
            <Text style={styles.statLabel}>time</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statValue}>{fmtPace(run.paceSPerKm)}</Text>
            <Text style={styles.statLabel}>/km</Text>
          </View>
        </View>

        {run.raceOutcome && (
          <Text style={[styles.raceLine, { color: PEER_COLOR }]}>
            Connected race ·{' '}
            {run.raceOutcome === 'win' ? 'You won 🏆' : run.raceOutcome === 'loss' ? 'Lost' : run.raceOutcome === 'tie' ? 'Tie' : 'No winner'}
          </Text>
        )}
        {run.isPB && <Text style={styles.pbLine}>Personal best on this route</Text>}

        <RunScores
          runNo={run.runNo}
          pace={run.paceSPerKm}
          npi={run.npi}
          rii={run.rii}
          baselinePace={scoresVisibleForRun(run.runNo) ? baselinePace : null}
        />
      </ScrollView>
    </View>
  );
}

// ── Screen ─────────────────────────────────────────────────

export default function HistoryScreen() {
  const { dbVersion, calibration } = useRun();
  const [runs, setRuns] = useState<RunHistoryItem[]>([]);
  const [filter, setFilter] = useState<RunFilter>({ kind: 'all', range: 'all', peerId: null });
  const [open, setOpen] = useState<RunHistoryItem | null>(null);

  const load = useCallback(() => {
    getRunHistory().then(setRuns).catch(e => console.error('[History] load failed:', e));
  }, []);
  useEffect(load, [load, dbVersion]);

  const peers = useMemo(() => peersInHistory(runs), [runs]);
  const shown = useMemo(() => filterRuns(runs, filter, Date.now()), [runs, filter]);

  return (
    <View>
      <Text style={styles.title}>Run history</Text>
      <Text style={styles.subtitle}>
        {runs.length} run{runs.length === 1 ? '' : 's'} ·{' '}
        {calibration.calibrated ? 'baseline set' : `baseline ${calibration.runs} of ${CALIBRATION_RUNS}`}
      </Text>

      {/* Filters */}
      <View style={styles.filterRow}>
        {KIND_OPTIONS.map(o => (
          <Chip
            key={o.key}
            label={o.label}
            active={filter.kind === o.key}
            color={o.key === 'peer' ? PEER_COLOR : SOLO_COLOR}
            onPress={() => setFilter(f => ({ ...f, kind: o.key, peerId: o.key === 'solo' ? null : f.peerId }))}
          />
        ))}
      </View>
      <View style={styles.filterRow}>
        {RANGE_OPTIONS.map(o => (
          <Chip key={o.key} label={o.label} active={filter.range === o.key} onPress={() => setFilter(f => ({ ...f, range: o.key }))} />
        ))}
      </View>
      {peers.length > 0 && filter.kind !== 'solo' && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
          <Chip label="Any friend" active={filter.peerId === null} color={PEER_COLOR} onPress={() => setFilter(f => ({ ...f, peerId: null }))} />
          {peers.map(p => (
            <Chip
              key={p.peerId}
              label={`${p.alias} (${p.runs})`}
              active={filter.peerId === p.peerId}
              color={PEER_COLOR}
              onPress={() => setFilter(f => ({ ...f, kind: f.kind === 'solo' ? 'all' : f.kind, peerId: p.peerId }))}
            />
          ))}
        </ScrollView>
      )}

      {/* List */}
      {shown.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {runs.length === 0 ? 'No runs yet. Start your first run on the Run tab.' : 'No runs match these filters.'}
          </Text>
        </View>
      ) : (
        shown.map(r => {
          const color = runColor(isPeerRun(r));
          const scored = scoresVisibleForRun(r.runNo);
          const npiStatus = scored && r.npi !== null ? getNPIStatus(r.npi) : null;
          return (
            <TouchableOpacity key={r.sessionId} style={[styles.item, { borderLeftColor: color }]} onPress={() => setOpen(r)} activeOpacity={0.8}>
              <View style={styles.itemTop}>
                <Text style={styles.itemDate}>{fmtDate(r.startTime)}</Text>
                <View style={[styles.badgeSmall, { backgroundColor: color + '20' }]}>
                  <Text style={[styles.badgeSmallText, { color }]} numberOfLines={1}>{peerLabel(r)}</Text>
                </View>
              </View>
              <View style={styles.itemStats}>
                <Text style={styles.itemMain}>{fmtKm(r.distanceM)} km</Text>
                <Text style={styles.itemSub}>{fmtDuration(r.durationS)}</Text>
                <Text style={styles.itemSub}>{fmtPace(r.paceSPerKm)} /km</Text>
                <Text style={[styles.itemNpi, { color: npiStatus?.color ?? C.faint }]}>
                  {r.runNo === null
                    ? 'too short'
                    : scored
                      ? r.npi !== null ? `NPI ${formatNPI(r.npi)}` : 'NPI —'
                      : `baseline ${r.runNo}/${CALIBRATION_RUNS}`}
                </Text>
              </View>
              {(r.isPB || r.raceOutcome) && (
                <Text style={styles.itemTags}>
                  {r.isPB ? 'PB  ' : ''}
                  {r.raceOutcome === 'win' ? 'Race won 🏆' : r.raceOutcome === 'loss' ? 'Race lost' : r.raceOutcome ? 'Race' : ''}
                </Text>
              )}
            </TouchableOpacity>
          );
        })
      )}

      <Modal visible={open !== null} animationType="slide" onRequestClose={() => setOpen(null)}>
        {open && <RunDetail run={open} baselinePace={calibration.baselinePace} onClose={() => setOpen(null)} />}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { color: C.text, fontSize: 26, fontWeight: '800', marginTop: 4 },
  subtitle: { color: C.dim, fontSize: 13, marginTop: 2, marginBottom: 12 },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: { borderWidth: 1, borderColor: C.separator, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  chipText: { color: C.dim, fontSize: 13, fontWeight: '600' },
  empty: { backgroundColor: C.surface, borderRadius: 14, padding: 20, marginTop: 8 },
  emptyText: { color: C.dim, fontSize: 14, textAlign: 'center' },
  item: {
    backgroundColor: C.surface,
    borderRadius: 14,
    padding: 14,
    marginTop: 10,
    borderLeftWidth: 4,
  },
  itemTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  itemDate: { color: C.dim, fontSize: 13, flexShrink: 1 },
  badgeSmall: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2, maxWidth: '55%' },
  badgeSmallText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  itemStats: { flexDirection: 'row', alignItems: 'baseline', gap: 14, marginTop: 8, flexWrap: 'wrap' },
  itemMain: { color: C.text, fontSize: 22, fontWeight: '800' },
  itemSub: { color: C.text, fontSize: 15, fontVariant: ['tabular-nums'] },
  itemNpi: { fontSize: 13, fontWeight: '700', marginLeft: 'auto' },
  itemTags: { color: C.dim, fontSize: 12, marginTop: 6 },
  // detail
  detail: { flex: 1, backgroundColor: C.bg },
  detailHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 48,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.separator,
    gap: 12,
  },
  back: { color: SOLO_COLOR, fontSize: 17, fontWeight: '600' },
  badge: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4, flexShrink: 1 },
  badgeText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  detailDate: { color: C.text, fontSize: 18, fontWeight: '700', marginBottom: 12 },
  mapBox: { height: 300, borderRadius: 16, overflow: 'hidden', backgroundColor: '#0a0e1a' },
  noRoute: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  noRouteText: { color: C.faint, fontSize: 13 },
  statGrid: { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 16, paddingVertical: 16, marginTop: 12 },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: C.text, fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: C.dim, fontSize: 12, marginTop: 2 },
  raceLine: { fontSize: 15, fontWeight: '700', marginTop: 12 },
  pbLine: { color: SOLO_COLOR, fontSize: 14, fontWeight: '600', marginTop: 8 },
});
