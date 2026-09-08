export type Rarity = 'common' | 'rare' | 'epic' | 'mythic' | 'legendary';

export const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'mythic', 'legendary'];

export interface RarityMeta {
  id: Rarity;
  name: string;
  color: string;
  glow: string;
  /** Card border treatment used across inventory, crates and reward reveals. */
  border: string;
  /** Reveal animation played when the item drops from a crate. */
  reveal: 'fade' | 'pop' | 'burst' | 'shatter' | 'ascend';
  /** Coins a duplicate converts into. */
  duplicateValue: number;
  /** Fragments a duplicate also grants, toward crafting. */
  fragmentValue: number;
}

export const RARITY: Record<Rarity, RarityMeta> = {
  common: {
    id: 'common', name: 'Common', color: '#9aa5b1', glow: 'rgba(154,165,177,0.35)',
    border: 'linear-gradient(135deg,#8d97a3,#c3cad3)', reveal: 'fade',
    duplicateValue: 150, fragmentValue: 5,
  },
  rare: {
    id: 'rare', name: 'Rare', color: '#4aa8f0', glow: 'rgba(74,168,240,0.45)',
    border: 'linear-gradient(135deg,#2b7fc4,#7fd0ff)', reveal: 'pop',
    duplicateValue: 600, fragmentValue: 20,
  },
  epic: {
    id: 'epic', name: 'Epic', color: '#a78bfa', glow: 'rgba(167,139,250,0.55)',
    border: 'linear-gradient(135deg,#7c5cf0,#c9b3ff)', reveal: 'burst',
    duplicateValue: 2_400, fragmentValue: 60,
  },
  mythic: {
    id: 'mythic', name: 'Mythic', color: '#f2618c', glow: 'rgba(242,97,140,0.6)',
    border: 'linear-gradient(135deg,#d8306c,#ff9ec0)', reveal: 'shatter',
    duplicateValue: 9_000, fragmentValue: 180,
  },
  legendary: {
    id: 'legendary', name: 'Legendary', color: '#f2c94c', glow: 'rgba(242,201,76,0.7)',
    border: 'linear-gradient(135deg,#e0a020,#fff0b0)', reveal: 'ascend',
    duplicateValue: 30_000, fragmentValue: 600,
  },
};

/** Base drop weights. Individual crates override these. */
export const BASE_DROP_WEIGHTS: Record<Rarity, number> = {
  common: 62,
  rare: 26,
  epic: 9,
  mythic: 2.6,
  legendary: 0.4,
};

export function rarityColor(rarity: Rarity): string {
  return RARITY[rarity].color;
}

export function rarityRank(rarity: Rarity): number {
  return RARITY_ORDER.indexOf(rarity);
}
