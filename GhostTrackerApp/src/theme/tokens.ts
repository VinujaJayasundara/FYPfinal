/**
 * EquiStride design tokens (UI revamp): near-black background, graphite
 * cards, two accents only (green for actions and progress, purple for the
 * NPI metric), red only for stop/errors, large rounded corners, Urbanist type.
 * Hierarchy comes from type weight, size and neutral shades, not colour. Every screen takes its colours, radii,
 * spacing and type from here.
 */

export const colors = {
  // Neutrals
  bg: '#0E0E10',
  surface: '#1C1C1F',
  elevated: '#2A2A2E',
  overlay: 'rgba(28, 28, 31, 0.86)', // see-through cards over the map
  border: '#2E2E33',
  hairline: 'rgba(255, 255, 255, 0.14)', // glass card edge
  glass: 'rgba(255, 255, 255, 0.045)', // glass card fill
  text: '#FFFFFF',
  textDim: '#A1A1A6', // labels, secondary text
  textFaint: '#636366', // captions, placeholders
  white: '#FFFFFF',

  // Accent 1 - green: actions, highlights, progress, solo runs
  accent: '#C6F432',
  accentDim: 'rgba(198, 244, 50, 0.16)',
  onAccent: '#0E0E10', // text on green

  // Accent 2 - purple: the NPI metric only
  npi: '#BF5AF2',
  npiDim: 'rgba(191, 90, 242, 0.16)',

  // Functional only: stop run, recording, delete, errors
  danger: '#FF3B30',
  dangerDim: 'rgba(255, 59, 48, 0.2)',

  scrim: 'rgba(0, 0, 0, 0.75)', // behind modals and over the map

  // Runs with a friend are neutral (white + link icon), not a third accent
  peer: '#E5E5EA',
  peerDim: 'rgba(255, 255, 255, 0.10)',

  // Older names kept so nothing breaks; they map onto the palette above
  good: '#C6F432',
  bad: '#FF3B30',
  warn: '#A1A1A6',
  info: '#A1A1A6',
} as const;

export const radius = {
  sm: 12,
  md: 18,
  lg: 24,
  xl: 28,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

/** Urbanist families (loaded in App.tsx). Android needs one family per weight. */
export const fonts = {
  regular: 'Urbanist_400Regular',
  medium: 'Urbanist_500Medium',
  semibold: 'Urbanist_600SemiBold',
  bold: 'Urbanist_700Bold',
  extrabold: 'Urbanist_800ExtraBold',
} as const;

export const type = {
  hero: { fontFamily: fonts.bold, fontSize: 30, color: colors.text, letterSpacing: -0.5 },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.text },
  section: { fontFamily: fonts.semibold, fontSize: 18, color: colors.text },
  body: { fontFamily: fonts.medium, fontSize: 15, color: colors.text },
  label: { fontFamily: fonts.medium, fontSize: 13, color: colors.textDim },
  eyebrow: { fontFamily: fonts.semibold, fontSize: 11, color: colors.textDim, letterSpacing: 1.2, textTransform: 'uppercase' as const },
  caption: { fontFamily: fonts.medium, fontSize: 11, color: colors.textFaint },
  value: { fontFamily: fonts.bold, fontSize: 20, color: colors.text, fontVariant: ['tabular-nums'] as const },
  bigNumber: { fontFamily: fonts.semibold, fontSize: 30, color: colors.text, fontVariant: ['tabular-nums'] as const },
  hugeNumber: { fontFamily: fonts.bold, fontSize: 44, color: colors.text, fontVariant: ['tabular-nums'] as const, letterSpacing: -1 },
  unit: { fontFamily: fonts.medium, fontSize: 13, color: colors.textDim },
  button: { fontFamily: fonts.bold, fontSize: 16, letterSpacing: 0.3 },
} as const;

/** One look for every button and icon button in the app. */
export const buttonStyle = {
  radius: 16,
  height: 52,
  heightSmall: 40,
  paddingX: 20,
  pressedOpacity: 0.7,
  disabledOpacity: 0.4,
} as const;

/** Solo (green) vs with-a-friend (neutral) colour: badges, routes, race strip. */
export const runColor = (withPeer: boolean): string => (withPeer ? colors.peer : colors.accent);
