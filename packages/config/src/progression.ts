/**
 * Player progression: level titles, ranked divisions, seasons, daily login
 * rewards and the fair-play score.
 *
 * These are the *defaults*. The server overlays whatever an administrator has
 * changed in `app_config`, so no reward value is hard-coded at a call site —
 * everything reads through the config service.
 */

/* --------------------------------- titles --------------------------------- */

export interface LevelTitle {
  minLevel: number;
  id: string;
  name: string;
  color: string;
}

/** Awarded automatically as a player levels; also equippable as a profile title. */
export const LEVEL_TITLES: LevelTitle[] = [
  { minLevel: 1, id: 'beginner', name: 'Beginner', color: '#9aa5b1' },
  { minLevel: 10, id: 'rookie', name: 'Rookie', color: '#8fb9d9' },
  { minLevel: 20, id: 'skilled', name: 'Skilled', color: '#4aa8f0' },
  { minLevel: 30, id: 'pro', name: 'Pro', color: '#4dd6a0' },
  { minLevel: 40, id: 'expert', name: 'Expert', color: '#a78bfa' },
  { minLevel: 50, id: 'master', name: 'Master', color: '#f2618c' },
  { minLevel: 75, id: 'grandmaster', name: 'Grandmaster', color: '#4de0c8' },
  { minLevel: 100, id: 'legend', name: 'Legend', color: '#f2c94c' },
];

export function titleForLevel(level: number): LevelTitle {
  let current = LEVEL_TITLES[0];
  for (const title of LEVEL_TITLES) {
    if (level >= title.minLevel) current = title;
  }
  return current;
}

export function nextTitle(level: number): LevelTitle | null {
  return LEVEL_TITLES.find((title) => title.minLevel > level) ?? null;
}

/* ------------------------------- earned titles ----------------------------- */

export interface EarnedTitle {
  id: string;
  name: string;
  description: string;
  color: string;
  /** Achievement that grants it, when it is not a level title. */
  achievementId?: string;
}

export const EARNED_TITLES: EarnedTitle[] = [
  { id: 'sharp_shooter', name: 'Sharp Shooter', description: 'Pocket 500 carrom men.', color: '#4aa8f0' },
  { id: 'queen_master', name: 'Queen Master', description: 'Cover the queen 25 times.', color: '#f2618c', achievementId: 'ach_queen_master' },
  { id: 'perfect_player', name: 'Perfect Player', description: 'Win a perfect game.', color: '#a78bfa', achievementId: 'ach_perfect' },
  { id: 'champion', name: 'Champion', description: 'Reach 2,000 trophies.', color: '#f2c94c', achievementId: 'ach_champion' },
  { id: 'tournament_victor', name: 'Tournament Victor', description: 'Win a tournament.', color: '#4de0c8', achievementId: 'ach_tournament_winner' },
  { id: 'unbeaten', name: 'Unbeaten', description: 'Win ten matches in a row.', color: '#ff8a3c', achievementId: 'ach_streak_10' },
];

export const ALL_TITLES = [
  ...LEVEL_TITLES.map((t) => ({ id: t.id, name: t.name, color: t.color, description: `Reach level ${t.minLevel}.` })),
  ...EARNED_TITLES,
];

/* ------------------------------- ranked ladder ----------------------------- */

export interface Division {
  id: string;
  name: string;
  minRating: number;
  color: string;
  /** Virtual coins granted when a season settles at this division. */
  seasonCoins: number;
  seasonCrate: 'rookie' | 'champion' | 'legendary' | null;
}

export const DIVISIONS: Division[] = [
  { id: 'bronze', name: 'Bronze', minRating: 0, color: '#cd7f32', seasonCoins: 2_000, seasonCrate: 'rookie' },
  { id: 'silver', name: 'Silver', minRating: 400, color: '#b8c4d6', seasonCoins: 6_000, seasonCrate: 'rookie' },
  { id: 'gold', name: 'Gold', minRating: 800, color: '#f2c94c', seasonCoins: 15_000, seasonCrate: 'champion' },
  { id: 'platinum', name: 'Platinum', minRating: 1_300, color: '#7fdbf0', seasonCoins: 35_000, seasonCrate: 'champion' },
  { id: 'diamond', name: 'Diamond', minRating: 1_900, color: '#a78bfa', seasonCoins: 80_000, seasonCrate: 'champion' },
  { id: 'master', name: 'Master', minRating: 2_600, color: '#f2618c', seasonCoins: 180_000, seasonCrate: 'legendary' },
  { id: 'grandmaster', name: 'Grandmaster', minRating: 3_400, color: '#4de0c8', seasonCoins: 400_000, seasonCrate: 'legendary' },
  { id: 'legend', name: 'Legend', minRating: 4_300, color: '#ffd85c', seasonCoins: 1_000_000, seasonCrate: 'legendary' },
];

export function divisionForRating(rating: number): Division {
  let current = DIVISIONS[0];
  for (const division of DIVISIONS) {
    if (rating >= division.minRating) current = division;
  }
  return current;
}

export function nextDivision(rating: number): Division | null {
  return DIVISIONS.find((d) => d.minRating > rating) ?? null;
}

/**
 * Season reset pulls everyone toward the middle rather than wiping them, so a
 * high-ranked player still starts ahead but has to re-earn the top.
 */
export function resetRating(rating: number): number {
  const floor = DIVISIONS[1].minRating;
  return Math.max(0, Math.round(floor + (rating - floor) * 0.45));
}

/** Rating swing for a ranked result, tightened as a player plays more. */
export function ratingDelta(
  playerRating: number,
  opponentRating: number,
  won: boolean,
  gamesPlayed: number,
): number {
  const expected = 1 / (1 + 10 ** ((opponentRating - playerRating) / 400));
  const k = gamesPlayed < 20 ? 48 : gamesPlayed < 80 ? 32 : 24;
  return Math.round(k * ((won ? 1 : 0) - expected));
}

/* -------------------------------- seasons ---------------------------------- */

export interface SeasonTheme {
  id: string;
  name: string;
  /** Board featured for the season, drawn from the existing board set. */
  boardId: string;
  accent: string;
  /** Cosmetics only this season's reward track grants. */
  exclusiveItemIds: string[];
}

export const SEASON_THEMES: SeasonTheme[] = [
  { id: 'jungle', name: 'Jungle', boardId: 'jungle', accent: '#7fc45c', exclusiveItemIds: ['str_dragon', 'set_dragon'] },
  { id: 'galaxy', name: 'Galaxy', boardId: 'galaxy', accent: '#a78bfa', exclusiveItemIds: ['str_galaxy_king', 'set_galaxy'] },
  { id: 'royal_palace', name: 'Royal Palace', boardId: 'palace', accent: '#e0567a', exclusiveItemIds: ['str_royal_knight', 'set_palace'] },
  { id: 'cyber_arena', name: 'Cyber Arena', boardId: 'cyber', accent: '#4dff9e', exclusiveItemIds: ['str_cyber_strike', 'set_cyber'] },
];

export const SEASON_LENGTH_DAYS = 30;

export function themeForSeason(number: number): SeasonTheme {
  return SEASON_THEMES[(number - 1) % SEASON_THEMES.length];
}

/* ---------------------------- daily login rewards -------------------------- */

export type LoginRewardKind = 'coins' | 'xp' | 'crate' | 'fragments' | 'item';

export interface LoginReward {
  day: number;
  kind: LoginRewardKind;
  /** Coins, XP or fragment amount. */
  amount?: number;
  crateKind?: 'rookie' | 'champion' | 'legendary';
  /** Rarity of the fragments granted. */
  rarity?: string;
  itemId?: string;
  label: string;
}

/** A seven-day cycle that repeats. Day 7 is the one worth coming back for. */
export const LOGIN_CYCLE: LoginReward[] = [
  { day: 1, kind: 'coins', amount: 500, label: '500 coins' },
  { day: 2, kind: 'xp', amount: 150, label: '150 XP' },
  { day: 3, kind: 'crate', crateKind: 'rookie', label: 'Rookie Crate' },
  { day: 4, kind: 'fragments', amount: 40, rarity: 'rare', label: '40 rare fragments' },
  { day: 5, kind: 'crate', crateKind: 'champion', label: 'Champion Crate' },
  { day: 6, kind: 'coins', amount: 2_500, label: '2,500 coins' },
  { day: 7, kind: 'crate', crateKind: 'legendary', label: 'Legendary Crate' },
];

/**
 * Missing a day does not wipe the cycle — it resets the consecutive streak but
 * keeps the player's place, so a lapsed player is not punished into leaving.
 */
export const LOGIN_STREAK_BONUS = {
  /** Extra coins per consecutive day, capped. */
  perDay: 100,
  maxDays: 30,
};

/* ------------------------------- fair play --------------------------------- */

export type FairPlayBand = 'excellent' | 'good' | 'fair' | 'poor';

export interface FairPlayMeta {
  id: FairPlayBand;
  name: string;
  min: number;
  color: string;
}

export const FAIR_PLAY_BANDS: FairPlayMeta[] = [
  { id: 'excellent', name: 'Excellent', min: 85, color: '#4dd6a0' },
  { id: 'good', name: 'Good', min: 65, color: '#4aa8f0' },
  { id: 'fair', name: 'Fair', min: 40, color: '#f2c94c' },
  { id: 'poor', name: 'Poor', min: 0, color: '#ef4444' },
];

export function fairPlayBand(score: number): FairPlayMeta {
  return FAIR_PLAY_BANDS.find((band) => score >= band.min) ?? FAIR_PLAY_BANDS[FAIR_PLAY_BANDS.length - 1];
}

/** Weights used to recompute the score from recorded behaviour. */
export const FAIR_PLAY_WEIGHTS = {
  abandon: -8,
  disconnect: -2,
  upheldReport: -15,
  confirmedCheating: -60,
  /** Credit for finishing a match cleanly, so a score can recover. */
  cleanMatch: 1,
  max: 100,
  min: 0,
};

/**
 * Recompute from counters. Recent behaviour dominates because the clean-match
 * credit accumulates while penalties are one-off.
 */
export function computeFairPlay(counters: {
  abandons: number;
  disconnects: number;
  upheldReports: number;
  confirmedCheating: number;
  cleanMatches: number;
}): number {
  const w = FAIR_PLAY_WEIGHTS;
  const raw =
    w.max +
    counters.abandons * w.abandon +
    counters.disconnects * w.disconnect +
    counters.upheldReports * w.upheldReport +
    counters.confirmedCheating * w.confirmedCheating +
    Math.min(40, counters.cleanMatches * w.cleanMatch);

  return Math.max(w.min, Math.min(w.max, Math.round(raw)));
}

/** Fair play widens or narrows who you are matched against. */
export function matchmakingToleranceFor(score: number): number {
  const band = fairPlayBand(score);
  // Poor-standing players are matched together rather than with everyone.
  return band.id === 'poor' ? 0.4 : band.id === 'fair' ? 0.8 : 1;
}

/* ------------------------------ presence ----------------------------------- */

export type PresenceState = 'online' | 'in_game' | 'in_matchmaking' | 'away' | 'offline';

export const PRESENCE_META: Record<PresenceState, { name: string; color: string }> = {
  online: { name: 'Online', color: '#4dd6a0' },
  in_game: { name: 'In game', color: '#f2c94c' },
  in_matchmaking: { name: 'Finding a match', color: '#4aa8f0' },
  away: { name: 'Away', color: '#9aa5b1' },
  offline: { name: 'Offline', color: '#4a5268' },
};

/** No heartbeat for this long moves a session to away, then offline. */
export const PRESENCE_TIMEOUTS = {
  awayMs: 3 * 60_000,
  offlineMs: 10 * 60_000,
  heartbeatMs: 30_000,
};

/* ------------------------------- spectating -------------------------------- */

export const SPECTATOR_LIMITS = {
  /** Hard ceiling per match, so one popular game cannot swamp a node. */
  perMatch: 50,
  /** A player may only watch one match at a time. */
  perUser: 1,
  /** Spectators join this long after the board starts, at the earliest. */
  joinDelayMs: 0,
  /** Reactions a spectator may send per minute. */
  reactionsPerMinute: 6,
};

/* -------------------------------- connection ------------------------------- */

export type ConnectionBand = 'excellent' | 'good' | 'average' | 'poor';

export function connectionBand(pingMs: number): ConnectionBand {
  if (pingMs < 80) return 'excellent';
  if (pingMs < 160) return 'good';
  if (pingMs < 300) return 'average';
  return 'poor';
}

export const CONNECTION_META: Record<ConnectionBand, { name: string; color: string }> = {
  excellent: { name: 'Excellent', color: '#4dd6a0' },
  good: { name: 'Good', color: '#8fd94a' },
  average: { name: 'Average', color: '#f2c94c' },
  poor: { name: 'Poor', color: '#ef4444' },
};
