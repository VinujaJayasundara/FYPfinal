/**
 * ProfileSetupScreen — Professional Runner Profile
 * ==================================================
 * A polished profile screen with:
 *   - Large avatar header with initials + gradient accent ring
 *   - Back navigation (chevron) to return to Home
 *   - Clean form layout with inline editing
 *   - Live BMI calculation + NPI model preview
 *   - Stats summary cards
 *   - Model quality and factor coefficient sections
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  Animated,
  KeyboardAvoidingView,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useProfile } from '../context/ProfileContext';
import Avatar from '../components/Avatar';
import { pickAvatar, photosAvailable, type AvatarSource } from '../core/avatar';
import { calculateBMI, predictExpectedPace, formatNPI, getModelInterpretation, getModelQuality } from '../core/npiEngine';
import type { RunnerProfile as NPIProfile, RunContext } from '../core/npiEngine';

// ── Design Tokens ─────────────────────────────────────────
const C = {
  bg: '#000000',
  surface: '#1C1C1E',
  surfaceElevated: '#2C2C2E',
  separator: '#38383A',
  accent: '#00FF87',
  accentDim: '#00FF8718',
  accentGlow: '#00FF8730',
  teal: '#00D4AA',
  red: '#FF3B30',
  amber: '#FF9F0A',
  blue: '#0A84FF',
  purple: '#BF5AF2',
  gold: '#FFD60A',
  textPrimary: '#FFFFFF',
  textSecondary: '#8E8E93',
  textTertiary: '#636366',
};

interface ProfileSetupScreenProps {
  onSave: (name: string, age: number, weightKg: number, heightCm: number, gender: 'M' | 'F') => void;
  onBack?: () => void;
  existingProfile?: {
    name?: string;
    age: number;
    weightKg: number;
    heightCm: number;
    gender: 'M' | 'F';
    bmi: number;
  } | null;
}

// ── Form building blocks ──────────────────────────────────

const LIMITS = {
  age: { min: 12, max: 80 },
  weight: { min: 30, max: 200 },
  height: { min: 120, max: 220 },
};

function rangeError(label: string, raw: string, min: number, max: number, unit: string): string | null {
  if (raw.trim() === '') return `Enter your ${label.toLowerCase()}`;
  const v = Number(raw.replace(',', '.'));
  if (!Number.isFinite(v)) return 'Numbers only';
  if (v < min || v > max) return `Between ${min} and ${max} ${unit}`;
  return null;
}

function FormField({
  label,
  value,
  onChangeText,
  onBlur,
  unit,
  helper,
  error,
  placeholder,
  keyboardType = 'default',
  maxLength,
  inputRef,
  returnKeyType = 'next',
  onSubmitEditing,
  autoCapitalize = 'none',
  style,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  onBlur?: () => void;
  unit?: string;
  helper?: string;
  error?: string | null;
  placeholder?: string;
  keyboardType?: 'default' | 'number-pad' | 'decimal-pad';
  maxLength?: number;
  inputRef?: React.RefObject<TextInput | null>;
  returnKeyType?: 'next' | 'done';
  onSubmitEditing?: () => void;
  autoCapitalize?: 'none' | 'words';
  style?: object;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.field, style]}>
      <Text style={styles.fieldLabelTop}>{label}</Text>
      <View style={[styles.inputBox, focused && styles.inputBoxFocused, !!error && styles.inputBoxError]}>
        <TextInput
          ref={inputRef}
          style={styles.inputText}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
          placeholder={placeholder}
          placeholderTextColor={C.textTertiary}
          keyboardType={keyboardType}
          maxLength={maxLength}
          returnKeyType={returnKeyType}
          onSubmitEditing={onSubmitEditing}
          submitBehavior={returnKeyType === 'done' ? 'blurAndSubmit' : 'submit'}
          autoCapitalize={autoCapitalize}
          autoCorrect={false}
        />
        {unit ? <Text style={styles.inputUnit}>{unit}</Text> : null}
      </View>
      {error ? (
        <Text style={styles.fieldError}>{error}</Text>
      ) : helper ? (
        <Text style={styles.fieldHelper}>{helper}</Text>
      ) : null}
    </View>
  );
}

export default function ProfileSetupScreen({ onSave, onBack, existingProfile }: ProfileSetupScreenProps) {
  const { profile, setAvatar } = useProfile();
  const [name, setName] = useState(existingProfile?.name ?? '');
  const [age, setAge] = useState(existingProfile?.age?.toString() ?? '');
  const [weight, setWeight] = useState(existingProfile?.weightKg?.toString() ?? '');
  const [height, setHeight] = useState(existingProfile?.heightCm?.toString() ?? '');
  const [gender, setGender] = useState<'M' | 'F'>(existingProfile?.gender ?? 'M');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitted, setSubmitted] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [fadeAnim] = useState(new Animated.Value(0));
  const [headerScale] = useState(new Animated.Value(0.9));

  const ageRef = useRef<TextInput>(null);
  const heightRef = useRef<TextInput>(null);
  const weightRef = useRef<TextInput>(null);

  const profileName = name.trim() || 'Runner';

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      Animated.spring(headerScale, { toValue: 1, tension: 60, friction: 8, useNativeDriver: true }),
    ]).start();
  }, []);

  const ageNum = parseInt(age, 10) || 0;
  const weightNum = parseFloat(weight.replace(',', '.')) || 0;
  const heightNum = parseFloat(height.replace(',', '.')) || 0;
  const bmi = heightNum > 0 && weightNum > 0 ? calculateBMI(weightNum, heightNum) : 0;

  const errors = {
    name: name.trim().length === 0 ? 'Enter a name' : null,
    age: rangeError('Age', age, LIMITS.age.min, LIMITS.age.max, 'years'),
    height: rangeError('Height', height, LIMITS.height.min, LIMITS.height.max, 'cm'),
    weight: rangeError('Weight', weight, LIMITS.weight.min, LIMITS.weight.max, 'kg'),
  };
  const isValid = !errors.name && !errors.age && !errors.height && !errors.weight;
  const show = (k: keyof typeof errors) => (touched[k] || submitted ? errors[k] : null);
  const touch = (k: string) => () => setTouched(t => ({ ...t, [k]: true }));

  const dirty =
    !existingProfile ||
    name.trim() !== (existingProfile.name ?? '') ||
    ageNum !== existingProfile.age ||
    weightNum !== existingProfile.weightKg ||
    heightNum !== existingProfile.heightCm ||
    gender !== existingProfile.gender;

  // Calculate preview expected pace
  const expectedPace = isValid ? predictExpectedPace(
    { age: ageNum, weightKg: weightNum, heightCm: heightNum, bmi, gender },
    { altitudeM: 15, distanceM: 2500 },
  ) : 0;

  const expectedPaceFormatted = expectedPace > 0
    ? `${Math.floor(expectedPace / 60)}:${Math.floor(expectedPace % 60).toString().padStart(2, '0')}`
    : '--:--';

  const handleSave = useCallback(() => {
    setSubmitted(true);
    if (isValid) {
      onSave(name.trim(), ageNum, weightNum, heightNum, gender);
    }
  }, [isValid, name, ageNum, weightNum, heightNum, gender, onSave]);

  // ── Profile picture ───────────────────────────────────
  const choosePhoto = useCallback(
    async (source: AvatarSource) => {
      setPhotoBusy(true);
      try {
        const uri = await pickAvatar(source);
        if (uri) await setAvatar(uri);
      } catch (e: any) {
        Alert.alert('Profile picture', e?.message ?? String(e));
      } finally {
        setPhotoBusy(false);
      }
    },
    [setAvatar],
  );

  const onAvatarPress = useCallback(() => {
    if (!photosAvailable()) {
      Alert.alert('Profile picture', 'Photos are not available in this build. Install the latest APK.');
      return;
    }
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
      { text: 'Choose from gallery', onPress: () => choosePhoto('library') },
      { text: 'Take a photo', onPress: () => choosePhoto('camera') },
    ];
    if (profile.avatarUri) {
      buttons.push({ text: 'Remove photo', style: 'destructive', onPress: () => setAvatar(null) });
    }
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Profile picture', 'Your photo stays on this phone. It is not shared with other runners.', buttons);
  }, [choosePhoto, profile.avatarUri, setAvatar]);

  // BMI status
  const bmiStatus = bmi > 0
    ? bmi < 18.5 ? { label: 'Underweight', color: C.amber, icon: '⚠️' }
    : bmi < 25 ? { label: 'Normal', color: C.accent, icon: '✅' }
    : bmi < 30 ? { label: 'Overweight', color: C.amber, icon: '⚠️' }
    : { label: 'Obese', color: C.red, icon: '🔴' }
    : { label: '—', color: C.textTertiary, icon: '' };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <Animated.View style={{ opacity: fadeAnim }}>

          {/* ── Back Button ──────────────────────────────── */}
          {onBack && (
            <TouchableOpacity style={styles.backButton} onPress={onBack}>
              <Text style={styles.backChevron}>‹</Text>
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
          )}

          {/* ── Profile Hero ─────────────────────────────── */}
          <Animated.View style={[styles.heroSection, { transform: [{ scale: headerScale }] }]}>
            <TouchableOpacity
              style={styles.heroAvatarOuter}
              onPress={onAvatarPress}
              activeOpacity={0.8}
              accessibilityLabel="Change profile picture"
            >
              <View style={styles.heroAvatarRing}>
                <Avatar name={profileName} uri={profile.avatarUri} size={76} />
              </View>
              <View style={styles.cameraBadge}>
                {photoBusy ? <ActivityIndicator size="small" color="#000" /> : <Text style={styles.cameraIcon}>📷</Text>}
              </View>
            </TouchableOpacity>
            <TouchableOpacity onPress={onAvatarPress} hitSlop={8}>
              <Text style={styles.changePhoto}>{profile.avatarUri ? 'Change photo' : 'Add photo'}</Text>
            </TouchableOpacity>

            <Text style={styles.heroName}>{profileName}</Text>
            <Text style={styles.heroSubtitle}>Runner Profile · Ghost Tracker</Text>

            {/* Quick stats row */}
            {isValid && (
              <View style={styles.heroStatsRow}>
                <View style={styles.heroStat}>
                  <Text style={styles.heroStatValue}>{ageNum}</Text>
                  <Text style={styles.heroStatLabel}>Age</Text>
                </View>
                <View style={styles.heroStatDivider} />
                <View style={styles.heroStat}>
                  <Text style={[styles.heroStatValue, { color: bmiStatus.color }]}>
                    {bmi.toFixed(1)}
                  </Text>
                  <Text style={styles.heroStatLabel}>BMI</Text>
                </View>
                <View style={styles.heroStatDivider} />
                <View style={styles.heroStat}>
                  <Text style={[styles.heroStatValue, { color: C.teal }]}>
                    {expectedPaceFormatted}
                  </Text>
                  <Text style={styles.heroStatLabel}>Predicted</Text>
                </View>
              </View>
            )}
          </Animated.View>

          {/* ── Personal details form ─────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionIconBg}>
                <Text style={styles.sectionIcon}>👤</Text>
              </View>
              <View>
                <Text style={styles.sectionTitle}>Personal details</Text>
                <Text style={styles.sectionDesc}>Used to predict your expected pace (NPI model)</Text>
              </View>
            </View>

            <FormField
              label="Display name"
              value={name}
              onChangeText={setName}
              onBlur={touch('name')}
              placeholder="Your name"
              maxLength={20}
              autoCapitalize="words"
              helper={`Shown to friends on the leaderboard · ${name.trim().length}/20`}
              error={show('name')}
              onSubmitEditing={() => ageRef.current?.focus()}
            />

            <FormField
              label="Age"
              value={age}
              onChangeText={t => setAge(t.replace(/[^0-9]/g, ''))}
              onBlur={touch('age')}
              unit="years"
              placeholder="25"
              keyboardType="number-pad"
              maxLength={2}
              helper={`${LIMITS.age.min}–${LIMITS.age.max} years`}
              error={show('age')}
              inputRef={ageRef}
              onSubmitEditing={() => heightRef.current?.focus()}
            />

            <View style={styles.fieldPair}>
              <FormField
                style={{ flex: 1 }}
                label="Height"
                value={height}
                onChangeText={t => setHeight(t.replace(/[^0-9.,]/g, ''))}
                onBlur={touch('height')}
                unit="cm"
                placeholder="175"
                keyboardType="decimal-pad"
                maxLength={5}
                error={show('height')}
                inputRef={heightRef}
                onSubmitEditing={() => weightRef.current?.focus()}
              />
              <FormField
                style={{ flex: 1 }}
                label="Weight"
                value={weight}
                onChangeText={t => setWeight(t.replace(/[^0-9.,]/g, ''))}
                onBlur={touch('weight')}
                unit="kg"
                placeholder="68"
                keyboardType="decimal-pad"
                maxLength={5}
                error={show('weight')}
                inputRef={weightRef}
                returnKeyType="done"
              />
            </View>

            <View style={styles.field}>
              <Text style={styles.fieldLabelTop}>Sex</Text>
              <View style={styles.segmented}>
                {(['M', 'F'] as const).map(g => (
                  <TouchableOpacity
                    key={g}
                    style={[styles.segment, gender === g && styles.segmentActive]}
                    onPress={() => setGender(g)}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.segmentText, gender === g && styles.segmentTextActive]}>
                      {g === 'M' ? 'Male' : 'Female'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.fieldHelper}>The pace model was trained with these two categories.</Text>
            </View>
          </View>

          {/* ── BMI + Predictions Card ───────────────────── */}
          {bmi > 0 && (
            <View style={styles.metricsCard}>
              <View style={styles.metricsRow}>
                {/* BMI */}
                <View style={styles.metricBlock}>
                  <Text style={styles.metricLabel}>BMI</Text>
                  <Text style={[styles.metricValue, { color: bmiStatus.color }]}>
                    {bmi.toFixed(1)}
                  </Text>
                  <View style={[styles.metricBadge, { borderColor: bmiStatus.color + '60' }]}>
                    <Text style={[styles.metricBadgeText, { color: bmiStatus.color }]}>
                      {bmiStatus.icon} {bmiStatus.label}
                    </Text>
                  </View>
                </View>

                {/* Divider */}
                <View style={styles.metricsVertDivider} />

                {/* Predicted Pace */}
                {isValid && (
                  <View style={styles.metricBlock}>
                    <Text style={styles.metricLabel}>PREDICTED PACE</Text>
                    <Text style={[styles.metricValue, { color: C.teal }]}>
                      {expectedPaceFormatted}
                    </Text>
                    <Text style={styles.metricContext}>/km at Bellanwila</Text>
                  </View>
                )}
              </View>
            </View>
          )}

          {/* ── NPI Model Info ────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIconBg, { backgroundColor: C.purple + '20' }]}>
                <Text style={styles.sectionIcon}>🧠</Text>
              </View>
              <View>
                <Text style={styles.sectionTitle}>NPI Model</Text>
                <Text style={styles.sectionDesc}>Normalized Performance Index</Text>
              </View>
            </View>

            <View style={styles.formulaCard}>
              <Text style={styles.formulaText}>
                NPI = (Expected_pace − Actual_pace) / σ
              </Text>
            </View>

            <Text style={styles.modelExplain}>
              Measures how many standard deviations better than expected you performed, given your physical profile and environmental conditions.
            </Text>

            {/* NPI Scale */}
            <View style={styles.npiScale}>
              {[
                { label: '< -1.0', desc: 'Needs Work', color: C.red, emoji: '👻' },
                { label: '-1 to 0', desc: 'Below Avg', color: C.amber, emoji: '😤' },
                { label: '0 to +1', desc: 'Expected', color: C.blue, emoji: '✅' },
                { label: '+1 to +2', desc: 'Above Avg', color: C.accent, emoji: '🔥' },
                { label: '> +2.0', desc: 'Exceptional', color: C.gold, emoji: '🏆' },
              ].map((item, i) => (
                <View key={i} style={styles.npiScaleItem}>
                  <Text style={{ fontSize: 18 }}>{item.emoji}</Text>
                  <Text style={[styles.npiScaleValue, { color: item.color }]}>{item.label}</Text>
                  <Text style={styles.npiScaleDesc}>{item.desc}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* ── Model Quality ─────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIconBg, { backgroundColor: C.blue + '20' }]}>
                <Text style={styles.sectionIcon}>📈</Text>
              </View>
              <View>
                <Text style={styles.sectionTitle}>Model Quality</Text>
                <Text style={styles.sectionDesc}>Regression statistics</Text>
              </View>
            </View>

            {getModelQuality().map((item, i) => (
              <View key={i} style={styles.qualityRow}>
                <Text style={styles.qualityMetric}>{item.metric}</Text>
                <Text style={styles.qualityValue}>{item.value}</Text>
              </View>
            ))}
          </View>

          {/* ── Pace Factors ──────────────────────────────── */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionIconBg, { backgroundColor: C.teal + '20' }]}>
                <Text style={styles.sectionIcon}>⚡</Text>
              </View>
              <View>
                <Text style={styles.sectionTitle}>Pace Factors</Text>
                <Text style={styles.sectionDesc}>How each variable affects predicted pace</Text>
              </View>
            </View>

            {getModelInterpretation().map((item, i) => (
              <View key={i} style={styles.factorRow}>
                <Text style={styles.factorName}>{item.factor}</Text>
                <View style={styles.factorEffectBadge}>
                  <Text style={styles.factorEffect}>{item.effect}</Text>
                </View>
              </View>
            ))}
          </View>

          {/* ── Save Button ───────────────────────────────── */}
          <TouchableOpacity
            style={[styles.saveButton, (!isValid || !dirty) && styles.saveButtonDisabled]}
            onPress={handleSave}
            disabled={!dirty}
            activeOpacity={0.85}
          >
            <Text style={[styles.saveButtonText, (!isValid || !dirty) && styles.saveButtonTextDisabled]}>
              {!existingProfile ? 'SAVE PROFILE' : dirty ? 'SAVE CHANGES' : 'NO CHANGES'}
            </Text>
          </TouchableOpacity>

          {submitted && !isValid && (
            <Text style={styles.validationHint}>Check the highlighted fields</Text>
          )}

          <View style={{ height: 40 }} />
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// ═══════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════

const styles = StyleSheet.create({
  // ── Form ─────────────────────────────────────────────
  field: { marginTop: 14 },
  fieldPair: { flexDirection: 'row', gap: 12 },
  fieldLabelTop: { color: C.textSecondary, fontSize: 12, fontWeight: '600', letterSpacing: 0.4, marginBottom: 6 },
  inputBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.surfaceElevated,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: 'transparent',
    paddingHorizontal: 14,
    minHeight: 50,
  },
  inputBoxFocused: { borderColor: C.accent },
  inputBoxError: { borderColor: C.red },
  inputText: { flex: 1, color: C.textPrimary, fontSize: 17, fontWeight: '600', paddingVertical: 12 },
  inputUnit: { color: C.textTertiary, fontSize: 14, fontWeight: '600', marginLeft: 8 },
  fieldHelper: { color: C.textTertiary, fontSize: 12, marginTop: 6 },
  fieldError: { color: C.red, fontSize: 12, fontWeight: '600', marginTop: 6 },
  segmented: { flexDirection: 'row', backgroundColor: C.surfaceElevated, borderRadius: 12, padding: 4 },
  segment: { flex: 1, paddingVertical: 11, borderRadius: 9, alignItems: 'center' },
  segmentActive: { backgroundColor: C.accent },
  segmentText: { color: C.textSecondary, fontSize: 15, fontWeight: '700' },
  segmentTextActive: { color: '#000' },
  cameraBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: C.bg,
  },
  cameraIcon: { fontSize: 14 },
  changePhoto: { color: C.accent, fontSize: 13, fontWeight: '600', marginTop: 8, marginBottom: 4 },
  container: { flex: 1, backgroundColor: C.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 4 },

  // ── Back Button ─────────────────────────────────────
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 8,
    alignSelf: 'flex-start',
  },
  backChevron: {
    fontSize: 28,
    fontWeight: '300',
    color: C.accent,
    lineHeight: 28,
    marginTop: -2,
  },
  backText: {
    fontSize: 15,
    fontWeight: '500',
    color: C.accent,
  },

  // ── Hero Section ────────────────────────────────────
  heroSection: {
    alignItems: 'center',
    paddingVertical: 24,
    marginBottom: 8,
  },
  heroAvatarOuter: {
    position: 'relative',
    marginBottom: 2,
  },
  heroAvatarRing: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 2.5,
    borderColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 3,
    // Glow effect
    shadowColor: C.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  heroAvatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: C.accentDim,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroAvatarText: {
    fontSize: 28,
    fontWeight: '700',
    color: C.accent,
    letterSpacing: 1,
  },
  statusDot: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: C.accent,
    borderWidth: 3,
    borderColor: C.bg,
  },
  heroName: {
    fontSize: 24,
    fontWeight: '700',
    color: C.textPrimary,
    letterSpacing: 0.5,
  },
  heroSubtitle: {
    fontSize: 13,
    color: C.textSecondary,
    marginTop: 4,
    letterSpacing: 0.3,
  },
  heroStatsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
    backgroundColor: C.surface,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 24,
    gap: 0,
  },
  heroStat: {
    flex: 1,
    alignItems: 'center',
  },
  heroStatValue: {
    fontSize: 20,
    fontWeight: '700',
    color: C.textPrimary,
    fontFamily: 'monospace',
  },
  heroStatLabel: {
    fontSize: 9,
    color: C.textTertiary,
    fontWeight: '600',
    letterSpacing: 1,
    marginTop: 3,
  },
  heroStatDivider: {
    width: 1,
    height: 32,
    backgroundColor: C.separator,
  },

  // ── Section Card ────────────────────────────────────
  section: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 20,
    marginBottom: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 18,
  },
  sectionIconBg: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: C.accentGlow,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionIcon: {
    fontSize: 18,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: C.textPrimary,
    letterSpacing: 0.3,
  },
  sectionDesc: {
    fontSize: 11,
    color: C.textTertiary,
    marginTop: 1,
  },

  // ── Form Fields ─────────────────────────────────────
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderBottomWidth: 0.5,
    borderBottomColor: C.separator,
  },
  fieldLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  fieldEmoji: {
    fontSize: 18,
    width: 28,
    textAlign: 'center',
  },
  fieldLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: C.textPrimary,
  },
  fieldUnit: {
    fontSize: 11,
    color: C.textTertiary,
    marginTop: 1,
  },
  input: {
    backgroundColor: C.surfaceElevated,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 18,
    fontWeight: '600',
    color: C.textPrimary,
    textAlign: 'right',
    minWidth: 90,
    fontFamily: 'monospace',
    borderWidth: 1,
    borderColor: 'transparent',
  },

  // Gender
  genderRow: {
    flexDirection: 'row',
    gap: 8,
  },
  genderBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: C.surfaceElevated,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  genderBtnActive: {
    borderColor: C.accent,
    backgroundColor: C.accentDim,
  },
  genderText: {
    fontSize: 14,
    fontWeight: '600',
    color: C.textSecondary,
  },
  genderTextActive: {
    color: C.accent,
  },

  // ── Metrics Card ────────────────────────────────────
  metricsCard: {
    backgroundColor: C.surface,
    borderRadius: 20,
    padding: 24,
    marginBottom: 12,
  },
  metricsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  metricBlock: {
    flex: 1,
    alignItems: 'center',
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: C.textTertiary,
    letterSpacing: 1.5,
    marginBottom: 6,
  },
  metricValue: {
    fontSize: 36,
    fontWeight: '200',
    fontFamily: 'monospace',
  },
  metricBadge: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  metricBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  metricContext: {
    fontSize: 11,
    color: C.textTertiary,
    marginTop: 8,
  },
  metricsVertDivider: {
    width: 1,
    height: 60,
    backgroundColor: C.separator,
    marginTop: 10,
    marginHorizontal: 8,
  },

  // ── Formula Card ────────────────────────────────────
  formulaCard: {
    backgroundColor: C.surfaceElevated,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: C.purple + '30',
  },
  formulaText: {
    fontSize: 14,
    fontWeight: '600',
    color: C.purple,
    fontFamily: 'monospace',
    textAlign: 'center',
    letterSpacing: 0.5,
  },
  modelExplain: {
    fontSize: 12,
    color: C.textSecondary,
    lineHeight: 18,
    marginBottom: 16,
  },

  // NPI Scale
  npiScale: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 4,
    backgroundColor: C.surfaceElevated,
    borderRadius: 14,
    padding: 12,
  },
  npiScaleItem: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
  },
  npiScaleValue: {
    fontSize: 9,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  npiScaleDesc: {
    fontSize: 7,
    color: C.textTertiary,
    fontWeight: '600',
  },

  // Model Quality
  qualityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: C.separator,
  },
  qualityMetric: {
    fontSize: 14,
    color: C.textSecondary,
  },
  qualityValue: {
    fontSize: 14,
    fontWeight: '600',
    color: C.textPrimary,
    fontFamily: 'monospace',
  },

  // Factor Coefficients
  factorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: C.separator,
  },
  factorName: {
    fontSize: 14,
    fontWeight: '600',
    color: C.textPrimary,
  },
  factorEffectBadge: {
    backgroundColor: C.teal + '15',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  factorEffect: {
    fontSize: 11,
    color: C.teal,
    fontFamily: 'monospace',
    fontWeight: '600',
  },

  // Save Button
  saveButton: {
    backgroundColor: C.accent,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    marginTop: 8,
    shadowColor: C.accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  saveButtonDisabled: {
    backgroundColor: C.surfaceElevated,
    shadowOpacity: 0,
    elevation: 0,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000000',
    letterSpacing: 1.5,
  },
  saveButtonTextDisabled: {
    color: C.textTertiary,
  },
  validationHint: {
    textAlign: 'center',
    fontSize: 12,
    color: C.textTertiary,
    marginTop: 8,
  },
});
