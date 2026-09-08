/**
 * Match configuration: entry tiers, turn timers and game modes.
 *
 * Coins here are virtual in-game currency only. Nothing in this project
 * converts coins to or from real money, and no wagering takes place.
 */

export type TimerPreset = 'quick' | 'classic' | 'pro' | 'tournament';

export interface TimerConfig {
  id: TimerPreset;
  name: string;
  /** Seconds a player has to take their shot. */
  turnSeconds: number;
  /** Seconds remaining when the warning animation and sound fire. */
  warnAtSeconds: number;
}

export const TIMERS: Record<TimerPreset, TimerConfig> = {
  quick: { id: 'quick', name: 'Quick', turnSeconds: 30, warnAtSeconds: 8 },
  classic: { id: 'classic', name: 'Classic', turnSeconds: 60, warnAtSeconds: 12 },
  pro: { id: 'pro', name: 'Pro', turnSeconds: 90, warnAtSeconds: 15 },
  tournament: { id: 'tournament', name: 'Tournament', turnSeconds: 120, warnAtSeconds: 20 },
};

export const TIMER_LIST = Object.values(TIMERS);

/* ------------------------------- match tiers ------------------------------ */

export interface MatchTier {
  id: string;
  name: string;
  /** Virtual coins each seat contributes. */
  entry: number;
  /** Virtual coins a player must hold to sit down. */
  minBalance: number;
  /** Minimum account level, so new players start at the bottom. */
  minLevel: number;
  /** Board theme used for this tier by default. */
  boardId: string;
  /** Trophy points at stake in ranked play. */
  trophyStake: number;
}

export const MATCH_TIERS: MatchTier[] = [
  { id: 'beginner', name: 'Beginner Room', entry: 200, minBalance: 200, minLevel: 1, boardId: 'classic_wood', trophyStake: 8 },
  { id: 'pro', name: 'Pro Room', entry: 1_000, minBalance: 1_000, minLevel: 3, boardId: 'emerald', trophyStake: 12 },
  { id: 'elite', name: 'Elite Room', entry: 5_000, minBalance: 5_000, minLevel: 6, boardId: 'marble', trophyStake: 18 },
  { id: 'master', name: 'Master Room', entry: 25_000, minBalance: 25_000, minLevel: 10, boardId: 'royal_gold', trophyStake: 26 },
  { id: 'champion', name: 'Champion Room', entry: 100_000, minBalance: 100_000, minLevel: 15, boardId: 'galaxy', trophyStake: 36 },
  { id: 'grandmaster', name: 'Grandmaster Room', entry: 1_000_000, minBalance: 1_000_000, minLevel: 22, boardId: 'diamond', trophyStake: 50 },
];

export const DEFAULT_TIER_ID = 'beginner';

export function tierById(id: string | undefined | null): MatchTier | undefined {
  return MATCH_TIERS.find((t) => t.id === id);
}

/** House commission on the pot, kept as virtual coins only. */
export const RAKE = 0.1;

export const STARTING_BALANCE = 2_000;
export const BONUS_AMOUNT = 500;
export const BONUS_COOLDOWN_MS = 60 * 60 * 1000;
export const BONUS_THRESHOLD = 200;

/** Virtual coins the winning side receives from a table of `seats` players. */
export function payout(entry: number, seats: number): number {
  return Math.floor(entry * seats * (1 - RAKE));
}

export function formatCoins(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k % 1 === 0 ? k : k.toFixed(1)}K`;
  }
  return String(n);
}

/* ------------------------------- game modes ------------------------------- */

export type GameModeId =
  | 'quick'
  | 'classic'
  | 'ranked'
  | 'private'
  | 'friend'
  | 'team'
  | 'practice'
  | 'tournament'
  | 'daily';

export interface GameModeConfig {
  id: GameModeId;
  name: string;
  description: string;
  seats: 2 | 4;
  timer: TimerPreset;
  /** Ranked play moves trophies and feeds the ladder. */
  ranked: boolean;
  /** Whether an entry fee is taken. */
  staked: boolean;
  /** Whether winning can drop a crate. */
  awardsCrate: boolean;
  /** Whether the mode is matchmade or joined by code. */
  matchmaking: 'queue' | 'code' | 'solo';
  minLevel: number;
}

export const GAME_MODES: Record<GameModeId, GameModeConfig> = {
  quick: {
    id: 'quick', name: 'Quick Match',
    description: 'Fast 1v1 with a 30 second shot clock.',
    seats: 2, timer: 'quick', ranked: false, staked: true, awardsCrate: true,
    matchmaking: 'queue', minLevel: 1,
  },
  classic: {
    id: 'classic', name: 'Classic Match',
    description: 'Standard 1v1 carrom, 60 seconds a turn.',
    seats: 2, timer: 'classic', ranked: false, staked: true, awardsCrate: true,
    matchmaking: 'queue', minLevel: 1,
  },
  ranked: {
    id: 'ranked', name: 'Ranked Match',
    description: 'Trophies on the line. Skill-matched opponents.',
    seats: 2, timer: 'pro', ranked: true, staked: true, awardsCrate: true,
    matchmaking: 'queue', minLevel: 3,
  },
  private: {
    id: 'private', name: 'Private Room',
    description: 'Create a room and share the code.',
    seats: 2, timer: 'classic', ranked: false, staked: true, awardsCrate: true,
    matchmaking: 'code', minLevel: 1,
  },
  friend: {
    id: 'friend', name: 'Friend Match',
    description: 'Challenge someone from your friend list.',
    seats: 2, timer: 'classic', ranked: false, staked: true, awardsCrate: true,
    matchmaking: 'code', minLevel: 1,
  },
  team: {
    id: 'team', name: 'Team Match',
    description: 'Four players, two teams, partners sit opposite.',
    seats: 4, timer: 'classic', ranked: false, staked: true, awardsCrate: true,
    matchmaking: 'queue', minLevel: 2,
  },
  practice: {
    id: 'practice', name: 'Practice',
    description: 'Play both sides on your own. No stake, no reward.',
    seats: 2, timer: 'tournament', ranked: false, staked: false, awardsCrate: false,
    matchmaking: 'solo', minLevel: 1,
  },
  tournament: {
    id: 'tournament', name: 'Tournament',
    description: 'Bracketed knockout for virtual prizes.',
    seats: 2, timer: 'tournament', ranked: true, staked: true, awardsCrate: true,
    matchmaking: 'code', minLevel: 5,
  },
  daily: {
    id: 'daily', name: 'Daily Challenge',
    description: 'A fresh objective every day.',
    seats: 2, timer: 'classic', ranked: false, staked: false, awardsCrate: true,
    matchmaking: 'queue', minLevel: 1,
  },
};

export const GAME_MODE_LIST = Object.values(GAME_MODES);

export function modeById(id: string | undefined | null): GameModeConfig | undefined {
  return id ? GAME_MODES[id as GameModeId] : undefined;
}

/* -------------------------------- progression ------------------------------ */

/** XP needed to reach each level. Index 0 is level 1. */
export function xpForLevel(level: number): number {
  if (level <= 1) return 0;
  return Math.round(120 * Math.pow(level - 1, 1.45));
}

export function levelForXp(xp: number): number {
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpForLevel(level + 1)) level++;
  return level;
}

export const MAX_LEVEL = 60;

export const XP_REWARDS = {
  win: 120,
  loss: 35,
  pocket: 4,
  queenCovered: 25,
  perfectGame: 150,
  dailyMission: 80,
  achievement: 200,
} as const;

/** Bonus XP and crates for consecutive wins. */
export const STREAK_REWARDS = [
  { wins: 3, xp: 100, coins: 500, crate: null as string | null, label: '3 win streak' },
  { wins: 5, xp: 250, coins: 1_500, crate: 'champion', label: '5 win streak' },
  { wins: 10, xp: 600, coins: 5_000, crate: 'legendary', label: '10 win streak' },
];

/* ---------------------------------- ranks --------------------------------- */

export interface RankTier {
  id: string;
  name: string;
  minTrophies: number;
  color: string;
}

export const RANKS: RankTier[] = [
  { id: 'wood', name: 'Wood', minTrophies: 0, color: '#8a6242' },
  { id: 'bronze', name: 'Bronze', minTrophies: 200, color: '#cd7f32' },
  { id: 'silver', name: 'Silver', minTrophies: 500, color: '#b8c4d6' },
  { id: 'gold', name: 'Gold', minTrophies: 900, color: '#f2c94c' },
  { id: 'platinum', name: 'Platinum', minTrophies: 1_400, color: '#7fdbf0' },
  { id: 'diamond', name: 'Diamond', minTrophies: 2_000, color: '#a78bfa' },
  { id: 'master', name: 'Master', minTrophies: 2_800, color: '#f2618c' },
  { id: 'grandmaster', name: 'Grandmaster', minTrophies: 3_800, color: '#4de0c8' },
];

export function rankForTrophies(trophies: number): RankTier {
  let current = RANKS[0];
  for (const rank of RANKS) {
    if (trophies >= rank.minTrophies) current = rank;
  }
  return current;
}
