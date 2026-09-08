import type { AuthProvider } from './game';

/* ---------------------------------- users --------------------------------- */

export interface User {
  id: string;
  email: string | null;
  emailVerified: boolean;
  username: string;
  createdAt: string;
  isGuest: boolean;
  isBanned: boolean;
  role: 'player' | 'moderator' | 'admin';
}

export interface SocialAccount {
  provider: Exclude<AuthProvider, 'email' | 'guest'>;
  providerUserId: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  linkedAt: string;
}

export interface Profile {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  country: string | null;
  level: number;
  xp: number;
  /** Virtual in-game coins. Not redeemable for money. */
  coins: number;
  trophies: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  currentStreak: number;
  bestStreak: number;
  equippedStriker: string;
  equippedCoinSet: string;
  equippedBoard: string;
  equippedAvatar: string | null;
  equippedEffect: string | null;
  /** Profile cosmetics: frame, banner, badge, title and victory flourish. */
  equippedFrame: string | null;
  equippedBanner: string | null;
  equippedBadge: string | null;
  equippedTitle: string | null;
  equippedVictory: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface ProfileStats {
  winRate: number;
  rank: { id: string; name: string; color: string };
  xpIntoLevel: number;
  xpForNextLevel: number;
  globalPosition: number | null;
}

/* -------------------------------- inventory ------------------------------- */

export type ItemCategory = 'striker' | 'coin_set' | 'board' | 'avatar' | 'effect';

export interface InventoryEntry {
  itemId: string;
  category: ItemCategory;
  acquiredAt: string;
  favorite: boolean;
  /** Extra copies pulled from crates, converted to fragments. */
  duplicates: number;
}

export interface Inventory {
  items: InventoryEntry[];
  fragments: Record<string, number>;
  crates: OwnedCrate[];
  crateSlots: number;
}

export interface OwnedCrate {
  id: string;
  kind: string;
  tierEntry: number;
  wonAt: number;
  readyAt: number | null;
  remaining: number;
  ready: boolean;
  speedUpCost: number;
}

/* ---------------------------------- social -------------------------------- */

export type FriendStatus = 'pending' | 'accepted' | 'blocked';

export interface Friend {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  trophies: number;
  online: boolean;
  inMatch: boolean;
  status: FriendStatus;
  since: string;
}

export interface FriendRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  fromUsername: string;
  fromDisplayName: string;
  fromAvatarUrl: string | null;
  createdAt: string;
}

/* ------------------------------- leaderboards ----------------------------- */

export type LeaderboardScope = 'global' | 'country' | 'friends';
export type LeaderboardWindow = 'weekly' | 'monthly' | 'all_time';
export type LeaderboardMetric = 'trophies' | 'wins' | 'streak' | 'xp' | 'tournament_points';

export interface LeaderboardRow {
  position: number;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  value: number;
  country: string | null;
}

/* -------------------------------- tournaments ----------------------------- */

export type TournamentStatus = 'draft' | 'registration' | 'running' | 'finished' | 'cancelled';

export interface Tournament {
  id: string;
  name: string;
  status: TournamentStatus;
  /** Virtual coin entry. */
  entryCoins: number;
  maxPlayers: number;
  registered: number;
  tierId: string;
  timerPreset: string;
  startsAt: string;
  createdAt: string;
  prizePool: number;
  winnerUserId: string | null;
}

export interface TournamentMatch {
  id: string;
  tournamentId: string;
  round: number;
  slot: number;
  playerAId: string | null;
  playerBId: string | null;
  winnerId: string | null;
  matchId: string | null;
  status: 'pending' | 'ready' | 'running' | 'finished' | 'bye';
}

/* ------------------------------- achievements ----------------------------- */

export interface AchievementProgress {
  achievementId: string;
  progress: number;
  target: number;
  unlockedAt: string | null;
}

export interface MissionProgress {
  missionId: string;
  progress: number;
  target: number;
  claimed: boolean;
  expiresAt: string;
}

/* ------------------------------- notifications ---------------------------- */

export type NotificationKind =
  | 'friend_request'
  | 'friend_accepted'
  | 'match_invite'
  | 'crate_ready'
  | 'achievement'
  | 'mission'
  | 'tournament'
  | 'system';

export interface AppNotification {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/* ---------------------------------- auth ---------------------------------- */

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface Session {
  user: User;
  profile: Profile;
  tokens: AuthTokens;
}
