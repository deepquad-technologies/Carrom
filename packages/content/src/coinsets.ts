import { buildItems, type CosmeticItem, type ItemRow, type Unlock } from './items';
import { RARITY, type Rarity } from './rarity';

/**
 * 50 carrom-man sets. A set recolours the men on the board; the queen keeps a
 * red-family tint drawn from the set's accent so it always reads as the queen.
 * Cosmetic only.
 */
const ROWS: ItemRow[] = [
  // ---------------------------------- common (16)
  ['set_classic', 'Classic', 'common', '#f4ecdc', '#ddd0b6', '#bfae8e', 'rim', 'none', 'none'],
  ['set_silver', 'Silver', 'common', '#dfe4ec', '#b4bcc8', '#868e9c', 'rim', 'none', 'none'],
  ['set_bronze', 'Bronze', 'common', '#c08a52', '#9c6a36', '#6f4a20', 'rim', 'none', 'none'],
  ['set_marble', 'Marble', 'common', '#f7f5f0', '#c4bcb0', '#8f877a', 'marble', 'none', 'none'],
  ['set_pearl', 'Pearl', 'common', '#f6f2ea', '#dcd4c6', '#b4aa98', 'marble', 'shimmer', 'none'],
  ['set_ocean', 'Ocean', 'common', '#3f8fc4', '#8fd0e8', '#255c8a', 'swirl', 'none', 'none'],
  ['set_forest', 'Forest', 'common', '#3f7a4a', '#7ab88a', '#245230', 'rim', 'none', 'none'],
  ['set_desert', 'Desert', 'common', '#ddc9a3', '#c4ac84', '#9c8663', 'marble', 'none', 'none'],
  ['set_ancient', 'Ancient', 'common', '#a58762', '#6d5638', '#453520', 'rings', 'none', 'none'],
  ['set_candy', 'Candy', 'common', '#ffffff', '#f0568a', '#c02f60', 'wedges', 'spin', 'none', 0.6],
  ['set_wolf', 'Wolf', 'common', '#8a929c', '#3f454d', '#23272d', 'marble', 'none', 'none'],
  ['set_falcon', 'Falcon', 'common', '#cdb79a', '#6b5638', '#453520', 'wedges', 'none', 'none'],
  ['set_tiger', 'Tiger', 'common', '#e8a33c', '#2a1c08', '#a86f18', 'wedges', 'none', 'none'],
  ['set_lion', 'Lion', 'common', '#e0a94c', '#8a5f1c', '#5c3f10', 'crown', 'none', 'none'],
  ['set_star', 'Star', 'common', '#f4f0e0', '#e0b040', '#a87c1c', 'star', 'none', 'none'],
  ['set_storm', 'Storm', 'common', '#6d7686', '#98a3b2', '#454d59', 'swirl', 'none', 'none'],

  // ---------------------------------- rare (14)
  ['set_royal', 'Royal', 'rare', '#3a2470', '#f2c94c', '#22163f', 'crown', 'shimmer', 'none'],
  ['set_gold', 'Gold', 'rare', '#1f1a12', '#e8c15c', '#8a6f22', 'rim', 'shimmer', 'none'],
  ['set_ruby', 'Ruby', 'rare', '#4a0a18', '#ff4d6d', '#8a1a30', 'gem', 'pulse', 'none'],
  ['set_sapphire', 'Sapphire', 'rare', '#0a1a4a', '#4d8aff', '#1a2f7a', 'gem', 'pulse', 'none'],
  ['set_emerald', 'Emerald', 'rare', '#08301f', '#3fd08a', '#0f5c3a', 'gem', 'pulse', 'none'],
  ['set_crystal', 'Crystal', 'rare', '#e6f2f8', '#b6d8e8', '#87aec2', 'prism', 'shimmer', 'none'],
  ['set_fire', 'Fire', 'rare', '#3a1a10', '#ff8a3c', '#1f0d07', 'flame', 'flicker', 'none'],
  ['set_ice', 'Ice', 'rare', '#e4f4fc', '#5cc8f0', '#2a7ea8', 'gem', 'shimmer', 'none'],
  ['set_neon', 'Neon', 'rare', '#12141c', '#39ffb0', '#080a10', 'rings', 'pulse', 'none', 1.3],
  ['set_shadow', 'Shadow', 'rare', '#22242a', '#5a5f6b', '#101216', 'marble', 'shimmer', 'none'],
  ['set_samurai', 'Samurai', 'rare', '#f0e6d8', '#c0392b', '#8a2820', 'blade', 'none', 'none'],
  ['set_ninja', 'Ninja', 'rare', '#23262c', '#c8ccd2', '#101216', 'split', 'none', 'none'],
  ['set_palace', 'Palace', 'rare', '#f3dcc6', '#b04a63', '#7a2740', 'crown', 'shimmer', 'none'],
  ['set_platinum', 'Platinum', 'rare', '#e8edf4', '#a8b4c4', '#78859a', 'rings', 'shimmer', 'none'],

  // ---------------------------------- epic (10)
  ['set_diamond', 'Diamond', 'epic', '#e8f4ff', '#8ae0ff', '#5c9cc8', 'gem', 'sparkle', 'none', 1.2],
  ['set_galaxy', 'Galaxy', 'epic', '#1a1240', '#a88aff', '#0c0824', 'marble', 'aurora', 'none'],
  ['set_phoenix', 'Phoenix', 'epic', '#3a1408', '#ff7a2b', '#a83a0c', 'flame', 'flicker', 'none'],
  ['set_dragon', 'Dragon', 'epic', '#123a2a', '#5ce0a0', '#0a2419', 'scale', 'shimmer', 'none'],
  ['set_aurora', 'Aurora', 'epic', '#0a1c2a', '#5cffd0', '#a88aff', 'prism', 'aurora', 'none'],
  ['set_cyber', 'Cyber', 'epic', '#0f2a1c', '#4dff9e', '#071710', 'circuit', 'flicker', 'none'],
  ['set_obsidian', 'Obsidian', 'epic', '#12141c', '#6ef0ff', '#05070b', 'gem', 'pulse', 'none'],
  ['set_treasure', 'Treasure', 'epic', '#2a1f08', '#ffd85c', '#8a6a1c', 'crown', 'shimmer', 'none'],
  ['set_titanium', 'Titanium', 'epic', '#5a6270', '#c8d2e0', '#333a45', 'circuit', 'shimmer', 'none'],
  ['set_meteor', 'Meteor', 'epic', '#3a2a1c', '#ff8a3c', '#1c1409', 'flame', 'flicker', 'none'],

  // ---------------------------------- mythic (7)
  ['set_cosmic', 'Cosmic', 'mythic', '#0a0614', '#c04dff', '#3a1a6b', 'orbit', 'aurora', 'none', 1.2],
  ['set_solar', 'Solar', 'mythic', '#3a2408', '#ffb43c', '#fff0c0', 'flame', 'flicker', 'none', 1.4],
  ['set_lunar', 'Lunar', 'mythic', '#141a2a', '#d8e4ff', '#8a9ac8', 'bullseye', 'shimmer', 'none', 1.2],
  ['set_rainbow', 'Rainbow', 'mythic', '#f4f7ff', '#7ce0ff', '#ff8ad4', 'prism', 'aurora', 'none', 1.4],
  ['set_festival', 'Festival', 'mythic', '#2a0a2a', '#ffd166', '#ff5a9e', 'star', 'sparkle', 'none', 1.3],
  ['set_thunder', 'Thunder', 'mythic', '#141a2a', '#ffe066', '#4a3a08', 'star', 'flicker', 'none', 1.5],
  ['set_eclipse', 'Eclipse', 'mythic', '#05060d', '#ffb85c', '#8affff', 'bullseye', 'aurora', 'none', 1.3],

  // ---------------------------------- legendary (3)
  ['set_infinity', 'Infinity', 'legendary', '#05060d', '#8affff', '#c88aff', 'orbit', 'aurora', 'none', 1.6],
  ['set_royal_crown', 'Royal Crown', 'legendary', '#1c1408', '#ffd85c', '#fff3c0', 'crown', 'sparkle', 'none', 1.4],
  ['set_ultimate', 'Ultimate', 'legendary', '#0a0a12', '#ffd85c', '#8affff', 'prism', 'aurora', 'none', 1.6],
];

export const STARTER_COIN_SETS = ['set_classic', 'set_silver', 'set_bronze'];

const UNLOCK_OVERRIDES: Record<string, Unlock> = {
  set_marble: { kind: 'level', level: 4 },
  set_pearl: { kind: 'level', level: 7 },
  set_ocean: { kind: 'shop', coins: 3_000 },
  set_forest: { kind: 'shop', coins: 3_000 },
  set_desert: { kind: 'shop', coins: 3_000 },
  set_ancient: { kind: 'shop', coins: 8_000 },
  set_royal: { kind: 'achievement', achievementId: 'ach_queen_master' },
  set_gold: { kind: 'tier', tierId: 'elite' },
  set_diamond: { kind: 'tier', tierId: 'champion' },
  set_ultimate: { kind: 'achievement', achievementId: 'ach_collector' },
  set_royal_crown: { kind: 'achievement', achievementId: 'ach_champion' },
};

export const COIN_SETS: CosmeticItem[] = buildItems(
  ROWS,
  'coin_set',
  STARTER_COIN_SETS,
  (rarity: Rarity) => (rarity === 'common' || rarity === 'rare' ? undefined : RARITY[rarity].glow),
  UNLOCK_OVERRIDES,
);

export const DEFAULT_COIN_SET_ID = 'set_classic';
