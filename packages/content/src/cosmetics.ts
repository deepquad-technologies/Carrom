import type { Unlock } from './items';
import { RARITY, type Rarity } from './rarity';

/**
 * Profile cosmetics: avatars, frames, banners, badges and victory animations.
 *
 * Like strikers and coin sets these are drawing recipes rather than images, and
 * they reuse the same emblem vocabulary the men are drawn with — so adding one
 * is a data change, nothing downloads, and everything scales.
 *
 * None of it touches gameplay. A profile cosmetic is seen between matches and
 * on the scoreboard; it never reaches the physics engine.
 */

/** Shapes an avatar, badge or frame can be built from. */
export type Emblem =
  | 'crown'
  | 'star'
  | 'flame'
  | 'gem'
  | 'blade'
  | 'orbit'
  | 'prism'
  | 'scale'
  | 'circuit'
  | 'swirl'
  | 'wedges'
  | 'rings'
  | 'bullseye'
  | 'bolt'
  | 'shield'
  | 'leaf';

export interface Avatar {
  id: string;
  name: string;
  rarity: Rarity;
  /** Disc colour. */
  base: string;
  /** Emblem colour. */
  accent: string;
  emblem: Emblem;
  unlock: Unlock;
}

type AvatarRow = [string, string, Rarity, string, string, Emblem];

const AVATAR_ROWS: AvatarRow[] = [
  // common
  ['av_teak', 'Teak', 'common', '#8a5a2b', '#e0c08a', 'rings'],
  ['av_ivory', 'Ivory', 'common', '#e8ddc6', '#8a7a5c', 'bullseye'],
  ['av_slate', 'Slate', 'common', '#5a6270', '#c8d2e0', 'wedges'],
  ['av_moss', 'Moss', 'common', '#4a6b42', '#b8d8a8', 'leaf'],
  ['av_clay', 'Clay', 'common', '#9c5240', '#f0c8b0', 'swirl'],
  ['av_denim', 'Denim', 'common', '#3f5375', '#a8c0e0', 'shield'],
  ['av_sand', 'Sand', 'common', '#c4a878', '#5c4a2c', 'rings'],
  ['av_pearl', 'Pearl', 'common', '#e0dad0', '#8a8078', 'prism'],

  // rare
  ['av_ember', 'Ember', 'rare', '#7a2810', '#ff8a3c', 'flame'],
  ['av_tide', 'Tide', 'rare', '#1f5c78', '#7fd0e8', 'swirl'],
  ['av_jade', 'Jade', 'rare', '#1f6b52', '#5ce0a8', 'gem'],
  ['av_bolt', 'Bolt', 'rare', '#2a2f42', '#ffe066', 'bolt'],
  ['av_rose', 'Rose', 'rare', '#7a2440', '#ff9ec0', 'star'],
  ['av_steel', 'Steel', 'rare', '#4a5260', '#d8e0ea', 'circuit'],

  // epic
  ['av_phoenix', 'Phoenix', 'epic', '#4a1408', '#ff7a2b', 'flame'],
  ['av_nebula', 'Nebula', 'epic', '#2a1a4a', '#c08aff', 'orbit'],
  ['av_dragon', 'Dragon', 'epic', '#0f3a2a', '#4dffb0', 'scale'],
  ['av_obsidian', 'Obsidian', 'epic', '#14161f', '#6ef0ff', 'gem'],
  ['av_saffron', 'Saffron', 'epic', '#7a4a08', '#ffc94c', 'star'],

  // mythic
  ['av_sovereign', 'Sovereign', 'mythic', '#2a1f08', '#ffd85c', 'crown'],
  ['av_aurora', 'Aurora', 'mythic', '#0a1c2a', '#5cffd0', 'prism'],
  ['av_warlord', 'Warlord', 'mythic', '#3a0c14', '#ff5a5a', 'blade'],

  // legendary
  ['av_legend', 'Legend', 'legendary', '#12100a', '#ffd85c', 'crown'],
  ['av_eclipse', 'Eclipse', 'legendary', '#05060d', '#8affff', 'orbit'],
];

/** Ring drawn around the avatar. */
export type FrameStyle =
  | 'plain'
  | 'double'
  | 'beaded'
  | 'laurel'
  | 'spikes'
  | 'glow'
  | 'runes'
  | 'chevrons';

export interface ProfileFrame {
  id: string;
  name: string;
  rarity: Rarity;
  color: string;
  accent: string;
  style: FrameStyle;
  /** Slow rotation, for the higher rarities. */
  animated: boolean;
  unlock: Unlock;
}

type FrameRow = [string, string, Rarity, string, string, FrameStyle, boolean];

const FRAME_ROWS: FrameRow[] = [
  ['fr_none', 'No frame', 'common', '#5a6270', '#8a93a6', 'plain', false],
  ['fr_wood', 'Teak Ring', 'common', '#8a5a2b', '#d9a05c', 'plain', false],
  ['fr_rope', 'Rope', 'common', '#a08050', '#e0c090', 'beaded', false],
  ['fr_steel', 'Steel', 'common', '#6a7280', '#c8d2e0', 'double', false],
  ['fr_bronze', 'Bronze', 'rare', '#8a5220', '#cd7f32', 'double', false],
  ['fr_laurel', 'Laurel', 'rare', '#3a6b3a', '#8ad48a', 'laurel', false],
  ['fr_tide', 'Tidecrest', 'rare', '#1f5c78', '#7fd0e8', 'chevrons', false],
  ['fr_silver', 'Silver', 'rare', '#7a8494', '#e4ecf4', 'double', false],
  ['fr_gold', 'Gold Laurel', 'epic', '#8a6a1c', '#f2c94c', 'laurel', true],
  ['fr_ember', 'Ember Ring', 'epic', '#7a2810', '#ff8a3c', 'spikes', true],
  ['fr_runes', 'Runebound', 'epic', '#2a1a4a', '#a78bfa', 'runes', true],
  ['fr_frost', 'Frostbound', 'epic', '#2a5c78', '#8ae8ff', 'spikes', true],
  ['fr_royal', 'Royal Crest', 'mythic', '#5c1d2e', '#f2618c', 'runes', true],
  ['fr_aurora', 'Aurora Halo', 'mythic', '#0a1c2a', '#5cffd0', 'glow', true],
  ['fr_champion', 'Champion', 'mythic', '#2a1f08', '#ffd85c', 'laurel', true],
  ['fr_legend', 'Legend Halo', 'legendary', '#12100a', '#ffe58a', 'glow', true],
];

/** Backdrop strip shown behind a profile. */
export type BannerPattern = 'plain' | 'rays' | 'waves' | 'grid' | 'stars' | 'confetti';

export interface Banner {
  id: string;
  name: string;
  rarity: Rarity;
  from: string;
  to: string;
  accent: string;
  pattern: BannerPattern;
  unlock: Unlock;
}

type BannerRow = [string, string, Rarity, string, string, string, BannerPattern];

const BANNER_ROWS: BannerRow[] = [
  ['bn_teak', 'Teak Parlour', 'common', '#3a2611', '#6d4526', '#c98a3c', 'plain'],
  ['bn_club', 'Club Green', 'common', '#0f2117', '#2f5d3f', '#57b37a', 'plain'],
  ['bn_dusk', 'Dusk', 'common', '#1a1c26', '#3a4050', '#8a93a6', 'waves'],
  ['bn_sunrise', 'Sunrise', 'rare', '#4a2408', '#c06820', '#ffc94c', 'rays'],
  ['bn_tide', 'Tideline', 'rare', '#07202b', '#1f5c78', '#7fd0e8', 'waves'],
  ['bn_jungle', 'Jungle', 'rare', '#0d1a0a', '#2c4a26', '#7fc45c', 'plain'],
  ['bn_neon', 'Neon Grid', 'epic', '#05070c', '#12241c', '#39ffb0', 'grid'],
  ['bn_galaxy', 'Galaxy', 'epic', '#08061a', '#241a4a', '#a78bfa', 'stars'],
  ['bn_ember', 'Emberfall', 'epic', '#1a0804', '#4a1408', '#ff7a2b', 'rays'],
  ['bn_festival', 'Festival', 'mythic', '#1c0714', '#6a1f4a', '#ffd166', 'confetti'],
  ['bn_aurora', 'Aurora', 'mythic', '#08161e', '#0a2c3c', '#5cffd0', 'waves'],
  ['bn_legend', 'Legend', 'legendary', '#12100a', '#3a2f10', '#ffd85c', 'rays'],
];

export interface Badge {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  color: string;
  accent: string;
  emblem: Emblem;
  unlock: Unlock;
}

type BadgeRow = [string, string, string, Rarity, string, string, Emblem];

const BADGE_ROWS: BadgeRow[] = [
  ['bd_first_win', 'First Win', 'Won a match.', 'common', '#3a6b3a', '#8ad48a', 'star'],
  ['bd_ten', 'Ten Up', 'Won ten matches.', 'common', '#4a5260', '#d8e0ea', 'shield'],
  ['bd_sharp', 'Sharp Shooter', 'Pocketed 500 men.', 'rare', '#1f5c78', '#7fd0e8', 'bolt'],
  ['bd_queen', 'Queen Taker', 'Covered the queen 25 times.', 'rare', '#7a2440', '#ff9ec0', 'crown'],
  ['bd_streak', 'On a Roll', 'Five wins in a row.', 'rare', '#7a2810', '#ff8a3c', 'flame'],
  ['bd_perfect', 'Flawless', 'Won a perfect game.', 'epic', '#2a1a4a', '#a78bfa', 'gem'],
  ['bd_hundred', 'Centurion', 'Won a hundred matches.', 'epic', '#8a6a1c', '#f2c94c', 'shield'],
  ['bd_collector', 'Collector', 'Owned sixty cosmetics.', 'epic', '#1f6b52', '#5ce0a8', 'prism'],
  ['bd_tournament', 'Tournament Victor', 'Won a tournament.', 'mythic', '#5c1d2e', '#f2618c', 'crown'],
  ['bd_season', 'Season Champion', 'Finished a season in Master.', 'mythic', '#0a1c2a', '#5cffd0', 'star'],
  ['bd_grandmaster', 'Grandmaster', 'Reached Grandmaster.', 'legendary', '#12100a', '#ffd85c', 'crown'],
];

/** Played over the victory screen when a match is won. */
export type VictoryEffect =
  | 'golden_burst'
  | 'confetti'
  | 'fireworks'
  | 'lightning'
  | 'crown'
  | 'champion_entrance'
  | 'aurora'
  | 'shockwave';

export interface VictoryAnimation {
  id: string;
  name: string;
  rarity: Rarity;
  effect: VictoryEffect;
  primary: string;
  secondary: string;
  /** Milliseconds the flourish runs for. */
  durationMs: number;
  unlock: Unlock;
}

type VictoryRow = [string, string, Rarity, VictoryEffect, string, string, number];

const VICTORY_ROWS: VictoryRow[] = [
  ['vc_burst', 'Golden Burst', 'common', 'golden_burst', '#ffd85c', '#ff9a2b', 2200],
  ['vc_confetti', 'Confetti', 'common', 'confetti', '#ff5a9e', '#4dd0e1', 2600],
  ['vc_shockwave', 'Shockwave', 'rare', 'shockwave', '#7fd0e8', '#ffffff', 1800],
  ['vc_fireworks', 'Fireworks', 'rare', 'fireworks', '#ffd166', '#ff5a9e', 3000],
  ['vc_lightning', 'Lightning', 'epic', 'lightning', '#ffe066', '#8affff', 2000],
  ['vc_aurora', 'Aurora Veil', 'epic', 'aurora', '#5cffd0', '#a88aff', 3200],
  ['vc_crown', 'Crown Descent', 'mythic', 'crown', '#ffd85c', '#fff3c0', 2800],
  ['vc_champion', 'Champion Entrance', 'legendary', 'champion_entrance', '#ffd85c', '#ff7a2b', 3600],
];

/* -------------------------------- assembly -------------------------------- */

/** Items everyone starts with, so a new profile is never blank. */
export const STARTER_COSMETICS = ['av_teak', 'av_ivory', 'fr_none', 'fr_wood', 'bn_teak', 'vc_burst'];

function unlockFor(id: string, rarity: Rarity, achievementId?: string): Unlock {
  if (STARTER_COSMETICS.includes(id)) return { kind: 'starter' };
  if (achievementId) return { kind: 'achievement', achievementId };
  return { kind: 'crate' };
}

/** Badges are earned, never dropped, so each maps to an achievement. */
const BADGE_ACHIEVEMENTS: Record<string, string> = {
  bd_first_win: 'ach_first_win',
  bd_ten: 'ach_win_10',
  bd_queen: 'ach_queen_master',
  bd_streak: 'ach_streak_5',
  bd_perfect: 'ach_perfect',
  bd_hundred: 'ach_win_100',
  bd_collector: 'ach_collector',
  bd_tournament: 'ach_tournament_winner',
  bd_grandmaster: 'ach_grandmaster',
};

export const AVATARS: Avatar[] = AVATAR_ROWS.map(([id, name, rarity, base, accent, emblem]) => ({
  id, name, rarity, base, accent, emblem, unlock: unlockFor(id, rarity),
}));

export const FRAMES: ProfileFrame[] = FRAME_ROWS.map(
  ([id, name, rarity, color, accent, style, animated]) => ({
    id, name, rarity, color, accent, style, animated, unlock: unlockFor(id, rarity),
  }),
);

export const BANNERS: Banner[] = BANNER_ROWS.map(
  ([id, name, rarity, from, to, accent, pattern]) => ({
    id, name, rarity, from, to, accent, pattern, unlock: unlockFor(id, rarity),
  }),
);

export const BADGES: Badge[] = BADGE_ROWS.map(
  ([id, name, description, rarity, color, accent, emblem]) => ({
    id, name, description, rarity, color, accent, emblem,
    unlock: unlockFor(id, rarity, BADGE_ACHIEVEMENTS[id]),
  }),
);

export const VICTORY_ANIMATIONS: VictoryAnimation[] = VICTORY_ROWS.map(
  ([id, name, rarity, effect, primary, secondary, durationMs]) => ({
    id, name, rarity, effect, primary, secondary, durationMs, unlock: unlockFor(id, rarity),
  }),
);

export const DEFAULT_AVATAR_ID = 'av_teak';
export const DEFAULT_FRAME_ID = 'fr_none';
export const DEFAULT_BANNER_ID = 'bn_teak';
export const DEFAULT_VICTORY_ID = 'vc_burst';

const AVATAR_BY_ID = new Map(AVATARS.map((a) => [a.id, a]));
const FRAME_BY_ID = new Map(FRAMES.map((f) => [f.id, f]));
const BANNER_BY_ID = new Map(BANNERS.map((b) => [b.id, b]));
const BADGE_BY_ID = new Map(BADGES.map((b) => [b.id, b]));
const VICTORY_BY_ID = new Map(VICTORY_ANIMATIONS.map((v) => [v.id, v]));

export function avatarById(id: string | null | undefined): Avatar {
  return (id ? AVATAR_BY_ID.get(id) : undefined) ?? AVATAR_BY_ID.get(DEFAULT_AVATAR_ID)!;
}

export function frameById(id: string | null | undefined): ProfileFrame {
  return (id ? FRAME_BY_ID.get(id) : undefined) ?? FRAME_BY_ID.get(DEFAULT_FRAME_ID)!;
}

export function bannerById(id: string | null | undefined): Banner {
  return (id ? BANNER_BY_ID.get(id) : undefined) ?? BANNER_BY_ID.get(DEFAULT_BANNER_ID)!;
}

export function badgeById(id: string | null | undefined): Badge | undefined {
  return id ? BADGE_BY_ID.get(id) : undefined;
}

export function victoryById(id: string | null | undefined): VictoryAnimation {
  return (id ? VICTORY_BY_ID.get(id) : undefined) ?? VICTORY_BY_ID.get(DEFAULT_VICTORY_ID)!;
}

export const COSMETIC_COUNTS = {
  avatars: AVATARS.length,
  frames: FRAMES.length,
  banners: BANNERS.length,
  badges: BADGES.length,
  victoryAnimations: VICTORY_ANIMATIONS.length,
};

export function rarityOfCosmetic(rarity: Rarity): string {
  return RARITY[rarity].color;
}
