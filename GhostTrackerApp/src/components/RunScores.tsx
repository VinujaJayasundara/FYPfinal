/**
 * Scores for one run, following the 5-run baseline rule:
 *   - run too short (< 10 m): no scores
 *   - runs 1-4 (calibration): "Baseline: N of 5 runs recorded", no scores
 *   - run 5+: NPI (thesis: vs the model's expected pace for the profile),
 *     RII (thesis: vs PB) and pace relative to the 5-run baseline
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatNPI, getNPIStatus } from '../core/npiEngine';
import { getRIIStatus } from '../core/algorithms';
import {
  CALIBRATION_RUNS,
  formatVsBaseline,
  relativeToBaseline,
} from '../../../GhostTracker/src/core/fairness/calibration';

const C = {
  surface: '#1C1C1F',
  elevated: '#2A2A2E',
  accent: '#C6F432',
  amber: '#FF9F0A',
  text: '#FFFFFF',
  dim: '#8E8E93',
  faint: '#636366',
};

export interface RunScoresProps {
  /** 1-based number among valid runs; null = too short to score. */
  runNo: number | null;
  pace: number | null;
  npi: number | null;
  rii: number | null;
  /** PB the RII was measured against (s/km); undefined = not known here (history). */
  pbPace?: number | null;
  /** Why NPI may be missing: the profile is not saved (live) vs not stored (old run). */
  npiMissingHint?: string;
  baselinePace: number | null;
  compact?: boolean;
}

function formatPaceShort(s: number): string {
  if (!isFinite(s) || s <= 0) return '--:--';
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
}

export function BaselineProgress({ recorded, compact }: { recorded: number; compact?: boolean }) {
  const shown = Math.min(recorded, CALIBRATION_RUNS);
  return (
    <View>
      <Text style={[styles.baselineTitle, compact && { fontSize: 14 }]}>
        Baseline: {shown} of {CALIBRATION_RUNS} runs recorded
      </Text>
      <View style={styles.dots}>
        {Array.from({ length: CALIBRATION_RUNS }, (_, i) => (
          <View key={i} style={[styles.dot, i < shown && styles.dotDone]} />
        ))}
      </View>
      {!compact && (
        <Text style={styles.note}>
          Your first {CALIBRATION_RUNS} runs set your baseline. NPI and your progress numbers appear from run{' '}
          {CALIBRATION_RUNS}.
        </Text>
      )}
    </View>
  );
}

export default function RunScores({
  runNo,
  pace,
  npi,
  rii,
  pbPace,
  baselinePace,
  compact,
  npiMissingHint = 'not recorded',
}: RunScoresProps) {
  if (runNo === null) {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>SCORES</Text>
        <Text style={styles.note}>Too short to score (under 10 m). Saved in history, not counted.</Text>
      </View>
    );
  }

  if (runNo < CALIBRATION_RUNS) {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>CALIBRATION · RUN {runNo}</Text>
        <BaselineProgress recorded={runNo} compact={compact} />
      </View>
    );
  }

  const npiStatus = npi !== null ? getNPIStatus(npi) : null;
  const riiStatus = rii !== null && rii > 0 ? getRIIStatus(rii) : null;
  const vsBase = relativeToBaseline(baselinePace, pace);

  return (
    <View style={styles.card}>
      <Text style={styles.label}>RUN {runNo} · SCORES</Text>
      <View style={styles.row}>
        <View style={styles.cell}>
          <Text style={[styles.big, { color: npiStatus?.color ?? C.dim }]}>{npi !== null ? formatNPI(npi) : '—'}</Text>
          <Text style={styles.cellLabel}>NPI</Text>
          <Text style={[styles.cellSub, { color: npiStatus?.color ?? C.faint }]}>
            {npiStatus ? `${npiStatus.label}` : npiMissingHint}
          </Text>
        </View>
        <View style={styles.cell}>
          <Text style={[styles.big, { color: riiStatus?.color ?? C.dim }]}>{rii !== null && rii > 0 ? rii.toFixed(3) : '—'}</Text>
          <Text style={styles.cellLabel}>RII</Text>
          <Text style={styles.cellSub}>
            {pbPace ? `vs PB ${formatPaceShort(pbPace)}/km` : pbPace === undefined ? 'vs PB at the time' : 'first run on route'}
          </Text>
        </View>
      </View>
      <View style={styles.baseRow}>
        <Text style={[styles.baseValue, { color: vsBase !== null && vsBase >= 1 ? C.accent : C.amber }]}>
          {formatVsBaseline(vsBase)}
        </Text>
        {baselinePace !== null && <Text style={styles.cellSub}>baseline {formatPaceShort(baselinePace)}/km</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: C.surface, borderRadius: 24, padding: 16, marginTop: 12, width: '100%' },
  label: { color: C.dim, fontSize: 11, fontFamily: 'Urbanist_700Bold', letterSpacing: 1.5, marginBottom: 10 },
  baselineTitle: { color: C.text, fontSize: 17, fontFamily: 'Urbanist_700Bold' },
  dots: { flexDirection: 'row', gap: 8, marginTop: 10 },
  dot: { flex: 1, height: 8, borderRadius: 4, backgroundColor: C.elevated },
  dotDone: { backgroundColor: C.accent },
  note: { fontFamily: 'Urbanist_400Regular', color: C.dim, fontSize: 13, lineHeight: 18, marginTop: 10 },
  row: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center' },
  big: { fontSize: 30, fontFamily: 'Urbanist_800ExtraBold', fontVariant: ['tabular-nums'] },
  cellLabel: { color: C.dim, fontSize: 12, fontFamily: 'Urbanist_700Bold', letterSpacing: 1, marginTop: 2 },
  cellSub: { fontFamily: 'Urbanist_400Regular', color: C.faint, fontSize: 12, marginTop: 2 },
  baseRow: { alignItems: 'center', marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#2E2E33' },
  baseValue: { fontSize: 18, fontFamily: 'Urbanist_700Bold' },
});
