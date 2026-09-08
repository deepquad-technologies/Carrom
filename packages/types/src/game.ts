export type Color = 'white' | 'black';
export type BodyKind = 'white' | 'black' | 'queen' | 'striker';
/** Seat count of a table. Doubles seat partners opposite each other. */
export type TableSize = '2p' | '4p';

export interface Body {
  id: string;
  kind: BodyKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  m: number;
  pocketed: boolean;
}

/** A shot as the client expresses it, independent of which side you sit on. */
export interface Shot {
  /** Striker position along your base line, 0 (left) to 1 (right) from your seat. */
  pos: number;
  /** Aim direction in radians, in absolute board space. */
  angle: number;
  /** 0..1, mapped onto the engine speed range. */
  power: number;
}

export interface GamePlayer {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  seat: number;
  color: Color;
  connected: boolean;
  provider: AuthProvider;
  level: number;
  trophies: number;
  /** Virtual coin balance when the match began. */
  balance: number;
  /** Cosmetics this player has equipped. */
  strikerSkinId: string;
  coinSkinId: string;
  /** Coins pocketed this match, for the scoreboard. */
  pocketed: number;
}

export type AuthProvider = 'email' | 'facebook' | 'google' | 'guest';

export interface GameState {
  matchId: string;
  modeId: string;
  tierId: string;
  boardId: string;
  size: TableSize;
  bodies: Body[];
  players: GamePlayer[];
  turnSeat: number;
  /** Monotonic counter; every state a client receives carries one. */
  seq: number;
  /** Server clock when this state was produced. */
  serverTime: number;
  /** Colour that pocketed the queen but has not covered it yet. */
  queenPending: Color | null;
  /** Colour that has legally won the queen. */
  queenOwner: Color | null;
  /** Penalty pieces owed when a foul happened with nothing to return. */
  due: Record<Color, number>;
  status: 'waiting' | 'playing' | 'finished';
  winner: Color | null;
  points: number;
  turnCount: number;
  /** Virtual coins each seat contributed. */
  entry: number;
  /** Total virtual coins on the table. */
  pot: number;
  /** Seconds allowed per turn for this match. */
  turnSeconds: number;
}

export type FoulReason =
  | 'striker_pocketed'
  | 'no_contact'
  | 'own_piece_untouched'
  | 'timeout';

export interface ShotSummary {
  seat: number;
  color: Color;
  pocketed: BodyKind[];
  foul: boolean;
  fouls: FoulReason[];
  reasons: string[];
  repeatTurn: boolean;
  queenEvent: 'taken' | 'covered' | 'returned' | null;
  message: string;
}

/** Everything a client needs to replay a shot locally, frame for frame. */
export interface ShotBroadcast {
  seq: number;
  serverTime: number;
  seat: number;
  shot: Shot;
  striker: { x: number; y: number; vx: number; vy: number };
  summary: ShotSummary;
  /** Authoritative post-shot state, used to snap after the local replay. */
  state: GameState;
  /** Epoch ms when the next turn expires. */
  deadline: number;
}

export interface MatchResult {
  matchId: string;
  winner: Color | null;
  points: number;
  pot: number;
  /** Virtual coins credited to each winning seat. */
  perPlayer: number;
  reason: 'complete' | 'forfeit' | 'abandoned' | 'cancelled';
  rewards: Record<string, PlayerReward>;
}

export interface RatingMovement {
  before: number;
  after: number;
  delta: number;
  division: string;
  promoted: boolean;
  demoted: boolean;
}

export interface PlayerReward {
  userId: string;
  won: boolean;
  coins: number;
  xp: number;
  trophies: number;
  levelBefore: number;
  levelAfter: number;
  crateId: string | null;
  crateKind: string | null;
  achievements: string[];
  streak: number;
  balance: number;
  note?: string;
  /** Season rating movement, present only for ranked matches. */
  rating?: RatingMovement | null;
}
