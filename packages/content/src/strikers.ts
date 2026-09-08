import { buildItems, type CosmeticItem, type ItemRow, type Unlock } from './items';
import { RARITY, type Rarity } from './rarity';

/** 50 strikers. Purely cosmetic — none of these fields reach the physics engine. */
const ROWS: ItemRow[] = [
  // ---------------------------------- common (16)
  ['str_classic', 'Classic', 'common', '#f6efe1', '#e0d2b8', '#c9b894', 'rim', 'none', 'none'],
  ['str_silver_bullet', 'Silver Bullet', 'common', '#d8dee6', '#aeb7c2', '#7f8894', 'split', 'none', 'none'],
  ['str_storm', 'Storm', 'common', '#6d7686', '#98a3b2', '#454d59', 'swirl', 'none', 'dust'],
  ['str_crystal', 'Crystal', 'common', '#e6f2f8', '#b6d8e8', '#87aec2', 'gem', 'none', 'none'],
  ['str_frost', 'Frost', 'common', '#dff0fa', '#9cd0ea', '#5f9cbc', 'rings', 'none', 'ice'],
  ['str_shadow', 'Shadow', 'common', '#2b2f36', '#4a505a', '#15181d', 'solid', 'none', 'smoke'],
  ['str_emerald', 'Emerald', 'common', '#3fa87a', '#7fd0a8', '#257053', 'rim', 'none', 'none'],
  ['str_ninja', 'Ninja', 'common', '#23262c', '#c8ccd2', '#101216', 'split', 'none', 'smoke'],
  ['str_samurai', 'Samurai', 'common', '#f0e6d8', '#c0392b', '#8a2820', 'blade', 'none', 'none'],
  ['str_tiger', 'Tiger', 'common', '#e8a33c', '#2a1c08', '#a86f18', 'wedges', 'none', 'none'],
  ['str_falcon', 'Falcon', 'common', '#cdb79a', '#6b5638', '#453520', 'wedges', 'none', 'dust'],
  ['str_wolf', 'Wolf', 'common', '#8a929c', '#3f454d', '#23272d', 'marble', 'none', 'none'],
  ['str_lion', 'Lion', 'common', '#e0a94c', '#8a5f1c', '#5c3f10', 'crown', 'none', 'none'],
  ['str_solar', 'Solar', 'common', '#ffd27a', '#f09020', '#a85c0c', 'star', 'none', 'none'],
  ['str_lunar', 'Lunar', 'common', '#e4e8f2', '#9aa4bc', '#6a7288', 'bullseye', 'none', 'none'],
  ['str_titan', 'Titan', 'common', '#7a7f88', '#adb4bf', '#4c515a', 'rings', 'none', 'none'],

  // ---------------------------------- rare (14)
  ['str_thunder', 'Thunder', 'rare', '#1c2233', '#ffe066', '#0d1119', 'star', 'flicker', 'electric', 1.3],
  ['str_phoenix', 'Phoenix', 'rare', '#3a1408', '#ff7a2b', '#a83a0c', 'flame', 'pulse', 'fire', 1.1],
  ['str_royal', 'Royal', 'rare', '#3a2470', '#f2c94c', '#22163f', 'crown', 'shimmer', 'sparkle'],
  ['str_galaxy', 'Galaxy', 'rare', '#1a1240', '#a88aff', '#0c0824', 'marble', 'aurora', 'stardust'],
  ['str_inferno', 'Inferno', 'rare', '#2a0c06', '#ff5a1f', '#7a2408', 'flame', 'flicker', 'fire', 1.3],
  ['str_dragon', 'Dragon', 'rare', '#123a2a', '#5ce0a0', '#0a2419', 'scale', 'shimmer', 'none'],
  ['str_cosmic', 'Cosmic', 'rare', '#101a3a', '#6ec8ff', '#081024', 'orbit', 'orbit', 'stardust'],
  ['str_neon_pulse', 'Neon Pulse', 'rare', '#12141c', '#39ffb0', '#080a10', 'rings', 'pulse', 'electric', 1.4],
  ['str_eclipse', 'Eclipse', 'rare', '#14151c', '#ffb85c', '#000000', 'bullseye', 'pulse', 'none'],
  ['str_phantom', 'Phantom', 'rare', '#2a2c3a', '#8fa0c8', '#141620', 'swirl', 'shimmer', 'smoke'],
  ['str_starburst', 'Starburst', 'rare', '#ffe9a8', '#f0761d', '#a84a0c', 'star', 'spin', 'sparkle', 0.8],
  ['str_aurora', 'Aurora', 'rare', '#0a1c2a', '#5cffd0', '#a88aff', 'prism', 'aurora', 'rainbow'],
  ['str_plasma', 'Plasma', 'rare', '#1a0a2a', '#e05cff', '#0d0518', 'swirl', 'pulse', 'electric', 1.2],
  ['str_meteor', 'Meteor', 'rare', '#3a2a1c', '#ff8a3c', '#1c1409', 'flame', 'flicker', 'fire'],

  // ---------------------------------- epic (10)
  ['str_golden_crown', 'Golden Crown', 'epic', '#2a1f08', '#ffd85c', '#8a6a1c', 'crown', 'shimmer', 'sparkle', 1.1],
  ['str_cyber_strike', 'Cyber Strike', 'epic', '#0f2a1c', '#4dff9e', '#071710', 'circuit', 'flicker', 'electric', 1.2],
  ['str_samurai_gold', 'Samurai Gold', 'epic', '#1c1408', '#f2c94c', '#c0392b', 'blade', 'shimmer', 'sparkle'],
  ['str_diamond', 'Diamond', 'epic', '#e8f4ff', '#8ae0ff', '#5c9cc8', 'gem', 'sparkle', 'sparkle', 1.2],
  ['str_obsidian', 'Obsidian', 'epic', '#12141c', '#6ef0ff', '#05070b', 'gem', 'pulse', 'void', 1.1],
  ['str_ruby', 'Ruby', 'epic', '#4a0a18', '#ff4d6d', '#8a1a30', 'gem', 'shimmer', 'sparkle'],
  ['str_sapphire', 'Sapphire', 'epic', '#0a1a4a', '#4d8aff', '#1a2f7a', 'gem', 'shimmer', 'sparkle'],
  ['str_royal_knight', 'Royal Knight', 'epic', '#1c2a4a', '#c8d4f0', '#f2c94c', 'crown', 'shimmer', 'sparkle'],
  ['str_shadow_knight', 'Shadow Knight', 'epic', '#0d0f14', '#8a4dff', '#2a1a4a', 'blade', 'pulse', 'void', 1.1],
  ['str_emerald_king', 'Emerald King', 'epic', '#08301f', '#3fffb0', '#0f5c3a', 'crown', 'aurora', 'sparkle'],

  // ---------------------------------- mythic (7)
  ['str_thunder_king', 'Thunder King', 'mythic', '#141a2a', '#ffe066', '#4a3a08', 'star', 'flicker', 'electric', 1.6],
  ['str_fire_king', 'Fire King', 'mythic', '#2a0a08', '#ff5a1f', '#ffca3a', 'flame', 'flicker', 'fire', 1.5],
  ['str_ice_king', 'Ice King', 'mythic', '#0a2436', '#8ae8ff', '#c8f4ff', 'prism', 'shimmer', 'ice', 1.3],
  ['str_cosmic_king', 'Cosmic King', 'mythic', '#0a0614', '#c04dff', '#3a1a6b', 'orbit', 'aurora', 'stardust', 1.3],
  ['str_dragon_king', 'Dragon King', 'mythic', '#0f3a2a', '#4dffb0', '#083020', 'scale', 'shimmer', 'fire', 1.3],
  ['str_phoenix_king', 'Phoenix King', 'mythic', '#3a0c04', '#ff8a1f', '#ffe066', 'flame', 'flicker', 'fire', 1.6],
  ['str_galaxy_king', 'Galaxy King', 'mythic', '#0c0a24', '#8a8aff', '#e0d0ff', 'orbit', 'aurora', 'stardust', 1.4],

  // ---------------------------------- legendary (3)
  ['str_ultimate', 'Ultimate', 'legendary', '#0a0a12', '#ffd85c', '#8affff', 'prism', 'aurora', 'rainbow', 1.6],
  ['str_legendary_one', 'Legendary One', 'legendary', '#1a1408', '#ffd85c', '#fff3c0', 'crown', 'sparkle', 'sparkle', 1.5],
  ['str_mythic_strike', 'Mythic Strike', 'legendary', '#05060d', '#8affff', '#c88aff', 'gem', 'aurora', 'void', 1.7],
];

export const STARTER_STRIKERS = ['str_classic', 'str_silver_bullet', 'str_shadow'];

const UNLOCK_OVERRIDES: Record<string, Unlock> = {
  str_storm: { kind: 'level', level: 3 },
  str_crystal: { kind: 'level', level: 5 },
  str_frost: { kind: 'level', level: 8 },
  str_tiger: { kind: 'shop', coins: 4_000 },
  str_falcon: { kind: 'shop', coins: 4_000 },
  str_wolf: { kind: 'shop', coins: 6_000 },
  str_lion: { kind: 'shop', coins: 12_000 },
  str_thunder: { kind: 'achievement', achievementId: 'ach_win_10' },
  str_royal: { kind: 'achievement', achievementId: 'ach_win_50' },
  str_golden_crown: { kind: 'achievement', achievementId: 'ach_win_100' },
  str_ultimate: { kind: 'achievement', achievementId: 'ach_grandmaster' },
  str_legendary_one: { kind: 'achievement', achievementId: 'ach_tournament_winner' },
};

export const STRIKERS: CosmeticItem[] = buildItems(
  ROWS,
  'striker',
  STARTER_STRIKERS,
  (rarity: Rarity) => (rarity === 'common' || rarity === 'rare' ? undefined : RARITY[rarity].glow),
  UNLOCK_OVERRIDES,
);

export const DEFAULT_STRIKER_ID = 'str_classic';
