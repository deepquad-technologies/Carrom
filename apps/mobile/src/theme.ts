import { StyleSheet } from 'react-native';

/** Shared palette and building blocks, mirroring the web app's look. */
export const colors = {
  bg: '#07080d',
  surface: '#0c0e15',
  surfaceAlt: '#12151f',
  border: 'rgba(255,255,255,0.10)',
  borderStrong: 'rgba(255,255,255,0.20)',
  text: 'rgba(255,255,255,0.92)',
  textMuted: 'rgba(255,255,255,0.48)',
  textFaint: 'rgba(255,255,255,0.30)',
  brass: '#f2c94c',
  brassDark: '#b3862a',
  felt: '#2fae7f',
  danger: '#ef4444',
  rare: '#4aa8f0',
  epic: '#a78bfa',
  mythic: '#f2618c',
  legendary: '#f2c94c',
};

export const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  content: {
    padding: 16,
    gap: 14,
  },
  panel: {
    backgroundColor: colors.surface,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 16,
  },
  panelTight: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  title: {
    color: colors.text,
    fontSize: 26,
    fontWeight: '800',
  },
  heading: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  body: {
    color: colors.text,
    fontSize: 14,
  },
  muted: {
    color: colors.textMuted,
    fontSize: 13,
  },
  faint: {
    color: colors.textFaint,
    fontSize: 11,
  },
  button: {
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  buttonPrimary: {
    backgroundColor: colors.brass,
  },
  buttonPrimaryText: {
    color: '#07080d',
    fontWeight: '800',
    fontSize: 15,
  },
  buttonGhost: {
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  buttonGhostText: {
    color: colors.text,
    fontWeight: '700',
    fontSize: 14,
  },
  buttonDanger: {
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.4)',
    backgroundColor: 'rgba(239,68,68,0.12)',
  },
  buttonDangerText: {
    color: '#fca5a5',
    fontWeight: '700',
    fontSize: 14,
  },
  input: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 13,
    color: colors.text,
    fontSize: 15,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  chipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export const rarityColor: Record<string, string> = {
  common: '#9aa5b1',
  rare: colors.rare,
  epic: colors.epic,
  mythic: colors.mythic,
  legendary: colors.legendary,
};
