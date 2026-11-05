/**
 * EquiStride design tokens (UI revamp): near-black background, graphite
 * cards, lime accent for solo runs, purple for runs with a friend, large
 * rounded corners, Urbanist type. Every screen takes its colours, radii,
 * spacing and type from here.
 */

export const colors = {
  bg: '#0E0E10',
  surface: '#1C1C1F',
  elevated: '#2A2A2E',
  overlay: 'rgba(28, 28, 31, 0.86)', // see-through cards over the map
  border: '#2E2E33',
  accent: '#C6F432', // lime: solo runs, primary actions
  accentDim: 'rgba(198, 244, 50, 0.16)',
  onAccent: '#0E0E10', // text on lime
  peer: '#BF5AF2', // runs with a friend, races
  peerDim: 'rgba(191, 90, 242, 0.16)',
  text: '#FFFFFF',
  textDim: '#8E8E93',
  textFaint: '#5C5C63',
  good: '#34C759',
  bad: '#FF453A',
  warn: '#FF9F0A',
  info: '#0A84FF',
  white: '#FFFFFF',
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
  caption: { fontFamily: fonts.medium, fontSize: 11, color: colors.textDim },
  bigNumber: { fontFamily: fonts.semibold, fontSize: 30, color: colors.text, fontVariant: ['tabular-nums'] as const },
  hugeNumber: { fontFamily: fonts.bold, fontSize: 44, color: colors.text, fontVariant: ['tabular-nums'] as const, letterSpacing: -1 },
  unit: { fontFamily: fonts.medium, fontSize: 13, color: colors.textDim },
} as const;

/** Solo vs peer colour, used everywhere (badges, routes, race strip). */
export const runColor = (withPeer: boolean): string => (withPeer ? colors.peer : colors.accent);
