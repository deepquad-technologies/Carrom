import { randomBytes } from 'node:crypto';
import {
  DEFAULT_AVATAR_ID, DEFAULT_BANNER_ID, DEFAULT_FRAME_ID, DEFAULT_VICTORY_ID,
  STARTER_COSMETICS, STARTER_ITEM_IDS, STARTER_LOADOUT,
} from '@carrom/content';
import { STARTING_BALANCE, USERNAME_RULES } from '@carrom/config';
import type { Profile, User } from '@carrom/types';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import type { SocialProfile } from './oauth.js';
import type { AccessClaims } from './tokens.js';

export interface UserRow {
  id: string;
  email: string | null;
  password_hash: string | null;
  username: string;
  email_verified: boolean;
  is_guest: boolean;
  role: 'player' | 'moderator' | 'admin';
  created_at: Date;
}

export interface ProfileRow {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  country: string | null;
  level: number;
  xp: number;
  coins: number;
  trophies: number;
  games_played: number;
  wins: number;
  losses: number;
  current_streak: number;
  best_streak: number;
  perfect_games: number;
  queen_covers: number;
  comebacks: number;
  tournament_wins: number;
  tournament_points: number;
  equipped_striker: string;
  equipped_coin_set: string;
  equipped_board: string;
  equipped_avatar: string | null;
  equipped_effect: string | null;
  frame_id: string | null;
  banner_id: string | null;
  badge_id: string | null;
  title_id: string | null;
  victory_anim_id: string | null;
  last_bonus_at: Date | null;
  last_seen_at: Date;
  created_at: Date;
}

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified,
    username: row.username,
    createdAt: row.created_at.toISOString(),
    isGuest: row.is_guest,
    isBanned: false,
    role: row.role,
  };
}

export function toProfile(row: ProfileRow, username: string): Profile {
  return {
    userId: row.user_id,
    username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    country: row.country,
    level: row.level,
    xp: Number(row.xp),
    coins: Number(row.coins),
    trophies: row.trophies,
    gamesPlayed: row.games_played,
    wins: row.wins,
    losses: row.losses,
    currentStreak: row.current_streak,
    bestStreak: row.best_streak,
    equippedStriker: row.equipped_striker,
    equippedCoinSet: row.equipped_coin_set,
    equippedBoard: row.equipped_board,
    equippedAvatar: row.equipped_avatar,
    equippedEffect: row.equipped_effect,
    equippedFrame: row.frame_id,
    equippedBanner: row.banner_id,
    equippedBadge: row.badge_id,
    equippedTitle: row.title_id,
    equippedVictory: row.victory_anim_id,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

/* -------------------------------- lookups --------------------------------- */

export function findUserById(id: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
}

export function findUserByEmail(email: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE email = $1', [email]);
}

export function findUserByUsername(username: string): Promise<UserRow | null> {
  return one<UserRow>('SELECT * FROM users WHERE username = $1', [username]);
}

export function findProfile(userId: string): Promise<ProfileRow | null> {
  return one<ProfileRow>('SELECT * FROM profiles WHERE user_id = $1', [userId]);
}

export async function claimsFor(userId: string): Promise<AccessClaims> {
  const user = await findUserById(userId);
  if (!user) throw notFound('That account no longer exists');
  await assertNotBanned(userId);
  return { sub: user.id, username: user.username, role: user.role, guest: user.is_guest };
}

export interface ActiveBan {
  id: string;
  reason: string;
  scope: 'account' | 'ranked' | 'chat';
  expires_at: Date | null;
}

export async function activeBans(userId: string): Promise<ActiveBan[]> {
  return query<ActiveBan>(
    `SELECT id, reason, scope, expires_at
       FROM bans
      WHERE user_id = $1
        AND lifted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );
}

/** Throws if the account is banned outright. Scoped bans are checked at use. */
export async function assertNotBanned(userId: string): Promise<void> {
  const bans = await activeBans(userId);
  const account = bans.find((b) => b.scope === 'account');
  if (!account) return;
  const until = account.expires_at
    ? ` until ${account.expires_at.toISOString().slice(0, 10)}`
    : '';
  throw forbidden(`This account is suspended${until}. Reason: ${account.reason}`, 'banned');
}

/* ------------------------------- creation --------------------------------- */

export function assertValidUsername(username: string): void {
  if (!USERNAME_RULES.pattern.test(username)) {
    throw badRequest(
      `Usernames are ${USERNAME_RULES.minLength}-${USERNAME_RULES.maxLength} characters, letters, numbers and underscore only`,
      'invalid_username',
    );
  }
}

/** Build a free username from a display name, falling back to a random suffix. */
export async function suggestUsername(seed: string): Promise<string> {
  const base = seed
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 14)
    .toLowerCase();
  const stem = base.length >= USERNAME_RULES.minLength ? base : 'player';

  for (let attempt = 0; attempt < 12; attempt++) {
    const suffix = attempt === 0 ? '' : String(Math.floor(Math.random() * 10_000)).padStart(4, '0');
    const candidate = `${stem}${suffix}`.slice(0, USERNAME_RULES.maxLength);
    if (candidate.length < USERNAME_RULES.minLength) continue;
    const taken = await findUserByUsername(candidate);
    if (!taken) return candidate;
  }
  return `player${randomBytes(4).toString('hex')}`;
}

interface CreateUserInput {
  email?: string | null;
  passwordHash?: string | null;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  isGuest?: boolean;
  emailVerified?: boolean;
  country?: string | null;
  social?: SocialProfile;
}

/**
 * Create a user, their profile and their starter inventory in one transaction,
 * so an account can never exist without the loadout it needs to play.
 */
export async function createUser(input: CreateUserInput): Promise<UserRow> {
  assertValidUsername(input.username);

  return transaction(async (client) => {
    const existing = await client.query('SELECT id FROM users WHERE username = $1', [input.username]);
    if (existing.rowCount) throw conflict('That username is taken', 'username_taken');

    if (input.email) {
      const byEmail = await client.query('SELECT id FROM users WHERE email = $1', [input.email]);
      if (byEmail.rowCount) throw conflict('An account already uses that email', 'email_taken');
    }

    const userResult = await client.query<UserRow>(
      `INSERT INTO users (email, password_hash, username, email_verified, is_guest)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        input.email ?? null,
        input.passwordHash ?? null,
        input.username,
        input.emailVerified ?? false,
        input.isGuest ?? false,
      ],
    );
    const user = userResult.rows[0];

    await client.query(
      `INSERT INTO profiles
         (user_id, display_name, avatar_url, country, coins,
          equipped_striker, equipped_coin_set, equipped_board,
          equipped_avatar, frame_id, banner_id, victory_anim_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        user.id,
        input.displayName.slice(0, 40),
        input.avatarUrl ?? null,
        input.country ?? null,
        STARTING_BALANCE,
        STARTER_LOADOUT.equipped.striker,
        STARTER_LOADOUT.equipped.coinSet,
        STARTER_LOADOUT.equipped.board,
        DEFAULT_AVATAR_ID,
        DEFAULT_FRAME_ID,
        DEFAULT_BANNER_ID,
        DEFAULT_VICTORY_ID,
      ],
    );

    await client.query('INSERT INTO ratings (user_id) VALUES ($1)', [user.id]);

    const starters = [...STARTER_ITEM_IDS, ...STARTER_LOADOUT.boards, ...STARTER_COSMETICS];
    for (const itemId of starters) {
      await client.query(
        `INSERT INTO inventory (user_id, item_id, source)
         VALUES ($1,$2,'starter')
         ON CONFLICT DO NOTHING`,
        [user.id, itemId],
      );
    }

    await client.query(
      `INSERT INTO coin_ledger (user_id, delta, balance_after, reason, note)
       VALUES ($1,$2,$2,'admin','welcome balance')`,
      [user.id, STARTING_BALANCE],
    );

    if (input.social) {
      await client.query(
        `INSERT INTO social_accounts
           (user_id, provider, provider_user_id, display_name, avatar_url, email)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          user.id,
          input.social.provider,
          input.social.providerUserId,
          input.social.displayName,
          input.social.avatarUrl,
          input.social.email,
        ],
      );
    }

    return user;
  });
}

/* ---------------------------- social account link -------------------------- */

export interface SocialRow {
  id: string;
  user_id: string;
  provider: 'facebook' | 'google';
  provider_user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  email: string | null;
  linked_at: Date;
  revoked_at: Date | null;
}

export function findSocial(
  provider: 'facebook' | 'google',
  providerUserId: string,
): Promise<SocialRow | null> {
  return one<SocialRow>(
    'SELECT * FROM social_accounts WHERE provider = $1 AND provider_user_id = $2',
    [provider, providerUserId],
  );
}

export function socialAccountsFor(userId: string): Promise<SocialRow[]> {
  return query<SocialRow>(
    'SELECT * FROM social_accounts WHERE user_id = $1 ORDER BY linked_at',
    [userId],
  );
}

/** Attach a verified social identity to an existing account. */
export async function linkSocial(userId: string, profile: SocialProfile): Promise<void> {
  const owner = await findSocial(profile.provider, profile.providerUserId);
  if (owner && owner.user_id !== userId) {
    throw conflict(
      `That ${profile.provider} account is already linked to another player`,
      'social_taken',
    );
  }

  await query(
    `INSERT INTO social_accounts
       (user_id, provider, provider_user_id, display_name, avatar_url, email)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, provider) DO UPDATE SET
       provider_user_id = EXCLUDED.provider_user_id,
       display_name = EXCLUDED.display_name,
       avatar_url = EXCLUDED.avatar_url,
       email = EXCLUDED.email,
       revoked_at = NULL,
       linked_at = now()`,
    [userId, profile.provider, profile.providerUserId, profile.displayName, profile.avatarUrl, profile.email],
  );
}

/**
 * Unlink a provider. Refused when it is the only way the player can sign in,
 * which would otherwise lock them out of their own account.
 */
export async function unlinkSocial(userId: string, provider: 'facebook' | 'google'): Promise<void> {
  const user = await findUserById(userId);
  if (!user) throw notFound('That account no longer exists');

  const others = await query<{ provider: string }>(
    'SELECT provider FROM social_accounts WHERE user_id = $1 AND provider <> $2',
    [userId, provider],
  );
  const hasPassword = Boolean(user.password_hash && user.email);

  if (!hasPassword && others.length === 0) {
    throw badRequest(
      'Set an email and password before unlinking your only sign-in method',
      'last_login_method',
    );
  }

  await query('DELETE FROM social_accounts WHERE user_id = $1 AND provider = $2', [userId, provider]);
}

/** Called from the provider deauthorize webhook when a user removes the app. */
export async function markSocialRevoked(
  provider: 'facebook' | 'google',
  providerUserId: string,
): Promise<void> {
  await query(
    'UPDATE social_accounts SET revoked_at = now() WHERE provider = $1 AND provider_user_id = $2',
    [provider, providerUserId],
  );
}

export async function touchLastSeen(userId: string): Promise<void> {
  await query('UPDATE profiles SET last_seen_at = now() WHERE user_id = $1', [userId]);
}

/** Promote a guest to a full account, keeping every coin and cosmetic. */
export async function upgradeGuest(
  userId: string,
  fields: { email?: string | null; passwordHash?: string | null; username?: string; displayName?: string },
): Promise<UserRow> {
  return transaction(async (client) => {
    if (fields.email) {
      const taken = await client.query('SELECT id FROM users WHERE email = $1 AND id <> $2', [
        fields.email,
        userId,
      ]);
      if (taken.rowCount) throw conflict('An account already uses that email', 'email_taken');
    }
    if (fields.username) {
      assertValidUsername(fields.username);
      const taken = await client.query('SELECT id FROM users WHERE username = $1 AND id <> $2', [
        fields.username,
        userId,
      ]);
      if (taken.rowCount) throw conflict('That username is taken', 'username_taken');
    }

    const result = await client.query<UserRow>(
      `UPDATE users SET
         email = COALESCE($2, email),
         password_hash = COALESCE($3, password_hash),
         username = COALESCE($4, username),
         is_guest = FALSE,
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [userId, fields.email ?? null, fields.passwordHash ?? null, fields.username ?? null],
    );

    if (fields.displayName) {
      await client.query('UPDATE profiles SET display_name = $2 WHERE user_id = $1', [
        userId,
        fields.displayName.slice(0, 40),
      ]);
    }
    return result.rows[0];
  });
}
