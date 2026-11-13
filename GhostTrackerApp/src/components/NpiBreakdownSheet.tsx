/**
 * Slide-up sheet that shows how the NPI is worked out, step by step, with
 * the runner's own numbers (thesis Eq. 4.1 expected pace, then
 * NPI = (expected − actual) / σ). Opens when a run starts and from the
 * "How NPI works" chip; the numbers update live as the run goes on.
 *
 * Every number comes from the same model file and formula the app scores
 * with (NPI_MODEL / predictExpectedPace / calculateNPI), so the sheet and
 * the score can never disagree.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NPI_MODEL, calculateNPI, getNPIStatus, formatNPI } from '../core/npiEngine';
import { colors } from '../theme/tokens';
import { Button } from './ui';

export interface NpiData {
  runner: { age: number; bmi: number; gender: 'M' | 'F' } | null;
  /** Run-mean altitude above sea level; null until the GPS gives one. */
  altitudeM: number | null;
  distanceM: number;
  /** Average pace so far (s/km); null until there is one. */
  avgPaceSPerKm: number | null;
  /** True during the first baseline runs, when NPI is not shown as a score yet. */
  preview?: boolean;
  /** Run number at which NPI starts to count (the baseline length). */
  scoredFromRun?: number;
  /** NPI saved with a finished run; a note is shown if today's formula gives a different value. */
  storedNpi?: number | null;
  /** Replaces the default footnote (which talks about a live run). */
  footnote?: string;
}

export interface NpiBreakdownProps extends NpiData {
  visible: boolean;
  onClose: () => void;
}

/** Same fallback the scoring uses when the phone gives no altitude. */
const DEFAULT_ALTITUDE_M = 15;

const fmtPace = (s: number) => {
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r === 60 ? `${m + 1}:00` : `${m}:${String(r).padStart(2, '0')}`;
};
const signed = (v: number, d = 2) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`;

/**
 * The worked calculation itself (title, Eq. 4.1 table, NPI step). Rows
 * slide in one after another each time `active` turns true. `compact`
 * drops the intro and footnote (side panel on the run map).
 */
export function NpiBreakdownBody({
  active,
  compact = false,
  runner,
  altitudeM,
  distanceM,
  avgPaceSPerKm,
  preview = false,
  scoredFromRun = 5,
  storedNpi = null,
  footnote,
}: NpiData & { active: boolean; compact?: boolean }) {
  const m = NPI_MODEL;
  const altitude = altitudeM ?? DEFAULT_ALTITUDE_M;
  const hasPace = avgPaceSPerKm !== null && avgPaceSPerKm > 0 && isFinite(avgPaceSPerKm);

  // Each term of Eq. 4.1 and the running total after it
  const rows = useMemo(() => {
    if (!runner) return [];
    const female = runner.gender === 'F';
    const terms: { label: string; detail: string; value: number }[] = [
      { label: 'Base pace', detail: 'model starting point', value: m.intercept },
      { label: 'Age', detail: `${runner.age} yr × ${m.age.toFixed(3)}`, value: m.age * runner.age },
      { label: 'BMI', detail: `${runner.bmi.toFixed(1)} × ${m.bmi.toFixed(3)}`, value: m.bmi * runner.bmi },
      {
        label: 'Altitude',
        detail: `${Math.round(altitude)} m × ${m.altitudeM.toFixed(4)}${altitudeM === null ? ' (GPS pending)' : ''}`,
        value: m.altitudeM * altitude,
      },
      {
        label: 'Distance',
        detail: `${(distanceM / 1000).toFixed(2)} km × ${(m.distanceM * 1000).toFixed(2)}/km`,
        value: m.distanceM * distanceM,
      },
      {
        label: 'Sex',
        detail: female ? `female × ${m.genderFemale.toFixed(2)}` : 'male × 0',
        value: female ? m.genderFemale : 0,
      },
    ];
    let total = 0;
    return terms.map(t => {
      total += t.value;
      return { ...t, total };
    });
  }, [runner, altitude, altitudeM, distanceM, m]);

  // The app's own scoring call, so the sheet shows exactly the scored NPI
  const result =
    runner && hasPace
      ? calculateNPI(
          { age: runner.age, bmi: runner.bmi, gender: runner.gender },
          { altitudeM: altitude, distanceM, avgPaceSPerKm: avgPaceSPerKm! },
        )
      : null;
  const expected = rows.length ? rows[rows.length - 1].total : 0;
  const status = result ? getNPIStatus(result.npi) : null;

  // Rows slide in one after another each time the sheet opens
  const steps = rows.length + 2; // terms, expected-pace line, NPI block
  const anims = useRef(Array.from({ length: 8 }, () => new Animated.Value(0))).current;
  useEffect(() => {
    if (!active) return;
    anims.forEach(a => a.setValue(0));
    Animated.stagger(
      260,
      anims.slice(0, steps).map(a =>
        Animated.timing(a, { toValue: 1, duration: 320, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ),
    ).start();
  }, [active, steps, anims]);
  const appear = (i: number) => ({
    opacity: anims[i],
    transform: [{ translateY: anims[i].interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
  });

  return (
    <>
          <Text style={styles.kicker}>NORMALIZED PERFORMANCE INDEX</Text>
          <Text style={[styles.title, compact && { fontSize: 20 }]}>How your NPI is worked out</Text>
          {!compact && (
            <Text style={styles.lead}>
              The model predicts the pace expected from you, here, today. NPI says how far your real pace is from it.
            </Text>
          )}

          {!runner ? (
            <Text style={styles.empty}>Save your age, height, weight and sex in Profile to get an NPI.</Text>
          ) : (
            <>
              <Text style={styles.step}>1 · EXPECTED PACE (s/km)</Text>
              <View style={styles.table}>
                {rows.map((r, i) => (
                  <Animated.View key={r.label} style={[styles.row, appear(i)]}>
                    {compact ? (
                      <View style={{ flex: 1 }}>
                        <Text style={styles.rowLabel}>{r.label}</Text>
                        <Text style={styles.rowDetail} numberOfLines={1}>{r.detail}</Text>
                      </View>
                    ) : (
                      <>
                        <Text style={styles.rowLabel}>{r.label}</Text>
                        <Text style={styles.rowDetail} numberOfLines={1}>{r.detail}</Text>
                      </>
                    )}
                    <Text style={styles.rowValue}>{i === 0 ? r.value.toFixed(2) : signed(r.value)}</Text>
                    <Text style={styles.rowTotal}>{r.total.toFixed(2)}</Text>
                  </Animated.View>
                ))}
                <Animated.View style={[styles.sumRow, appear(rows.length)]}>
                  <Text style={styles.sumLabel}>Expected pace</Text>
                  <Text style={styles.sumValue}>
                    {expected.toFixed(1)} s/km · {fmtPace(expected)} /km
                  </Text>
                </Animated.View>
              </View>

              <Animated.View style={appear(rows.length + 1)}>
                <Text style={styles.step}>2 · YOUR NPI</Text>
                <View style={styles.npiCard}>
                  <Text style={styles.formula}>NPI = (expected − your pace) ÷ σ</Text>
                  {result ? (
                    <>
                      <Text style={styles.formulaNums}>
                        ({expected.toFixed(1)} − {avgPaceSPerKm!.toFixed(1)}) ÷ {m.sigma.toFixed(2)}
                      </Text>
                      <View style={styles.npiRow}>
                        <Text style={styles.npiValue}>{formatNPI(result.npi)}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.npiStatus}>{status?.label}</Text>
                          <Text style={styles.npiSub}>your pace {fmtPace(avgPaceSPerKm!)} /km</Text>
                        </View>
                      </View>
                      {preview && (
                        <Text style={styles.note}>Preview: NPI counts as a score from run {scoredFromRun}.</Text>
                      )}
                      {storedNpi !== null && Math.abs(storedNpi - result.npi) >= 0.005 && (
                        <Text style={styles.note}>
                          Saved with this run: {formatNPI(storedNpi)}. It was scored before the altitude fix (one GPS
                          altitude reading, not sea-level corrected), so it differs slightly.
                        </Text>
                      )}
                    </>
                  ) : (
                    <Text style={styles.formulaNums}>Your pace appears after the first few metres; then the NPI fills in.</Text>
                  )}
                </View>
              </Animated.View>

              {!compact && <Text style={styles.foot}>
                Above 0 = faster than expected for you; below 0 = slower. σ = {m.sigma.toFixed(2)} s/km is the
                model&apos;s typical error, so +1 means one typical error faster.{' '}
                {footnote ?? 'Distance, altitude (above sea level, averaged over the run) and pace update live while you run.'}
              </Text>}
            </>
          )}
    </>
  );
}

/** Slide-up page with the worked calculation (opens when a run starts). */
export default function NpiBreakdownSheet({ visible, onClose, ...data }: NpiBreakdownProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.sheet}>
        <View style={styles.handle} />
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
          <NpiBreakdownBody active={visible} {...data} />
        </ScrollView>
        <Button label="Got it" onPress={onClose} style={{ marginTop: 12 }} />
      </View>
    </Modal>
  );
}

const C = colors;
const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: C.surface,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderColor: C.border,
  },
  handle: { alignSelf: 'center', width: 44, height: 5, borderRadius: 3, backgroundColor: C.elevated, marginBottom: 14 },
  kicker: { fontFamily: 'Urbanist_700Bold', fontSize: 11, letterSpacing: 1.6, color: C.npi },
  title: { fontFamily: 'Urbanist_800ExtraBold', fontSize: 24, color: C.text, marginTop: 4 },
  lead: { fontFamily: 'Urbanist_400Regular', fontSize: 14, lineHeight: 20, color: C.textDim, marginTop: 6 },
  empty: { fontFamily: 'Urbanist_500Medium', fontSize: 15, color: C.text, marginTop: 20 },
  step: { fontFamily: 'Urbanist_700Bold', fontSize: 12, letterSpacing: 1.2, color: C.textDim, marginTop: 16, marginBottom: 8 },
  table: { backgroundColor: C.elevated, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  rowLabel: { fontFamily: 'Urbanist_600SemiBold', fontSize: 15, color: C.text, width: 76 },
  rowDetail: { flex: 1, fontFamily: 'Urbanist_400Regular', fontSize: 12, color: C.textDim },
  rowValue: { fontFamily: 'Urbanist_600SemiBold', fontSize: 15, color: C.text, width: 72, textAlign: 'right' },
  rowTotal: { fontFamily: 'Urbanist_400Regular', fontSize: 13, color: C.textDim, width: 64, textAlign: 'right' },
  sumRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  sumLabel: { fontFamily: 'Urbanist_800ExtraBold', fontSize: 15, color: C.accent },
  sumValue: { fontFamily: 'Urbanist_800ExtraBold', fontSize: 15, color: C.accent },
  npiCard: { backgroundColor: C.npiDim, borderRadius: 18, padding: 16 },
  formula: { fontFamily: 'Urbanist_600SemiBold', fontSize: 15, color: C.text },
  formulaNums: { fontFamily: 'Urbanist_400Regular', fontSize: 14, color: C.textDim, marginTop: 6 },
  npiRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 14 },
  npiValue: { fontFamily: 'Urbanist_800ExtraBold', fontSize: 36, color: C.npi },
  npiStatus: { fontFamily: 'Urbanist_700Bold', fontSize: 16, color: C.text },
  npiSub: { fontFamily: 'Urbanist_400Regular', fontSize: 13, color: C.textDim, marginTop: 2 },
  note: { fontFamily: 'Urbanist_500Medium', fontSize: 12, color: C.textDim, marginTop: 10 },
  foot: { fontFamily: 'Urbanist_400Regular', fontSize: 12, lineHeight: 18, color: C.textFaint, marginTop: 16 },
});
