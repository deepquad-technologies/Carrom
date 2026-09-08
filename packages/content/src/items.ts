import type { Rarity } from './rarity';

/**
 * Cosmetics are drawing recipes, not images. The same record renders on canvas
 * (web) and SVG (mobile), scales to any board size, needs no download, and — by
 * design — carries nothing the physics engine ever reads. Cosmetics never
 * affect gameplay.
 */
export type SkinPattern =
  | 'solid'
  | 'rim'
  | 'rings'
  | 'bullseye'
  | 'checker'
  | 'split'
  | 'swirl'
  | 'star'
  | 'wedges'
  | 'marble'
  | 'circuit'
  | 'gem'
  | 'flame'
  | 'orbit'
  | 'scale'
  | 'prism'
  | 'crown'
  | 'blade';

export type SkinAnim =
  | 'none'
  | 'spin'
  | 'pulse'
  | 'shimmer'
  | 'orbit'
  | 'flicker'
  | 'aurora'
  | 'sparkle'
  | 'ripple';

/** Particle trail drawn behind a moving striker. */
export type TrailEffect =
  | 'none'
  | 'dust'
  | 'sparkle'
  | 'fire'
  | 'ice'
  | 'smoke'
  | 'electric'
  | 'stardust'
  | 'petals'
  | 'rainbow'
  | 'void';

export type UnlockKind = 'starter' | 'level' | 'crate' | 'achievement' | 'shop' | 'tier';

export interface Unlock {
  kind: UnlockKind;
  /** Level required, for `level` unlocks. */
  level?: number;
  /** Achievement id, for `achievement` unlocks. */
  achievementId?: string;
  /** Virtual coin price, for `shop` unlocks. */
  coins?: number;
  /** Match tier that must be reached, for `tier` unlocks. */
  tierId?: string;
}

export interface CosmeticItem {
  id: string;
  name: string;
  category: 'striker' | 'coin_set';
  rarity: Rarity;
  /** Face colour. */
  base: string;
  /** Pattern colour. */
  accent: string;
  /** Edge colour. */
  rim: string;
  pattern: SkinPattern;
  anim: SkinAnim;
  /** Animation speed multiplier; 1 is the natural rate. */
  speed: number;
  trail: TrailEffect;
  glow?: string;
  unlock: Unlock;
}

export type ItemRow = [
  id: string,
  name: string,
  rarity: Rarity,
  base: string,
  accent: string,
  rim: string,
  pattern: SkinPattern,
  anim: SkinAnim,
  trail: TrailEffect,
  speed?: number,
];

const UNLOCK_BY_RARITY: Record<Rarity, Unlock> = {
  common: { kind: 'crate' },
  rare: { kind: 'crate' },
  epic: { kind: 'crate' },
  mythic: { kind: 'crate' },
  legendary: { kind: 'crate' },
};

export function buildItems(
  rows: ItemRow[],
  category: 'striker' | 'coin_set',
  starters: string[],
  glowFor: (rarity: Rarity) => string | undefined,
  unlockOverrides: Record<string, Unlock> = {},
): CosmeticItem[] {
  return rows.map(([id, name, rarity, base, accent, rim, pattern, anim, trail, speed]) => ({
    id,
    name,
    category,
    rarity,
    base,
    accent,
    rim,
    pattern,
    anim,
    speed: speed ?? 1,
    trail,
    glow: glowFor(rarity),
    unlock:
      unlockOverrides[id] ??
      (starters.includes(id) ? { kind: 'starter' } : UNLOCK_BY_RARITY[rarity]),
  }));
}
