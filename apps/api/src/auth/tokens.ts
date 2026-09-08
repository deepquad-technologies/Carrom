import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { TOKEN_TTL } from '@carrom/config';
import type { AuthTokens } from '@carrom/types';
import { query, one } from '../db/pool.js';
import { JWT_ACCESS_SECRET, JWT_REFRESH_SECRET } from '../lib/env.js';
import { unauthorized } from '../lib/errors.js';

export interface AccessClaims {
  sub: string;
  username: string;
  role: 'player' | 'moderator' | 'admin';
  guest: boolean;
}

/** Refresh tokens are opaque random strings; only their hash is stored. */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, JWT_ACCESS_SECRET, {
    expiresIn: TOKEN_TTL.accessSeconds,
    issuer: 'carrom',
    audience: 'carrom-client',
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const payload = jwt.verify(token, JWT_ACCESS_SECRET, {
      issuer: 'carrom',
      audience: 'carrom-client',
    }) as AccessClaims;
    return payload;
  } catch {
    throw unauthorized('Your session expired, please sign in again', 'token_expired');
  }
}

export interface IssueContext {
  userAgent?: string;
  ip?: string;
}

/** Mint an access/refresh pair and record the refresh token. */
export async function issueTokens(
  claims: AccessClaims,
  context: IssueContext = {},
): Promise<AuthTokens> {
  const refreshToken = randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL.refreshSeconds * 1000);

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5)`,
    [claims.sub, hashToken(refreshToken), expiresAt, context.userAgent ?? null, context.ip ?? null],
  );

  return {
    accessToken: signAccessToken(claims),
    refreshToken,
    expiresIn: TOKEN_TTL.accessSeconds,
  };
}

interface StoredRefresh {
  id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * Exchange a refresh token for a new pair, rotating the old one. Reuse of an
 * already-rotated token revokes the whole family: that is the signature of a
 * stolen token, so every session for that user is cut.
 */
export async function rotateRefreshToken(
  refreshToken: string,
  claimsFor: (userId: string) => Promise<AccessClaims>,
  context: IssueContext = {},
): Promise<AuthTokens> {
  const hash = hashToken(refreshToken);
  const stored = await one<StoredRefresh>(
    'SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1',
    [hash],
  );

  if (!stored) throw unauthorized('That session is no longer valid', 'refresh_invalid');

  if (stored.revoked_at !== null) {
    await revokeAllForUser(stored.user_id);
    throw unauthorized('Session reuse detected, please sign in again', 'refresh_reused');
  }

  if (stored.expires_at.getTime() <= Date.now()) {
    throw unauthorized('That session expired, please sign in again', 'refresh_expired');
  }

  const claims = await claimsFor(stored.user_id);
  const next = await issueTokens(claims, context);

  await query(
    `UPDATE refresh_tokens
        SET revoked_at = now(),
            replaced_by = (SELECT id FROM refresh_tokens WHERE token_hash = $2)
      WHERE id = $1`,
    [stored.id, hashToken(next.refreshToken)],
  );

  return next;
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashToken(refreshToken)],
  );
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}

/* --------------------- single-use email / reset tokens --------------------- */

export type TokenPurpose = 'email_verify' | 'password_reset';

export async function createAuthToken(userId: string, purpose: TokenPurpose): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const ttl =
    purpose === 'email_verify' ? TOKEN_TTL.emailVerifySeconds : TOKEN_TTL.passwordResetSeconds;

  // Only the newest token of a purpose should work.
  await query(
    `UPDATE auth_tokens SET used_at = now()
      WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`,
    [userId, purpose],
  );
  await query(
    `INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [userId, purpose, hashToken(token), new Date(Date.now() + ttl * 1000)],
  );
  return token;
}

/** Consume a single-use token, returning the user it belongs to. */
export async function consumeAuthToken(
  token: string,
  purpose: TokenPurpose,
): Promise<string> {
  const row = await one<{ id: string; user_id: string; expires_at: Date; used_at: Date | null }>(
    'SELECT id, user_id, expires_at, used_at FROM auth_tokens WHERE token_hash = $1 AND purpose = $2',
    [hashToken(token), purpose],
  );
  if (!row || row.used_at !== null) throw unauthorized('That link is no longer valid', 'token_used');
  if (row.expires_at.getTime() <= Date.now()) {
    throw unauthorized('That link has expired', 'token_expired');
  }
  await query('UPDATE auth_tokens SET used_at = now() WHERE id = $1', [row.id]);
  return row.user_id;
}

export async function pruneExpiredTokens(): Promise<void> {
  await query('DELETE FROM refresh_tokens WHERE expires_at < now() - INTERVAL \'7 days\'');
  await query('DELETE FROM auth_tokens WHERE expires_at < now() - INTERVAL \'7 days\'');
}
