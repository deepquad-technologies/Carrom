/**
 * Limits the server enforces. Everything here exists so a modified client
 * cannot gain an advantage: the server re-derives every value it cares about.
 */

/** Shot inputs outside these ranges are rejected outright. */
export const SHOT_LIMITS = {
  posMin: 0,
  posMax: 1,
  powerMin: 0,
  powerMax: 1,
  /** Aim must be finite and within a full turn. */
  angleMin: -Math.PI * 2,
  angleMax: Math.PI * 2,
  /** Shots closer together than this are treated as automation. */
  minMsBetweenShots: 250,
} as const;

/** Socket message ceilings, per connection. */
export const RATE_LIMITS = {
  shotsPerMinute: 60,
  chatPerMinute: 20,
  lobbyActionsPerMinute: 40,
  genericPerMinute: 240,
} as const;

/** HTTP ceilings, per IP. */
export const HTTP_RATE_LIMITS = {
  authPerMinute: 12,
  generalPerMinute: 180,
} as const;

/** Behaviour that flags an account for admin review. */
export const SUSPICION_THRESHOLDS = {
  /** Win rate above this over the sample size is worth a look. */
  winRate: 0.92,
  sampleSize: 40,
  /** Turns completed faster than this look automated. */
  minTurnMs: 400,
  /** Rejected shots in a row before the connection is dropped. */
  invalidShotStrikes: 8,
} as const;

export const TOKEN_TTL = {
  /** Short-lived access token. */
  accessSeconds: 15 * 60,
  /** Long-lived refresh token, rotated on every use. */
  refreshSeconds: 30 * 24 * 60 * 60,
  emailVerifySeconds: 24 * 60 * 60,
  passwordResetSeconds: 60 * 60,
} as const;

export const PASSWORD_RULES = {
  minLength: 8,
  maxLength: 128,
  /** At least one letter and one digit. */
  pattern: /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/,
} as const;

export const USERNAME_RULES = {
  minLength: 3,
  maxLength: 20,
  pattern: /^[a-zA-Z0-9_]{3,20}$/,
} as const;

/** Reconnection and idle handling. */
export const PRESENCE = {
  reconnectWindowMs: 60_000,
  /** Consecutive skipped turns before a player is treated as away. */
  afkTurns: 2,
  heartbeatMs: 10_000,
} as const;
