import { BOARDS } from './boards';
import { COIN_SETS } from './coinsets';
import { AVATARS, BADGES, BANNERS, FRAMES, VICTORY_ANIMATIONS } from './cosmetics';
import { STRIKERS } from './strikers';
import type { Rarity } from './rarity';

/**
 * Collections.
 *
 * Every cosmetic belongs to exactly one collection, and each collection has
 * milestones at a quarter, a half, three quarters and the full set. Milestones
 * pay out once — the server keys them so a recount can never pay twice — and
 * the rewards are deliberately generous at the top, because completing fifty
 * strikers is a long road.
 */
export type CollectionId =
  | 'strikers'
  | 'coin_sets'
  | 'boards'
  | 'avatars'
  | 'frames'
  | 'banners'
  | 'badges'
  | 'victory';

export interface CollectionDef {
  id: CollectionId;
  name: string;
  /** Plural noun used in progress copy, e.g. "37 of 50 strikers". */
  noun: string;
  /** Which `items.category` rows belong to it. */
  category: string;
  total: number;
  icon: string;
  accent: string;
}

export const COLLECTIONS: CollectionDef[] = [
  { id: 'strikers', name: 'Strikers', noun: 'strikers', category: 'striker', total: STRIKERS.length, icon: '\u{1F3AF}', accent: '#f2c94c' },
  { id: 'coin_sets', name: 'Coin Sets', noun: 'coin sets', category: 'coin_set', total: COIN_SETS.length, icon: '\u{1FA99}', accent: '#4dd6a0' },
  { id: 'boards', name: 'Boards', noun: 'boards', category: 'board', total: BOARDS.length, icon: '\u{1F532}', accent: '#4aa8f0' },
  { id: 'avatars', name: 'Avatars', noun: 'avatars', category: 'avatar', total: AVATARS.length, icon: '\u{1F464}', accent: '#a78bfa' },
  { id: 'frames', name: 'Frames', noun: 'frames', category: 'frame', total: FRAMES.length, icon: '\u{1F5BC}', accent: '#f2618c' },
  { id: 'banners', name: 'Banners', noun: 'banners', category: 'banner', total: BANNERS.length, icon: '\u{1F3F3}', accent: '#7fd0e8' },
  { id: 'badges', name: 'Badges', noun: 'badges', category: 'badge', total: BADGES.length, icon: '\u{1F3C5}', accent: '#ffb43c' },
  { id: 'victory', name: 'Victory Effects', noun: 'victory effects', category: 'victory', total: VICTORY_ANIMATIONS.length, icon: '\u{2728}', accent: '#ffd85c' },
];

export const COLLECTION_TOTAL = COLLECTIONS.reduce((sum, c) => sum + c.total, 0);

export interface MilestoneReward {
  /** Fraction of the collection owned, 0..1. */
  at: number;
  label: string;
  coins: number;
  xp: number;
  crateKind?: 'rookie' | 'champion' | 'legendary';
  /** Granted only by the full-set milestone of the larger collections. */
  titleId?: string;
}

/**
 * The same ladder for every collection; the payout scales with how many items
 * the collection holds, so finishing fifty strikers pays more than finishing
 * eight victory effects.
 */
export const MILESTONES: MilestoneReward[] = [
  { at: 0.25, label: 'A quarter collected', coins: 1_500, xp: 150 },
  { at: 0.5, label: 'Halfway there', coins: 5_000, xp: 400, crateKind: 'rookie' },
  { at: 0.75, label: 'Three quarters collected', coins: 15_000, xp: 900, crateKind: 'champion' },
  { at: 1, label: 'Complete set', coins: 50_000, xp: 2_500, crateKind: 'legendary' },
];

/** Reward for a milestone, scaled by collection size. */
export function milestoneReward(
  collection: CollectionDef,
  milestone: MilestoneReward,
): { coins: number; xp: number; crateKind?: string } {
  // A 50-item collection pays full rate; smaller ones pay proportionally.
  const scale = Math.max(0.3, collection.total / 50);
  return {
    coins: Math.round(milestone.coins * scale),
    xp: Math.round(milestone.xp * scale),
    crateKind: milestone.crateKind,
  };
}

/** Stable id so a milestone is only ever paid once. */
export function milestoneId(collection: CollectionId, at: number): string {
  return `${collection}:${Math.round(at * 100)}`;
}

export interface CollectionProgress {
  id: CollectionId;
  name: string;
  noun: string;
  icon: string;
  accent: string;
  owned: number;
  total: number;
  /** 0..100, rounded to one decimal. */
  percent: number;
  /** Owned count broken down by rarity. */
  byRarity: Record<Rarity, { owned: number; total: number }>;
  milestones: Array<{
    id: string;
    at: number;
    label: string;
    reached: boolean;
    claimed: boolean;
    coins: number;
    xp: number;
    crateKind?: string;
  }>;
  /** The next milestone that is not yet reached, if any. */
  nextAt: number | null;
  itemsToNext: number;
}

export function collectionById(id: string): CollectionDef | undefined {
  return COLLECTIONS.find((c) => c.id === id);
}

/**
 * Build the progress view for one collection.
 *
 * `owned` and `byRarity` come from the caller, because only the server knows
 * what a player has; this keeps the maths in one place and testable.
 */
export function buildProgress(
  collection: CollectionDef,
  owned: number,
  byRarity: Record<Rarity, { owned: number; total: number }>,
  claimedMilestones: Set<string>,
): CollectionProgress {
  const fraction = collection.total > 0 ? owned / collection.total : 0;

  const milestones = MILESTONES.map((milestone) => {
    const reward = milestoneReward(collection, milestone);
    const id = milestoneId(collection.id, milestone.at);
    return {
      id,
      at: milestone.at,
      label: milestone.label,
      reached: fraction >= milestone.at,
      claimed: claimedMilestones.has(id),
      ...reward,
    };
  });

  const next = MILESTONES.find((m) => fraction < m.at);

  return {
    id: collection.id,
    name: collection.name,
    noun: collection.noun,
    icon: collection.icon,
    accent: collection.accent,
    owned,
    total: collection.total,
    percent: Math.round(fraction * 1000) / 10,
    byRarity,
    milestones,
    nextAt: next ? next.at : null,
    itemsToNext: next ? Math.max(0, Math.ceil(next.at * collection.total) - owned) : 0,
  };
}
