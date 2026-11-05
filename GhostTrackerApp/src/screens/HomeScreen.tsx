/**
 * Home — the "dual-metric" dashboard (thesis Table A.1): NPI and RII side
 * by side, the last run with its route, this week, the NPI trend, a compact
 * totals line, friends, a big Start button, and the metric explainers folded
 * away. During the first 5 runs the scores are replaced by baseline progress.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useProfile } from '../context/ProfileContext';
import { useRun } from '../context/RunContext';
import {
  getRunHistory,
  getSessionTelemetry,
  getPBSession,
  getRaceSummary,
  getPeers,
  type DBPeer,
  type RaceSummary,
} from '../data/database';
import {
  isPeerRun,
  lastRun as pickLastRun,
  npiTrend,
  weekStats,
  type RunHistoryItem,
} from '../../../GhostTracker/src/core/history/runHistory';
import {
  CALIBRATION_RUNS,
  formatVsBaseline,
  relativeToBaseline,
} from '../../../GhostTracker/src/core/fairness/calibration';
import { formatNPI, getNPIStatus } from '../core/npiEngine';
import { calculateRII, getRIIStatus } from '../core/algorithms';
import { FinishedMap } from '../components/RunMap';
import { BaselineProgress } from '../components/RunScores';
import { RunDetail } from './HistoryScreen';
import { PEER_COLOR, SOLO_COLOR, runColor } from '../theme/runColors';

const C = {
  surface: '#1C1C1E',
  elevated: '#2C2C2E',
  separator: '#38383A',
  text: '#FFFFFF',
  dim: '#8E8E93',
  faint: '#636366',
  amber: '#FF9F0A',
  blue: '#0A84FF',
};

function fmtPace(s: number | null | undefined): string {
  if (!s || !isFinite(s) || s <= 0) return '--:--';
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}
function fmtDuration(s: number): string {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
function fmtWhen(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yest = new Date(today.getTime() - 86_400_000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today · ${time}`;
  if (yest) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${time}`;
}

// ── NPI trend (small bar chart around zero) ────────────────

function NpiTrendChart({ points }: { points: { startTime: number; npi: number }[] }) {
  const maxAbs = Math.max(1, ...points.map(p => Math.abs(p.npi)));
  const half = 36; // px above / below the zero line
  return (
    <View>
      <View style={styles.trendChart}>
        {points.map((p, i) => {
          const h = Math.max(3, (Math.abs(p.npi) / maxAbs) * half);
          const color = getNPIStatus(p.npi).color;
          return (
            <View key={i} style={styles.trendCol}>
              <View style={{ height: half, justifyContent: 'flex-end' }}>
                {p.npi >= 0 && <View style={[styles.trendBar, { height: h, backgroundColor: color }]} />}
              </View>
              <View style={{ height: half }}>
                {p.npi < 0 && <View style={[styles.trendBar, { height: h, backgroundColor: color }]} />}
              </View>
            </View>
          );
        })}
        <View style={[styles.zeroLine, { top: half }]} />
      </View>
      <View style={styles.trendAxis}>
        <Text style={styles.trendAxisText}>older</Text>
        <Text style={styles.trendAxisText}>0 = as the model expects</Text>
        <Text style={styles.trendAxisText}>latest</Text>
      </View>
    </View>
  );
}

// ── Last run card ──────────────────────────────────────────

function LastRunCard({ run, onOpen }: { run: RunHistoryItem; onOpen: () => void }) {
  const mapRef = useRef<any>(null);
  const [route, setRoute] = useState<{ latitude: number; longitude: number }[] | null>(null);
  const color = runColor(isPeerRun(run));
  useEffect(() => {
    getSessionTelemetry(run.sessionId)
      .then(pts => setRoute(pts.map(p => ({ latitude: p.latitude, longitude: p.longitude }))))
      .catch(() => setRoute([]));
  }, [run.sessionId]);
  const friend = run.peers[0];
  const region = route && route.length > 0
    ? { latitude: route[0].latitude, longitude: route[0].longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 }
    : { latitude: 6.8448, longitude: 79.8999, latitudeDelta: 0.01, longitudeDelta: 0.01 };

  return (
    <TouchableOpacity style={[styles.card, { borderColor: color + '50', borderWidth: 1 }]} onPress={onOpen} activeOpacity={0.85}>
      <View style={styles.cardHeadRow}>
        <Text style={styles.sectionLabel}>LAST RUN · {fmtWhen(run.startTime).toUpperCase()}</Text>
        <Text style={[styles.tag, { color }]} numberOfLines={1}>
          {friend ? `🔗 ${friend.kind === 'race' ? 'vs ' : ''}${friend.alias}` : 'SOLO'}
        </Text>
      </View>
      <View style={styles.lastRow}>
        <View style={styles.miniMap} pointerEvents="none">
          {route && route.length >= 2 ? (
            <FinishedMap mapRef={mapRef} initialRegion={region} routeCoords={route} color={color} />
          ) : (
            <View style={styles.miniMapEmpty}>
              <Text style={styles.faintText}>{route === null ? '' : 'no route'}</Text>
            </View>
          )}
        </View>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Text style={styles.lastBig}>{(run.distanceM / 1000).toFixed(2)} km</Text>
          <Text style={styles.lastSub}>
            {fmtDuration(run.durationS)} · {fmtPace(run.paceSPerKm)} /km
          </Text>
          {run.raceOutcome && (
            <Text style={[styles.lastSub, { color: PEER_COLOR, fontWeight: '700' }]}>
              {run.raceOutcome === 'win' ? 'Race won 🏆' : run.raceOutcome === 'loss' ? 'Race lost' : run.raceOutcome === 'tie' ? 'Race tied' : 'Race · no winner'}
            </Text>
          )}
          {run.isPB && <Text style={[styles.lastSub, { color: SOLO_COLOR, fontWeight: '700' }]}>New PB</Text>}
          <Text style={styles.linkText}>Open in history ›</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ── Screen ─────────────────────────────────────────────────

export default function HomeScreen({ onStartRun }: { onStartRun: () => void }) {
  const { profile } = useProfile();
  const { dbVersion, calibration } = useRun();
  const [runs, setRuns] = useState<RunHistoryItem[]>([]);
  const [pbPace, setPbPace] = useState<number | null>(null);
  const [races, setRaces] = useState<RaceSummary | null>(null);
  const [peers, setPeers] = useState<DBPeer[]>([]);
  const [open, setOpen] = useState<RunHistoryItem | null>(null);
  const [showExplain, setShowExplain] = useState(false);

  const load = useCallback(async () => {
    try {
      const [h, pb, rs, ps] = await Promise.all([getRunHistory(), getPBSession('default-route'), getRaceSummary(), getPeers()]);
      setRuns(h);
      setPbPace(pb?.avg_pace_s_per_km ?? null);
      setRaces(rs);
      setPeers(ps);
    } catch (e) {
      console.error('[Home] load failed:', e);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load, dbVersion]);

  const now = Date.now();
  const last = useMemo(() => pickLastRun(runs), [runs]);
  const week = useMemo(() => weekStats(runs, now), [runs, now]);
  const trend = useMemo(() => npiTrend(runs, 10, CALIBRATION_RUNS), [runs]);
  const totalDist = useMemo(() => runs.reduce((a, r) => a + r.distanceM, 0), [runs]);
  const lastScored = useMemo(() => [...trend].pop() ?? null, [trend]);
  const lastValid = useMemo(
    () => [...runs].filter(r => r.paceSPerKm).sort((a, b) => b.startTime - a.startTime)[0] ?? null,
    [runs],
  );
  const lastFriend = useMemo(() => [...peers].sort((a, b) => b.last_seen - a.last_seen)[0] ?? null, [peers]);

  // Hero values (shown once calibrated)
  const npi = lastScored?.npi ?? null;
  const npiStatus = npi !== null ? getNPIStatus(npi) : null;
  const rii = pbPace && lastValid?.paceSPerKm ? calculateRII(pbPace, lastValid.paceSPerKm) : null;
  const riiStatus = rii !== null ? getRIIStatus(rii) : null;
  const vsBase = relativeToBaseline(calibration.baselinePace, lastValid?.paceSPerKm ?? null);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <View style={{ paddingBottom: 24 }}>
      <Text style={styles.greeting}>
        {greeting}, {profile.name}
      </Text>

      {/* 1. Dual-metric hero (or baseline progress) */}
      {calibration.calibrated ? (
        <View style={styles.hero}>
          <View style={styles.heroCell}>
            <Text style={styles.heroLabel}>NPI</Text>
            <Text style={[styles.heroValue, { color: npiStatus?.color ?? C.dim }]}>{npi !== null ? formatNPI(npi) : '—'}</Text>
            <Text style={[styles.heroSub, { color: npiStatus?.color ?? C.faint }]}>{npiStatus?.label ?? 'no score yet'}</Text>
            <Text style={styles.heroHint}>vs the model for you</Text>
          </View>
          <View style={styles.heroDivider} />
          <View style={styles.heroCell}>
            <Text style={styles.heroLabel}>RII</Text>
            <Text style={[styles.heroValue, { color: riiStatus?.color ?? C.dim }]}>{rii !== null ? rii.toFixed(2) : '—'}</Text>
            <Text style={styles.heroSub}>vs PB {fmtPace(pbPace)}/km</Text>
            <Text style={[styles.heroHint, { color: vsBase !== null && vsBase >= 1 ? SOLO_COLOR : C.amber }]}>
              {formatVsBaseline(vsBase)}
            </Text>
          </View>
        </View>
      ) : (
        <View style={[styles.card, { borderColor: C.amber + '60', borderWidth: 1 }]}>
          <BaselineProgress recorded={calibration.runs} />
        </View>
      )}

      {/* 2. Last run */}
      {last ? (
        <LastRunCard run={last} onOpen={() => setOpen(last)} />
      ) : (
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>LAST RUN</Text>
          <Text style={styles.dimText}>No runs yet — your first run will appear here.</Text>
        </View>
      )}

      {/* 3. This week */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>THIS WEEK</Text>
        <View style={styles.weekRow}>
          <View style={styles.weekCell}>
            <Text style={styles.weekValue}>{week.runs}</Text>
            <Text style={styles.weekLabel}>runs</Text>
          </View>
          <View style={styles.weekCell}>
            <Text style={styles.weekValue}>{(week.distanceM / 1000).toFixed(1)}</Text>
            <Text style={styles.weekLabel}>km</Text>
          </View>
          <View style={styles.weekCell}>
            <Text style={styles.weekValue}>{fmtPace(week.bestPace)}</Text>
            <Text style={styles.weekLabel}>best /km</Text>
          </View>
        </View>
      </View>

      {/* 4. NPI trend */}
      <View style={styles.card}>
        <Text style={styles.sectionLabel}>
          {trend.length >= 2 ? `NPI TREND · LAST ${trend.length} SCORED RUNS` : 'NPI TREND'}
        </Text>
        {trend.length >= 2 ? (
          <NpiTrendChart points={trend} />
        ) : (
          <Text style={styles.dimText}>
            {calibration.calibrated
              ? 'Your NPI trend appears after two scored runs.'
              : `Scores start after run ${CALIBRATION_RUNS}; the trend builds from there.`}
          </Text>
        )}
      </View>

      {/* 5. Totals, one line */}
      <Text style={styles.totals}>
        PB {fmtPace(pbPace)}/km · {runs.length} run{runs.length === 1 ? '' : 's'} · {(totalDist / 1000).toFixed(1)} km total
      </Text>

      {/* 8. Friends */}
      {(races && races.races > 0) || lastFriend ? (
        <View style={[styles.card, { borderColor: PEER_COLOR + '50', borderWidth: 1 }]}>
          <Text style={[styles.sectionLabel, { color: PEER_COLOR }]}>🔗 FRIENDS</Text>
          {races && races.races > 0 && (
            <Text style={styles.friendLine}>
              {races.races} race{races.races === 1 ? '' : 's'} · {races.wins} win{races.wins === 1 ? '' : 's'} · {races.losses} loss
              {races.losses === 1 ? '' : 'es'}
            </Text>
          )}
          {lastFriend && (
            <Text style={styles.dimText}>
              Last synced with {lastFriend.alias ?? 'a friend'} · {fmtWhen(lastFriend.last_seen)}
            </Text>
          )}
        </View>
      ) : null}

      {/* 6. Start */}
      <TouchableOpacity style={styles.startBtn} onPress={onStartRun} activeOpacity={0.85}>
        <Text style={styles.startText}>▶  START RUN</Text>
      </TouchableOpacity>

      {/* 7. Explainers, folded */}
      <TouchableOpacity onPress={() => setShowExplain(v => !v)} style={styles.explainToggle} activeOpacity={0.7}>
        <Text style={styles.explainToggleText}>ⓘ What do NPI and RII mean? {showExplain ? '▲' : '▼'}</Text>
      </TouchableOpacity>
      {showExplain && (
        <View style={styles.card}>
          <Text style={styles.explainTitle}>NPI — fair score between people</Text>
          <Text style={styles.dimText}>
            (Expected pace − your pace) / σ. The expected pace comes from the model for your age, BMI, sex, altitude and
            distance. +1.0 means one standard deviation faster than expected for you.
          </Text>
          <Text style={[styles.explainTitle, { marginTop: 12 }]}>RII — your own progress</Text>
          <Text style={styles.dimText}>PB pace / your pace. Above 1.00 = faster than your personal best.</Text>
          <Text style={[styles.explainTitle, { marginTop: 12 }]}>Baseline</Text>
          <Text style={styles.dimText}>
            Your first {CALIBRATION_RUNS} runs set a baseline; scores are shown from run {CALIBRATION_RUNS}, with your pace
            compared to the baseline.
          </Text>
          <Text style={[styles.explainTitle, { marginTop: 12 }]}>Privacy</Text>
          <Text style={styles.dimText}>Runs and routes stay on this phone. Friends only receive scores and times, never locations.</Text>
        </View>
      )}

      <Modal visible={open !== null} animationType="slide" onRequestClose={() => setOpen(null)}>
        {open && <RunDetail run={open} baselinePace={calibration.baselinePace} onClose={() => setOpen(null)} />}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  greeting: { color: C.text, fontSize: 24, fontWeight: '700', marginBottom: 12 },
  card: { backgroundColor: C.surface, borderRadius: 16, padding: 14, marginBottom: 12 },
  sectionLabel: { color: C.dim, fontSize: 11, fontWeight: '800', letterSpacing: 1.4, marginBottom: 8 },
  dimText: { color: C.dim, fontSize: 13, lineHeight: 19 },
  faintText: { color: C.faint, fontSize: 12 },
  // hero
  hero: { flexDirection: 'row', backgroundColor: C.surface, borderRadius: 18, paddingVertical: 16, marginBottom: 12 },
  heroCell: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  heroDivider: { width: StyleSheet.hairlineWidth, backgroundColor: C.separator },
  heroLabel: { color: C.dim, fontSize: 12, fontWeight: '800', letterSpacing: 2 },
  heroValue: { fontSize: 42, fontWeight: '800', fontVariant: ['tabular-nums'], marginTop: 2 },
  heroSub: { color: C.dim, fontSize: 13, fontWeight: '600' },
  heroHint: { color: C.faint, fontSize: 12, marginTop: 2 },
  // last run
  cardHeadRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  tag: { fontSize: 11, fontWeight: '800', letterSpacing: 0.5, maxWidth: '45%' },
  lastRow: { flexDirection: 'row', gap: 12 },
  miniMap: { width: 130, height: 110, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0a0e1a' },
  miniMapEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  lastBig: { color: C.text, fontSize: 26, fontWeight: '800' },
  lastSub: { color: C.text, fontSize: 14, marginTop: 2 },
  linkText: { color: C.dim, fontSize: 12, marginTop: 6 },
  // week
  weekRow: { flexDirection: 'row' },
  weekCell: { flex: 1, alignItems: 'center' },
  weekValue: { color: C.text, fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'] },
  weekLabel: { color: C.dim, fontSize: 12 },
  // trend
  trendChart: { flexDirection: 'row', gap: 8, position: 'relative', paddingVertical: 2, justifyContent: 'center' },
  trendCol: { flex: 1, maxWidth: 26 },
  trendBar: { width: '100%', borderRadius: 3 },
  zeroLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: C.separator },
  trendAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  trendAxisText: { color: C.faint, fontSize: 10 },
  // totals / friends
  totals: { color: C.dim, fontSize: 13, textAlign: 'center', marginBottom: 12, fontVariant: ['tabular-nums'] },
  friendLine: { color: C.text, fontSize: 16, fontWeight: '700', marginBottom: 4 },
  // start
  startBtn: { backgroundColor: SOLO_COLOR, borderRadius: 16, paddingVertical: 18, alignItems: 'center', marginTop: 4, marginBottom: 8 },
  startText: { color: '#000', fontSize: 18, fontWeight: '900', letterSpacing: 2 },
  // explain
  explainToggle: { paddingVertical: 12, alignItems: 'center' },
  explainToggleText: { color: C.dim, fontSize: 14, fontWeight: '600' },
  explainTitle: { color: C.text, fontSize: 14, fontWeight: '700', marginBottom: 4 },
});
