/**
 * Connected race UI (Phase C+): banner, pre-start card, live card,
 * distance picker and results. Purple + 🔗 marks everything connected;
 * on the map you are blue and the friend is orange.
 */

import React from 'react';
import { Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import {
  useRace,
  formatRaceTime,
  RACE_COLOR,
  RACE_ME_COLOR,
  RACE_FRIEND_COLOR,
  RACE_SYMBOL,
} from '../context/RaceContext';
import { RACE_DISTANCES_M, type RaceRunner, type RaceState } from '../../../GhostTracker/src/core/race';
import { getRaceResults, getRaceSummary, type DBRaceResult, type RaceSummary } from '../data/database';

const C = {
  surface: '#1C1C1F',
  elevated: '#2A2A2E',
  separator: '#2E2E33',
  muted: '#8E8E93',
  green: '#C6F432',
  red: '#FF3B30',
};

function formatPace(sPerKm: number | null): string {
  if (sPerKm === null || !isFinite(sPerKm) || sPerKm <= 0) return '--:--';
  return `${formatRaceTime(sPerKm)} /km`;
}

function statusText(r: RaceRunner, stale: boolean): string {
  if (stale) return 'Reconnecting…';
  switch (r.status) {
    case 'not-started':
      return 'Waiting to start';
    case 'running':
      return 'Running';
    case 'finished':
      return `Finished · ${formatRaceTime(r.finishTimeS)}`;
    case 'dnf':
      return 'Did not finish';
  }
}

function statusColor(r: RaceRunner, stale: boolean): string {
  if (stale) return '#FF9F0A';
  return r.status === 'running' ? C.green : r.status === 'finished' ? RACE_COLOR : r.status === 'dnf' ? C.red : C.muted;
}

/** "You're 120 m ahead" / "Jayavi is 0:15 ahead". */
export function gapLines(race: RaceState, gap: { distanceGapM: number | null; timeGapS: number | null }): string[] {
  const lines: string[] = [];
  const name = race.friendAlias;
  if (race.me.status === 'not-started' || race.friend.status === 'not-started') return lines;
  if (gap.distanceGapM !== null && Math.abs(gap.distanceGapM) >= 1) {
    const m = Math.round(Math.abs(gap.distanceGapM));
    lines.push(gap.distanceGapM > 0 ? `You're ${m} m ahead` : `${name} is ${m} m ahead`);
  } else if (gap.distanceGapM !== null) {
    lines.push('Level');
  }
  if (gap.timeGapS !== null && Math.abs(gap.timeGapS) >= 1) {
    const t = formatRaceTime(Math.abs(gap.timeGapS));
    lines.push(gap.timeGapS > 0 ? `You're ${t} ahead` : `${name} is ${t} ahead`);
  }
  return lines;
}

// ── Banner (top of every screen) ─────────────────────────

export function RaceBanner() {
  const { banner } = useRace();
  if (!banner) return null;
  return (
    <View pointerEvents="none" style={styles.bannerWrap}>
      <View style={styles.banner}>
        <Text style={styles.bannerText}>{banner.text}</Text>
      </View>
    </View>
  );
}

// ── Distance picker (in the Connect-with-a-friend sheet) ──

export function RaceDistancePicker({ onPick }: { onPick: (targetM: number) => void }) {
  return (
    <View style={styles.pickerRow}>
      {RACE_DISTANCES_M.map(m => (
        <TouchableOpacity key={m} style={styles.pickerItem} onPress={() => onPick(m)}>
          <Text style={styles.pickerText}>{m / 1000} km</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ── Before I start (idle Run screen) ─────────────────────

export function RaceSetupCard() {
  const { race, friendStale, cancelRace } = useRace();
  if (!race || race.phase === 'done' || race.phase === 'cancelled') return null;
  if (race.me.status !== 'not-started') return null;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>
          {RACE_SYMBOL} RACE · {race.targetM / 1000} KM
        </Text>
        <Text style={styles.cardSub}>{race.createdBy === 'me' ? 'Set by you' : `Set by ${race.friendAlias}`}</Text>
      </View>
      <RunnerRow label="You" color={RACE_ME_COLOR} text="Press START to begin" textColor={C.muted} />
      <RunnerRow
        label={race.friendAlias}
        color={RACE_FRIEND_COLOR}
        text={
          race.friend.status === 'running' && !friendStale
            ? `Running · ${(race.friend.distanceM / 1000).toFixed(2)} km · ${formatRaceTime(race.friend.elapsedS)}`
            : statusText(race.friend, friendStale)
        }
        textColor={statusColor(race.friend, friendStale)}
      />
      <Text style={styles.hint}>
        Time limit {Math.round(race.timeLimitS / 60)} min from your start. You can start before or after {race.friendAlias}: each
        runner's clock starts when they press START.
      </Text>
      <TouchableOpacity style={styles.cancelBtn} onPress={cancelRace}>
        <Text style={styles.cancelText}>Cancel race</Text>
      </TouchableOpacity>
    </View>
  );
}

// ── While running ────────────────────────────────────────

export function RaceLiveCard() {
  const { race, gap, friendStale, cancelRace } = useRace();
  if (!race || race.phase === 'cancelled' || race.me.status === 'not-started') return null;
  const lines = gap ? gapLines(race, gap) : [];
  const meLeads = gap?.distanceGapM !== null && gap?.distanceGapM !== undefined && gap.distanceGapM >= 0;

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>
          {RACE_SYMBOL} VS {race.friendAlias.toUpperCase()} · {race.targetM / 1000} KM
        </Text>
      </View>

      {lines.length > 0 ? (
        <View style={{ marginBottom: 10 }}>
          {lines.map((l, i) => (
            <Text key={i} style={[i === 0 ? styles.gapMain : styles.gapSub, { color: meLeads ? C.green : RACE_FRIEND_COLOR }]}>
              {l}
            </Text>
          ))}
        </View>
      ) : null}

      <StatsRow name="You" color={RACE_ME_COLOR} r={race.me} stale={false} target={race.targetM} />
      <StatsRow name={race.friendAlias} color={RACE_FRIEND_COLOR} r={race.friend} stale={friendStale} target={race.targetM} />

      {race.phase !== 'done' && (
        <TouchableOpacity style={styles.cancelBtn} onPress={cancelRace}>
          <Text style={styles.cancelText}>Cancel race</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/**
 * Compact race summary for the running screen: who leads and by how much,
 * plus both runners' progress, in little vertical space so the map and the
 * big numbers stay visible.
 */
export function RaceStrip() {
  const { race, gap, friendStale, cancelRace } = useRace();
  if (!race || race.phase === 'cancelled' || race.me.status === 'not-started') return null;
  const lines = gap ? gapLines(race, gap) : [];
  const meLeads = gap?.distanceGapM !== null && gap?.distanceGapM !== undefined && gap.distanceGapM >= 0;
  const bar = (r: RaceRunner, color: string, name: string, stale: boolean) => (
    <View style={{ flex: 1 }}>
      <View style={styles.stripRow}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.stripName} numberOfLines={1}>{name}</Text>
        <Text style={[styles.stripDist, { color: statusColor(r, stale) }]}>
          {r.status === 'finished' ? '🏁' : r.status === 'dnf' ? 'DNF' : stale ? '…' : `${(r.distanceM / 1000).toFixed(2)}`}
        </Text>
      </View>
      <View style={styles.progressTrack}>
        <View
          style={[styles.progressFill, { width: `${Math.max(0, Math.min(1, r.distanceM / race.targetM)) * 100}%`, backgroundColor: color }]}
        />
      </View>
    </View>
  );
  return (
    <View style={styles.strip}>
      <View style={styles.stripHeader}>
        <Text style={styles.stripTitle}>
          {RACE_SYMBOL} VS {race.friendAlias.toUpperCase()} · {race.targetM / 1000} KM
        </Text>
        {race.phase !== 'done' && (
          <TouchableOpacity onPress={cancelRace} hitSlop={10}>
            <Text style={styles.stripCancel}>Cancel</Text>
          </TouchableOpacity>
        )}
      </View>
      {lines.length > 0 && (
        <Text style={[styles.stripGap, { color: meLeads ? C.green : RACE_FRIEND_COLOR }]} numberOfLines={1}>
          {lines[0]}
        </Text>
      )}
      <View style={{ flexDirection: 'row', gap: 12 }}>
        {bar(race.me, RACE_ME_COLOR, 'You', false)}
        {bar(race.friend, RACE_FRIEND_COLOR, race.friendAlias, friendStale)}
      </View>
    </View>
  );
}

function RunnerRow({ label, color, text, textColor }: { label: string; color: string; text: string; textColor: string }) {
  return (
    <View style={styles.runnerRow}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.runnerName}>{label}</Text>
      <Text style={[styles.runnerStatus, { color: textColor }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

function StatsRow({ name, color, r, stale, target }: { name: string; color: string; r: RaceRunner; stale: boolean; target: number }) {
  const progress = Math.max(0, Math.min(1, r.distanceM / target));
  return (
    <View style={{ marginBottom: 10 }}>
      <View style={styles.runnerRow}>
        <View style={[styles.dot, { backgroundColor: color }]} />
        <Text style={styles.runnerName}>{name}</Text>
        <Text style={[styles.runnerStatus, { color: statusColor(r, stale) }]}>{statusText(r, stale)}</Text>
      </View>
      {r.status !== 'not-started' && (
        <>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress * 100}%`, backgroundColor: color }]} />
          </View>
          <Text style={styles.stats}>
            {(r.distanceM / 1000).toFixed(2)} km · {formatRaceTime(r.elapsedS)} · {formatPace(r.avgPaceSPerKm)}
          </Text>
        </>
      )}
    </View>
  );
}

// ── Leaderboard section ──────────────────────────────────

export function RaceLeaderboardCard({ dbVersion }: { dbVersion: number }) {
  const [rows, setRows] = React.useState<DBRaceResult[]>([]);
  const [summary, setSummary] = React.useState<RaceSummary | null>(null);

  React.useEffect(() => {
    Promise.all([getRaceResults(), getRaceSummary()])
      .then(([r, s]) => {
        setRows(r);
        setSummary(s);
      })
      .catch(e => console.error('[Race] Leaderboard load failed:', e));
  }, [dbVersion]);

  if (!summary || summary.races === 0) return null;
  const bests = Object.entries(summary.bestTimeByDistance).sort((a, b) => Number(a[0]) - Number(b[0]));

  return (
    <View style={[styles.card, { marginTop: 0, marginBottom: 12 }]}>
      <Text style={styles.cardTitle}>{RACE_SYMBOL} CONNECTED RACES</Text>
      <View style={styles.summaryRow}>
        <Summary label="RACES" value={String(summary.races)} />
        <Summary label="WINS" value={String(summary.wins)} color={C.green} />
        <Summary label="LOSSES" value={String(summary.losses)} color={C.red} />
        {summary.ties > 0 && <Summary label="TIES" value={String(summary.ties)} />}
      </View>
      {bests.length > 0 && (
        <Text style={styles.hint}>
          Best: {bests.map(([m, s]) => `${Number(m) / 1000} km ${formatRaceTime(s)}`).join(' · ')}
        </Text>
      )}
      {rows.slice(0, 5).map(r => (
        <View key={r.id} style={styles.raceRow}>
          <Text style={[styles.raceOutcome, { color: r.outcome === 'win' ? C.green : r.outcome === 'loss' ? C.red : C.muted }]}>
            {r.outcome === 'win' ? 'WIN' : r.outcome === 'loss' ? 'LOSS' : r.outcome === 'tie' ? 'TIE' : '—'}
          </Text>
          <Text style={styles.raceText} numberOfLines={1}>
            vs {r.friend_alias} · {r.target_m / 1000} km
          </Text>
          <Text style={styles.raceTimes}>
            {r.my_status === 'dnf' ? 'DNF' : formatRaceTime(r.my_time_s)} / {r.friend_status === 'dnf' ? 'DNF' : formatRaceTime(r.friend_time_s)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Summary({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[styles.summaryValue, color ? { color } : null]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

// ── Results ──────────────────────────────────────────────

export function RaceResultsModal() {
  const { race, result, showResults, dismissRace } = useRace();
  if (!race || !result || race.phase !== 'done') return null;

  const title =
    result.outcome === 'win'
      ? '🏆 You won!'
      : result.outcome === 'loss'
        ? `${race.friendAlias} won`
        : result.outcome === 'tie'
          ? "It's a tie!"
          : 'No winner';

  return (
    <Modal visible={showResults} transparent animationType="fade" onRequestClose={dismissRace}>
      <View style={styles.overlay}>
        <View style={styles.results}>
          <Text style={styles.resultsSymbol}>{RACE_SYMBOL}</Text>
          <Text style={styles.resultsTitle}>{title}</Text>
          <Text style={styles.resultsSub}>
            {race.targetM / 1000} km connected race vs {race.friendAlias}
          </Text>

          <View style={styles.resultsTable}>
            <View style={styles.resultsRow}>
              <Text style={styles.resultsHead} />
              <Text style={[styles.resultsHead, { color: RACE_ME_COLOR }]}>You</Text>
              <Text style={[styles.resultsHead, { color: RACE_FRIEND_COLOR }]}>{race.friendAlias}</Text>
            </View>
            <View style={styles.resultsRow}>
              <Text style={styles.resultsLabel}>Time</Text>
              <Text style={styles.resultsValue}>{race.me.status === 'dnf' ? 'DNF' : formatRaceTime(result.myTimeS)}</Text>
              <Text style={styles.resultsValue}>{race.friend.status === 'dnf' ? 'DNF' : formatRaceTime(result.friendTimeS)}</Text>
            </View>
            <View style={styles.resultsRow}>
              <Text style={styles.resultsLabel}>Avg pace</Text>
              <Text style={styles.resultsValue}>{formatPace(result.myPaceSPerKm)}</Text>
              <Text style={styles.resultsValue}>{formatPace(result.friendPaceSPerKm)}</Text>
            </View>
          </View>

          {result.differenceS !== null && (
            <Text style={styles.resultsDiff}>Difference: {formatRaceTime(result.differenceS)}</Text>
          )}
          <Text style={styles.resultsNote}>Saved to your leaderboard.</Text>

          <TouchableOpacity style={styles.doneBtn} onPress={dismissRace}>
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  strip: { borderWidth: 1, borderColor: RACE_COLOR + '80', backgroundColor: RACE_COLOR + '14', borderRadius: 20, padding: 10, marginBottom: 10 },
  stripHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  stripTitle: { color: RACE_COLOR, fontSize: 12, fontFamily: 'Urbanist_800ExtraBold', letterSpacing: 1 },
  stripCancel: { color: C.red, fontSize: 12, fontFamily: 'Urbanist_700Bold' },
  stripGap: { fontSize: 18, fontFamily: 'Urbanist_800ExtraBold', marginTop: 4, marginBottom: 6 },
  stripRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  stripName: { color: '#FFFFFF', fontSize: 12, fontFamily: 'Urbanist_700Bold', flex: 1 },
  stripDist: { fontSize: 12, fontFamily: 'Urbanist_700Bold', fontVariant: ['tabular-nums'] },
  bannerWrap: { position: 'absolute', top: 56, left: 12, right: 12, zIndex: 1000, alignItems: 'center' },
  banner: {
    backgroundColor: RACE_COLOR,
    borderRadius: 20,
    paddingVertical: 10,
    paddingHorizontal: 14,
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  bannerText: { color: '#FFFFFF', fontFamily: 'Urbanist_700Bold', fontSize: 14 },

  pickerRow: { flexDirection: 'row', marginTop: 8 },
  pickerItem: {
    flex: 1,
    marginRight: 6,
    borderWidth: 1,
    borderColor: RACE_COLOR,
    borderRadius: 10,
    paddingVertical: 8,
    alignItems: 'center',
  },
  pickerText: { color: RACE_COLOR, fontWeight: '700' },

  card: {
    alignSelf: 'stretch',
    marginTop: 14,
    backgroundColor: '#1C1C1FEE',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: RACE_COLOR,
    padding: 14,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  cardTitle: { color: RACE_COLOR, fontFamily: 'Urbanist_800ExtraBold', fontSize: 14, letterSpacing: 1 },
  cardSub: { fontFamily: 'Urbanist_400Regular', color: C.muted, fontSize: 12 },
  runnerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  runnerName: { color: '#FFFFFF', fontFamily: 'Urbanist_700Bold', fontSize: 14, marginRight: 8 },
  runnerStatus: { flex: 1, textAlign: 'right', fontSize: 13 },
  hint: { fontFamily: 'Urbanist_400Regular', color: C.muted, fontSize: 12, lineHeight: 16, marginTop: 4 },
  gapMain: { fontSize: 20, fontFamily: 'Urbanist_800ExtraBold' },
  gapSub: { fontSize: 14, fontFamily: 'Urbanist_600SemiBold', marginTop: 2 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: C.elevated, overflow: 'hidden', marginBottom: 4 },
  progressFill: { height: 6, borderRadius: 3 },
  stats: { fontFamily: 'Urbanist_400Regular', color: '#FFFFFF', fontSize: 13 },
  cancelBtn: { alignSelf: 'flex-end', marginTop: 8, paddingVertical: 6, paddingHorizontal: 10 },
  cancelText: { color: C.red, fontFamily: 'Urbanist_700Bold', fontSize: 13 },

  summaryRow: { flexDirection: 'row', marginVertical: 10 },
  summaryValue: { color: '#FFFFFF', fontSize: 22, fontFamily: 'Urbanist_800ExtraBold' },
  summaryLabel: { fontFamily: 'Urbanist_400Regular', color: C.muted, fontSize: 11, marginTop: 2, letterSpacing: 1 },
  raceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.separator,
  },
  raceOutcome: { width: 44, fontFamily: 'Urbanist_800ExtraBold', fontSize: 12 },
  raceText: { fontFamily: 'Urbanist_400Regular', flex: 1, color: '#FFFFFF', fontSize: 13 },
  raceTimes: { fontFamily: 'Urbanist_400Regular', color: C.muted, fontSize: 13 },

  overlay: { flex: 1, backgroundColor: '#0E0E10CC', justifyContent: 'center', padding: 20 },
  results: { backgroundColor: C.surface, borderRadius: 20, padding: 22, borderWidth: 1, borderColor: RACE_COLOR },
  resultsSymbol: { fontSize: 28, textAlign: 'center' },
  resultsTitle: { color: '#FFFFFF', fontSize: 26, fontFamily: 'Urbanist_800ExtraBold', textAlign: 'center', marginTop: 4 },
  resultsSub: { fontFamily: 'Urbanist_400Regular', color: C.muted, fontSize: 13, textAlign: 'center', marginTop: 4, marginBottom: 16 },
  resultsTable: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.separator },
  resultsRow: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.separator,
  },
  resultsHead: { flex: 1, color: C.muted, fontWeight: '700', textAlign: 'center' },
  resultsLabel: { flex: 1, color: C.muted },
  resultsValue: { flex: 1, color: '#FFFFFF', fontWeight: '700', textAlign: 'center' },
  resultsDiff: { color: RACE_COLOR, fontWeight: '700', textAlign: 'center', marginTop: 14 },
  resultsNote: { fontFamily: 'Urbanist_400Regular', color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 6 },
  doneBtn: { backgroundColor: RACE_COLOR, borderRadius: 12, paddingVertical: 12, alignItems: 'center', marginTop: 18 },
  doneText: { color: '#FFFFFF', fontFamily: 'Urbanist_800ExtraBold', fontSize: 16 },
});
