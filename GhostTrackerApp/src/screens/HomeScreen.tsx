/**
 * Home — the dual-metric dashboard (thesis Table A.1), revamped:
 *   greeting · week strip (days run in lime) · "Your progress" grid (last
 *   run map with time/pace, NPI and RII tiles) · recent runs · friends ·
 *   NPI trend · explainers. During the first 5 runs the score tiles show the
 *   baseline progress instead (5-run calibration).
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
  weekStart,
  type RunHistoryItem,
} from '../../../GhostTracker/src/core/history/runHistory';
import { CALIBRATION_RUNS, formatVsBaseline, relativeToBaseline } from '../../../GhostTracker/src/core/fairness/calibration';
import { formatNPI, getNPIStatus } from '../core/npiEngine';
import { calculateRII, getRIIStatus } from '../core/algorithms';
import { FinishedMap } from '../components/RunMap';
import Avatar from '../components/Avatar';
import { RunDetail } from './HistoryScreen';
import { Card, GlassCard, Icon, IconButton, IconCircle, SectionTitle, StatTile, T } from '../components/ui';
import { colors, fonts, radius, runColor, space } from '../theme/tokens';

// ── formatting ─────────────────────────────────────────────

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
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today · ${time}`;
  if (new Date(today.getTime() - 86_400_000).toDateString() === d.toDateString()) return `Yesterday · ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${time}`;
}

// ── week strip ─────────────────────────────────────────────

function WeekStrip({ runs }: { runs: RunHistoryItem[] }) {
  const start = weekStart(Date.now());
  const todayIdx = (new Date().getDay() + 6) % 7;
  const days = Array.from({ length: 7 }, (_, i) => {
    const dayStart = start + i * 86_400_000;
    const ran = runs.some(r => r.runNo !== null && r.startTime >= dayStart && r.startTime < dayStart + 86_400_000);
    return { label: 'MTWTFSS'[i], date: new Date(dayStart).getDate(), ran, today: i === todayIdx };
  });
  return (
    <View style={styles.week}>
      {days.map((d, i) => (
        <View key={i} style={[styles.day, d.ran && styles.dayRan, d.today && !d.ran && styles.dayToday]}>
          <Text style={[styles.dayLabel, d.ran && { color: colors.onAccent }]}>{d.label}</Text>
          <Text style={[styles.dayDate, d.ran && { color: colors.onAccent }]}>{d.date}</Text>
          <View style={styles.dayIcon}>{d.ran ? <Icon name="footsteps" size={12} color={colors.onAccent} /> : null}</View>
        </View>
      ))}
    </View>
  );
}

// ── last-run map tile ──────────────────────────────────────

function LastRunTile({ run, onOpen }: { run: RunHistoryItem; onOpen: () => void }) {
  const mapRef = useRef<any>(null);
  const [route, setRoute] = useState<{ latitude: number; longitude: number }[] | null>(null);
  const color = runColor(isPeerRun(run));
  useEffect(() => {
    getSessionTelemetry(run.sessionId)
      .then(pts => setRoute(pts.map(p => ({ latitude: p.latitude, longitude: p.longitude }))))
      .catch(() => setRoute([]));
  }, [run.sessionId]);
  const region =
    route && route.length > 0
      ? { latitude: route[0].latitude, longitude: route[0].longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 }
      : { latitude: 6.8448, longitude: 79.8999, latitudeDelta: 0.01, longitudeDelta: 0.01 };

  return (
    <TouchableOpacity style={styles.mapTile} onPress={onOpen} activeOpacity={0.9}>
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {route && route.length >= 2 ? (
          <FinishedMap mapRef={mapRef} initialRegion={region} routeCoords={route} color={color} />
        ) : (
          <View style={styles.mapEmpty} />
        )}
      </View>
      <View style={styles.bubble}>
        <Text style={styles.bubbleText}>{(run.distanceM / 1000).toFixed(2)} Km</Text>
      </View>
      {run.peers.length > 0 && (
        <View style={[styles.peerTag, { backgroundColor: colors.peer }]}>
          <Icon name="link" size={12} color={colors.onAccent} />
          <Text style={styles.peerTagText} numberOfLines={1}>{run.peers[0].alias}</Text>
        </View>
      )}
      <View style={styles.mapStats}>
        <View style={styles.glass}>
          <T variant="caption">Time</T>
          <Text style={styles.glassValue}>{fmtDuration(run.durationS)}</Text>
        </View>
        <View style={styles.glass}>
          <T variant="caption">Pace</T>
          <Text style={styles.glassValue}>{fmtPace(run.paceSPerKm)}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ── NPI trend ──────────────────────────────────────────────

function NpiTrendChart({ points }: { points: { npi: number }[] }) {
  const maxAbs = Math.max(1, ...points.map(p => Math.abs(p.npi)));
  const half = 34;
  return (
    <View>
      <View style={styles.trendChart}>
        {points.map((p, i) => {
          const h = Math.max(3, (Math.abs(p.npi) / maxAbs) * half);
          const color = colors.npi;
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
        <T variant="caption">older</T>
        <T variant="caption">0 = as the model expects</T>
        <T variant="caption">latest</T>
      </View>
    </View>
  );
}

// ── screen ─────────────────────────────────────────────────

export default function HomeScreen({ onStartRun, onOpenProfile }: { onStartRun: () => void; onOpenProfile?: () => void }) {
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

  const last = useMemo(() => pickLastRun(runs), [runs]);
  const recent = useMemo(() => [...runs].sort((a, b) => b.startTime - a.startTime).slice(0, 3), [runs]);
  const trend = useMemo(() => npiTrend(runs, 10, CALIBRATION_RUNS), [runs]);
  const lastScored = trend.length ? trend[trend.length - 1] : null;
  const prevScored = trend.length > 1 ? trend[trend.length - 2] : null;
  const lastValid = useMemo(() => [...runs].filter(r => r.paceSPerKm).sort((a, b) => b.startTime - a.startTime)[0] ?? null, [runs]);
  const lastFriend = useMemo(() => [...peers].sort((a, b) => b.last_seen - a.last_seen)[0] ?? null, [peers]);

  const npi = lastScored?.npi ?? null;
  const npiStatus = npi !== null ? getNPIStatus(npi) : null;
  const npiChange = npi !== null && prevScored ? npi - prevScored.npi : null;
  const rii = pbPace && lastValid?.paceSPerKm ? calculateRII(pbPace, lastValid.paceSPerKm) : null;
  const riiStatus = rii !== null ? getRIIStatus(rii) : null;
  const vsBase = relativeToBaseline(calibration.baselinePace, lastValid?.paceSPerKm ?? null);
  const left = calibration.needed - calibration.runs;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <View style={{ paddingBottom: space.xxl }}>
      {/* Header */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <T variant="label">{greeting}, {profile.name}</T>
          <T variant="hero">{runs.length === 0 ? 'Start your first run' : 'Ready for a run?'}</T>
        </View>
        <TouchableOpacity onPress={onOpenProfile} activeOpacity={0.8} accessibilityLabel="Open profile">
          <Avatar name={profile.name} uri={profile.avatarUri} size={46} />
        </TouchableOpacity>
      </View>

      <WeekStrip runs={runs} />

      {/* Your progress */}
      <SectionTitle title="Your progress" />
      <View style={styles.grid}>
        <View style={{ flex: 1.15 }}>
          {last ? (
            <LastRunTile run={last} onOpen={() => setOpen(last)} />
          ) : (
            <Card style={[styles.mapTile, styles.centered]} onPress={onStartRun}>
              <IconCircle light size={52}>
                <Icon name="footsteps-outline" size={24} color={colors.onAccent} />
              </IconCircle>
              <T variant="label" style={{ marginTop: space.md, textAlign: 'center' }}>Your last run will show here</T>
            </Card>
          )}
        </View>
        <View style={{ flex: 1, gap: space.md }}>
          {calibration.calibrated ? (
            <>
              <StatTile
                label="NPI"
                value={npi !== null ? formatNPI(npi) : '—'}
                valueColor={npiStatus ? colors.npi : undefined}
                sub={
                  npiChange !== null
                    ? `${npiChange >= 0 ? '↑' : '↓'} ${Math.abs(npiChange).toFixed(2)} vs previous run`
                    : npiStatus?.label ?? 'vs the model for you'
                }
                subColor={npiChange !== null ? (npiChange >= 0 ? colors.accent : colors.textDim) : undefined}
              />
              <StatTile
                label="RII"
                value={rii !== null ? rii.toFixed(2) : '—'}
                valueColor={undefined}
                sub={formatVsBaseline(vsBase)}
                subColor={vsBase !== null ? (vsBase >= 1 ? colors.accent : colors.textDim) : undefined}
              />
            </>
          ) : (
            <>
              <StatTile
                label="Baseline"
                value={`${calibration.runs}/${calibration.needed}`}
                valueColor={colors.accent}
                sub={`${left} more run${left === 1 ? '' : 's'} to unlock NPI`}
              />
              <StatTile label="Best pace" value={fmtPace(pbPace)} unit="/km" sub={`${runs.length} run${runs.length === 1 ? '' : 's'} so far`} />
            </>
          )}
        </View>
      </View>

      {/* Recent runs */}
      {recent.length > 0 && (
        <>
          <SectionTitle title="Recent runs" />
          {recent.map(r => {
            const peer = isPeerRun(r);
            return (
              <Card key={r.sessionId} onPress={() => setOpen(r)} style={styles.runRow}>
                <IconCircle light size={48}>
                  <Icon name={peer ? 'link' : 'footsteps-outline'} size={20} color={colors.onAccent} />
                </IconCircle>
                <View style={{ flex: 1 }}>
                  <Text style={styles.runTitle}>
                    {(r.distanceM / 1000).toFixed(2)}
                    <Text style={styles.runUnit}> km</Text>
                    {'  '}
                    {fmtDuration(r.durationS)}
                  </Text>
                  <T variant="label" numberOfLines={1}>
                    {fmtWhen(r.startTime)} · {peer ? (r.raceOutcome ? `race vs ${r.peers[0].alias}` : `with ${r.peers[0].alias}`) : 'solo'}
                  </T>
                </View>
                {/* the card handles the tap; the chevron uses the shared icon-button look */}
                <IconButton icon="chevron-forward" size="sm" accessibilityLabel="Open run" />
              </Card>
            );
          })}
        </>
      )}

      {/* Friends */}
      {(races && races.races > 0) || lastFriend ? (
        <>
          <SectionTitle title="Friends" />
          <GlassCard accent="neutral">
            {races && races.races > 0 && (
              <Text style={styles.friendLine}>
                {races.races} race{races.races === 1 ? '' : 's'} · {races.wins} win{races.wins === 1 ? '' : 's'} · {races.losses} loss
                {races.losses === 1 ? '' : 'es'}
              </Text>
            )}
            {lastFriend && (
              <T variant="label">
                Last synced with {lastFriend.alias ?? 'a friend'} · {fmtWhen(lastFriend.last_seen)}
              </T>
            )}
          </GlassCard>
        </>
      ) : null}

      {/* NPI trend */}
      <SectionTitle title="NPI trend" />
      <Card>
        {trend.length >= 2 ? (
          <NpiTrendChart points={trend} />
        ) : (
          <T variant="label">
            {calibration.calibrated
              ? 'Your NPI trend appears after two scored runs.'
              : `Scores start after run ${CALIBRATION_RUNS}; the trend builds from there.`}
          </T>
        )}
      </Card>

      {/* Explainers */}
      <TouchableOpacity onPress={() => setShowExplain(v => !v)} style={styles.explainToggle} activeOpacity={0.7}>
        <T variant="label" style={{ fontFamily: fonts.semibold }}>
          What do NPI and RII mean?
        </T>
        <Icon name={showExplain ? 'chevron-up' : 'chevron-down'} size={16} />
      </TouchableOpacity>
      {showExplain && (
        <Card>
          <T variant="body" style={styles.explainTitle}>NPI — fair score between people</T>
          <T variant="label">
            (Expected pace − your pace) / σ. The expected pace comes from the model for your age, BMI, sex, altitude and
            distance. +1.0 means one standard deviation faster than expected for you.
          </T>
          <T variant="body" style={[styles.explainTitle, { marginTop: space.md }]}>RII — your own progress</T>
          <T variant="label">PB pace / your pace. Above 1.00 = faster than your personal best.</T>
          <T variant="body" style={[styles.explainTitle, { marginTop: space.md }]}>Baseline</T>
          <T variant="label">
            Your first {CALIBRATION_RUNS} runs set a baseline; scores are shown from run {CALIBRATION_RUNS}, with your pace
            compared to the baseline.
          </T>
          <T variant="body" style={[styles.explainTitle, { marginTop: space.md }]}>Privacy</T>
          <T variant="label">Runs and routes stay on this phone. Friends only receive scores and times, never locations.</T>
        </Card>
      )}

      <Modal visible={open !== null} animationType="slide" onRequestClose={() => setOpen(null)}>
        {open && <RunDetail run={open} baselinePace={calibration.baselinePace} onClose={() => setOpen(null)} />}
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.xl, marginBottom: space.lg },
  week: { flexDirection: 'row', justifyContent: 'space-between', gap: 6 },
  day: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dayRan: { backgroundColor: colors.accent, borderColor: colors.accent },
  dayToday: { borderColor: colors.accent },
  dayLabel: { fontFamily: fonts.semibold, fontSize: 11, color: colors.textDim },
  dayDate: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, marginTop: 2 },
  dayIcon: { marginTop: 2, height: 16, alignItems: 'center', justifyContent: 'center' },
  grid: { flexDirection: 'row', gap: space.md },
  mapTile: { height: 300, borderRadius: radius.lg, overflow: 'hidden', backgroundColor: colors.surface },
  mapEmpty: { flex: 1, backgroundColor: colors.surface },
  centered: { alignItems: 'center', justifyContent: 'center' },
  bubble: {
    position: 'absolute',
    top: space.lg,
    alignSelf: 'center',
    backgroundColor: colors.white,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  bubbleText: { fontFamily: fonts.bold, fontSize: 13, color: colors.onAccent },
  peerTag: {
    position: 'absolute',
    top: 56,
    left: space.md,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: '80%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  peerTagText: { fontFamily: fonts.bold, fontSize: 11, color: colors.onAccent },
  mapStats: { position: 'absolute', left: space.sm, right: space.sm, bottom: space.sm, flexDirection: 'row', gap: space.sm },
  glass: { flex: 1, backgroundColor: colors.overlay, borderRadius: radius.md, padding: space.md },
  glassValue: { fontFamily: fonts.semibold, fontSize: 18, color: colors.text, marginTop: 2, fontVariant: ['tabular-nums'] },
  runRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, marginBottom: space.md, paddingVertical: space.md },
  runTitle: { fontFamily: fonts.semibold, fontSize: 18, color: colors.text },
  runUnit: { fontFamily: fonts.medium, fontSize: 13, color: colors.textDim },
  friendLine: { fontFamily: fonts.bold, fontSize: 16, color: colors.text, marginBottom: 4 },
  trendChart: { flexDirection: 'row', gap: 8, position: 'relative', justifyContent: 'center' },
  trendCol: { flex: 1, maxWidth: 26 },
  trendBar: { width: '100%', borderRadius: 4 },
  zeroLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: colors.border },
  trendAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.sm },
  explainToggle: { paddingVertical: space.lg, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6 },
  explainTitle: { fontFamily: fonts.bold, marginBottom: 4 },
});
