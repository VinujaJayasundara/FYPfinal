/**
 * Shared UI building blocks for the revamped screens: text styles, cards,
 * stat tiles, icon circles, pills, buttons and screen headers.
 */

import React from 'react';
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { colors, fonts, radius, space, type } from '../theme/tokens';

// ── Text ───────────────────────────────────────────────────

type Variant = keyof typeof type;

/** Text in the app font; `variant` picks a size/weight from the type scale. */
export function T({ variant = 'body', style, ...rest }: TextProps & { variant?: Variant; style?: StyleProp<TextStyle> }) {
  return <Text {...rest} style={[type[variant] as TextStyle, style]} />;
}

// ── Containers ─────────────────────────────────────────────

export function Card({
  children,
  style,
  onPress,
  tone = 'surface',
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  tone?: 'surface' | 'overlay' | 'elevated';
}) {
  const bg = tone === 'overlay' ? colors.overlay : tone === 'elevated' ? colors.elevated : colors.surface;
  const body = <View style={[styles.card, { backgroundColor: bg }, style]}>{children}</View>;
  return onPress ? (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress}>
      {body}
    </TouchableOpacity>
  ) : (
    body
  );
}

/** Small round container for an icon or emoji. */
export function IconCircle({
  children,
  size = 40,
  light = false,
  color,
  style,
}: {
  children: React.ReactNode;
  size?: number;
  light?: boolean;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      style={[
        styles.iconCircle,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color ?? (light ? colors.white : colors.elevated) },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** Label + big value + unit, the stat tile of the design. */
export function StatTile({
  icon,
  label,
  value,
  unit,
  sub,
  subColor,
  style,
  valueColor,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  subColor?: string;
  style?: StyleProp<ViewStyle>;
  valueColor?: string;
}) {
  return (
    <Card style={[styles.tile, style]}>
      {icon ? <View style={{ marginBottom: space.sm }}>{icon}</View> : null}
      <T variant="label">{label}</T>
      <View style={styles.valueRow}>
        <T variant="bigNumber" style={valueColor ? { color: valueColor } : undefined} numberOfLines={1} adjustsFontSizeToFit>
          {value}
        </T>
        {unit ? <T variant="unit" style={{ marginLeft: 4 }}>{unit}</T> : null}
      </View>
      {sub ? (
        <T variant="caption" style={subColor ? { color: subColor } : undefined} numberOfLines={2}>
          {sub}
        </T>
      ) : null}
    </Card>
  );
}

export function Pill({
  label,
  active,
  color = colors.accent,
  onPress,
  style,
}: {
  label: string;
  active?: boolean;
  color?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.8}
      style={[styles.pill, active && { backgroundColor: color, borderColor: color }, style]}
    >
      <T variant="label" style={[{ fontFamily: fonts.semibold }, active && { color: colors.onAccent }]}>
        {label}
      </T>
    </TouchableOpacity>
  );
}

export function PrimaryButton({
  label,
  onPress,
  color = colors.accent,
  textColor = colors.onAccent,
  style,
  disabled,
}: {
  label: string;
  onPress: () => void;
  color?: string;
  textColor?: string;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.85}
      style={[styles.primary, { backgroundColor: color, opacity: disabled ? 0.4 : 1 }, style]}
    >
      <Text style={[styles.primaryText, { color: textColor }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Screen header: small greeting/eyebrow over a big title, optional right slot. */
export function ScreenHeader({
  eyebrow,
  title,
  right,
  onTitleLongPress,
}: {
  eyebrow?: string;
  title: string;
  right?: React.ReactNode;
  onTitleLongPress?: () => void;
}) {
  return (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        {eyebrow ? <T variant="label">{eyebrow}</T> : null}
        <Text style={type.hero as TextStyle} onLongPress={onTitleLongPress} suppressHighlighting>
          {title}
        </Text>
      </View>
      {right}
    </View>
  );
}

export function SectionTitle({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionRow}>
      <T variant="section">{title}</T>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: space.lg },
  iconCircle: { alignItems: 'center', justifyContent: 'center' },
  tile: { flex: 1 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 2 },
  pill: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  primary: { borderRadius: radius.lg, paddingVertical: 18, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontFamily: fonts.extrabold, fontSize: 17, letterSpacing: 1 },
  header: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: space.lg, gap: space.md },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.xl,
    marginBottom: space.md,
  },
});
