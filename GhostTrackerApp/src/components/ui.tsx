/**
 * Shared UI building blocks: text styles, cards (incl. the glass card with
 * an accent fade), stat tiles, icons, pills, buttons and screen headers.
 * Every button in the app goes through Button / IconButton so they share
 * one look (colours, radius, padding, pressed and disabled states).
 */

import React from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { buttonStyle, colors, fonts, radius, space, type } from '../theme/tokens';

// ── Text ───────────────────────────────────────────────────

type Variant = keyof typeof type;

/** Text in the app font; `variant` picks a size/weight from the type scale. */
export function T({ variant = 'body', style, ...rest }: TextProps & { variant?: Variant; style?: StyleProp<TextStyle> }) {
  return <Text {...rest} style={[type[variant] as TextStyle, style]} />;
}

// ── Icons ──────────────────────────────────────────────────

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

/** Monochrome outline icon (Ionicons), neutral by default. */
export function Icon({
  name,
  size = 20,
  color = colors.textDim,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
}) {
  return <Ionicons name={name} size={size} color={color} style={style} />;
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

export type Accent = 'green' | 'purple' | 'neutral';
const ACCENT_RGB: Record<Accent, string> = {
  green: '198, 244, 50',
  purple: '191, 90, 242',
  neutral: '255, 255, 255',
};

/** The gradient layers of GlassCard, for cards that are built elsewhere. */
export function glassFill(accent: Accent, corner = false): ViewStyle {
  const c = ACCENT_RGB[accent];
  const [strong, soft] = accent === 'neutral' ? [0.1, 0.03] : [0.16, 0.05];
  const tint = corner
    ? `radial-gradient(circle at 0% 0%, rgba(${c}, ${strong * 2.4}) 0%, rgba(${c}, ${soft * 2}) 35%, rgba(${c}, 0) 65%)`
    : `linear-gradient(0deg, rgba(${c}, ${strong}) 0%, rgba(${c}, ${soft}) 40%, rgba(${c}, 0) 70%)`;
  return {
    experimental_backgroundImage: tint + ', linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 35%)',
  } as ViewStyle;
}

/**
 * Glass card (the History card design): faint fill, hairline neutral edge,
 * a sheen at the top, and a soft tint of the field's accent rising from the
 * bottom and fading out by about the top third. `corner` puts the tint in
 * the top-left corner instead (History list).
 */
export function GlassCard({
  children,
  accent = 'neutral',
  corner = false,
  style,
  onPress,
}: {
  children: React.ReactNode;
  accent?: Accent;
  corner?: boolean;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
}) {
  const body = <View style={[styles.glass, glassFill(accent, corner), style]}>{children}</View>;
  return onPress ? (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress}>
      {body}
    </TouchableOpacity>
  ) : (
    body
  );
}

/** Small round container for an icon. */
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
  accent,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  subColor?: string;
  style?: StyleProp<ViewStyle>;
  valueColor?: string;
  accent?: Accent;
}) {
  const inner = (
    <>
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
    </>
  );
  return accent ? (
    <GlassCard accent={accent} style={[styles.tile, style]}>
      {inner}
    </GlassCard>
  ) : (
    <Card style={[styles.tile, style]}>{inner}</Card>
  );
}

// ── Buttons ────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export const BUTTON_COLORS: Record<ButtonVariant, { bg: string; fg: string }> = {
  primary: { bg: colors.accent, fg: colors.onAccent },
  secondary: { bg: colors.elevated, fg: colors.text },
  ghost: { bg: 'transparent', fg: colors.text },
  danger: { bg: colors.danger, fg: colors.white },
};

/** The one button of the app. */
export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  size = 'md',
  disabled,
  loading,
  style,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  size?: 'md' | 'sm';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}) {
  const c = BUTTON_COLORS[variant];
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={({ pressed }) => [
        styles.button,
        size === 'sm' && styles.buttonSmall,
        { backgroundColor: c.bg, opacity: off ? buttonStyle.disabledOpacity : pressed ? buttonStyle.pressedOpacity : 1 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={c.fg} />
      ) : (
        <>
          {icon ? <Icon name={icon} size={size === 'sm' ? 16 : 18} color={c.fg} /> : null}
          <Text style={[type.button as TextStyle, size === 'sm' && { fontSize: 14 }, { color: c.fg }]} numberOfLines={1}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Square icon-only button (back, close, next, chevrons): same look as Button. */
export function IconButton({
  icon,
  onPress,
  variant = 'secondary',
  size = 'md',
  disabled,
  style,
  accessibilityLabel,
}: {
  icon: IconName;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel: string;
}) {
  const c = BUTTON_COLORS[variant];
  const d = size === 'sm' ? buttonStyle.heightSmall : 44;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || !onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      style={({ pressed }) => [
        styles.iconButton,
        {
          width: d,
          height: d,
          backgroundColor: c.bg,
          opacity: disabled ? buttonStyle.disabledOpacity : pressed ? buttonStyle.pressedOpacity : 1,
        },
        style,
      ]}
    >
      <Icon name={icon} size={size === 'sm' ? 18 : 22} color={c.fg} />
    </Pressable>
  );
}

/** Kept for older call sites; same as <Button variant="primary">. */
export function PrimaryButton({
  label,
  onPress,
  style,
  disabled,
}: {
  label: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
}) {
  return <Button label={label} onPress={onPress} style={style} disabled={disabled} />;
}

/** Toggle chip (filters, options): the shared button shape, green when on. */
export function Pill({
  label,
  active,
  onPress,
  style,
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={({ pressed }) => [
        styles.pill,
        active && { backgroundColor: colors.accent },
        { opacity: pressed ? buttonStyle.pressedOpacity : 1 },
        style,
      ]}
    >
      <T variant="label" style={[{ fontFamily: fonts.semibold }, active && { color: colors.onAccent }]} numberOfLines={1}>
        {label}
      </T>
    </Pressable>
  );
}

// ── Headers ────────────────────────────────────────────────

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
  glass: {
    backgroundColor: colors.glass,
    borderRadius: radius.lg,
    padding: space.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  iconCircle: { alignItems: 'center', justifyContent: 'center' },
  tile: { flex: 1 },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: 2 },
  button: {
    height: buttonStyle.height,
    borderRadius: buttonStyle.radius,
    paddingHorizontal: buttonStyle.paddingX,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buttonSmall: { height: buttonStyle.heightSmall, paddingHorizontal: 14 },
  iconButton: { borderRadius: buttonStyle.radius, alignItems: 'center', justifyContent: 'center' },
  pill: {
    backgroundColor: colors.elevated,
    borderRadius: buttonStyle.radius,
    paddingHorizontal: 14,
    height: 36,
    justifyContent: 'center',
  },
  header: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: space.lg, gap: space.md },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: space.xl,
    marginBottom: space.md,
  },
});
