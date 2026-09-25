/**
 * Rakazo brand tokens — calm light theme shared across the mobile app.
 * Mirrors the rakazo.com design system: bright off-white, blue primary,
 * small red accent, generous whitespace, rounded cards, soft shadows.
 */

export const colors = {
  background: '#FDFDFD',
  card: '#FFFFFF',
  primary: '#2563EB',
  primaryDark: '#1D4ED8',
  primarySoft: '#EAF1FE',
  accent: '#FF5F57',
  accentSoft: '#FDECEA',
  text: '#3D3D3D',
  muted: '#8A8A8A',
  faint: '#B5B5B5',
  border: '#EFEFEF',
  success: '#16A34A',
  successSoft: '#E9F7EF',
  warning: '#D97706',
  warningSoft: '#FEF3E2',
  input: '#FFFFFF',
} as const;

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  full: 999,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
  xl: 26,
  hero: 32,
} as const;

export const shadow = {
  card: {
    shadowColor: '#1a1a1a',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 10,
    elevation: 2,
  },
} as const;
