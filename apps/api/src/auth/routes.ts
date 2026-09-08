import { Router } from 'express';
import { z } from 'zod';
import { USERNAME_RULES } from '@carrom/config';
import { badRequest, notFound, route, unauthorized } from '../lib/errors.js';
import { ALLOW_GUEST, PUBLIC_WEB_URL, REQUIRE_EMAIL_VERIFICATION } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { query } from '../db/pool.js';
import { authRateLimit, requireAuth, requireFullAccount } from './middleware.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { logOauthFailure, providerStatus, verifyFacebook, verifyGoogle, type SocialProfile } from './oauth.js';
import {
  consumeAuthToken, createAuthToken, issueTokens, revokeAllForUser, revokeRefreshToken,
  rotateRefreshToken,
} from './tokens.js';
import {
  assertNotBanned, claimsFor, createUser, findProfile, findSocial, findUserByEmail,
  findUserById, linkSocial, markSocialRevoked, socialAccountsFor, suggestUsername,
  toProfile, toUser, unlinkSocial, upgradeGuest, type UserRow,
} from './users.js';

export const authRouter = Router();

const emailSchema = z.string().email().max(254).transform((s) => s.toLowerCase());
const passwordSchema = z.string().min(8).max(128);
const usernameSchema = z
  .string()
  .min(USERNAME_RULES.minLength)
  .max(USERNAME_RULES.maxLength)
  .regex(USERNAME_RULES.pattern, 'Letters, numbers and underscore only');

async function sessionFor(user: UserRow, req: { headers: Record<string, unknown>; ip?: string }) {
  await assertNotBanned(user.id);
  const profileRow = await findProfile(user.id);
  if (!profileRow) throw notFound('Profile missing for that account');

  const tokens = await issueTokens(
    { sub: user.id, username: user.username, role: user.role, guest: user.is_guest },
    { userAgent: String(req.headers['user-agent'] ?? ''), ip: req.ip },
  );

  return {
    user: toUser(user),
    profile: toProfile(profileRow, user.username),
    tokens,
  };
}

/** What sign-in methods this deployment offers. Safe to call anonymously. */
authRouter.get('/providers', (_req, res) => {
  res.json({ ...providerStatus(), guest: ALLOW_GUEST, emailVerificationRequired: REQUIRE_EMAIL_VERIFICATION });
});

/* --------------------------------- email ---------------------------------- */

authRouter.post(
  '/register',
  authRateLimit,
  route(async (req, res) => {
    const body = z
      .object({
        email: emailSchema,
        password: passwordSchema,
        username: usernameSchema,
        displayName: z.string().min(1).max(40).optional(),
        country: z.string().length(2).optional(),
      })
      .parse(req.body);

    const passwordHash = await hashPassword(body.password);
    const user = await createUser({
      email: body.email,
      passwordHash,
      username: body.username,
      displayName: body.displayName ?? body.username,
      country: body.country ?? null,
      emailVerified: !REQUIRE_EMAIL_VERIFICATION,
    });

    const verifyToken = await createAuthToken(user.id, 'email_verify');
    // Wire this to your mail provider; the link is logged in development.
    logger.info(
      { userId: user.id, link: `${PUBLIC_WEB_URL}/verify?token=${verifyToken}` },
      'email verification link issued',
    );

    res.status(201).json(await sessionFor(user, req));
  }),
);

authRouter.post(
  '/login',
  authRateLimit,
  route(async (req, res) => {
    const body = z.object({ email: emailSchema, password: z.string().min(1) }).parse(req.body);

    const user = await findUserByEmail(body.email);
    const ok = user ? await verifyPassword(body.password, user.password_hash) : false;
    // Same message either way, so this cannot be used to enumerate accounts.
    if (!user || !ok) throw unauthorized('Email or password is incorrect', 'bad_credentials');

    if (REQUIRE_EMAIL_VERIFICATION && !user.email_verified) {
      throw unauthorized('Verify your email address first', 'email_unverified');
    }

    res.json(await sessionFor(user, req));
  }),
);

authRouter.post(
  '/verify-email',
  authRateLimit,
  route(async (req, res) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const userId = await consumeAuthToken(token, 'email_verify');
    await query('UPDATE users SET email_verified = TRUE, updated_at = now() WHERE id = $1', [userId]);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/forgot-password',
  authRateLimit,
  route(async (req, res) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    const user = await findUserByEmail(email);

    if (user?.password_hash) {
      const token = await createAuthToken(user.id, 'password_reset');
      logger.info(
        { userId: user.id, link: `${PUBLIC_WEB_URL}/reset?token=${token}` },
        'password reset link issued',
      );
    }
    // Always the same reply, so this cannot confirm whether an email is registered.
    res.json({ ok: true, message: 'If that email has an account, a reset link is on its way.' });
  }),
);

authRouter.post(
  '/reset-password',
  authRateLimit,
  route(async (req, res) => {
    const body = z.object({ token: z.string().min(10), password: passwordSchema }).parse(req.body);
    const userId = await consumeAuthToken(body.token, 'password_reset');
    const passwordHash = await hashPassword(body.password);

    await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      userId,
      passwordHash,
    ]);
    // A reset invalidates every existing session.
    await revokeAllForUser(userId);
    res.json({ ok: true });
  }),
);

/* --------------------------------- social --------------------------------- */

async function signInWithSocial(profile: SocialProfile, req: Parameters<typeof sessionFor>[1]) {
  const existing = await findSocial(profile.provider, profile.providerUserId);

  if (existing) {
    const user = await findUserById(existing.user_id);
    if (!user) throw notFound('That account no longer exists');
    // Refresh the cached name and picture on every sign-in.
    await query(
      `UPDATE social_accounts
          SET display_name = $3, avatar_url = $4, email = $5, revoked_at = NULL
        WHERE provider = $1 AND provider_user_id = $2`,
      [profile.provider, profile.providerUserId, profile.displayName, profile.avatarUrl, profile.email],
    );
    if (profile.avatarUrl) {
      await query(
        'UPDATE profiles SET avatar_url = COALESCE(avatar_url, $2) WHERE user_id = $1',
        [user.id, profile.avatarUrl],
      );
    }
    return sessionFor(user, req);
  }

  // An existing account with the same verified email adopts the social link.
  if (profile.email) {
    const byEmail = await findUserByEmail(profile.email);
    if (byEmail) {
      await linkSocial(byEmail.id, profile);
      return sessionFor(byEmail, req);
    }
  }

  const username = await suggestUsername(profile.displayName);
  const user = await createUser({
    email: profile.email,
    username,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    emailVerified: Boolean(profile.email),
    social: profile,
  });
  return sessionFor(user, req);
}

authRouter.post(
  '/facebook',
  authRateLimit,
  route(async (req, res) => {
    const { accessToken } = z.object({ accessToken: z.string().min(10) }).parse(req.body);
    try {
      const profile = await verifyFacebook(accessToken);
      res.json(await signInWithSocial(profile, req));
    } catch (err) {
      logOauthFailure('facebook', err);
      throw err;
    }
  }),
);

authRouter.post(
  '/google',
  authRateLimit,
  route(async (req, res) => {
    const { idToken } = z.object({ idToken: z.string().min(10) }).parse(req.body);
    try {
      const profile = await verifyGoogle(idToken);
      res.json(await signInWithSocial(profile, req));
    } catch (err) {
      logOauthFailure('google', err);
      throw err;
    }
  }),
);

authRouter.post(
  '/link/:provider',
  requireAuth,
  requireFullAccount,
  route(async (req, res) => {
    const provider = z.enum(['facebook', 'google']).parse(req.params.provider);
    const token = z.object({ token: z.string().min(10) }).parse(req.body).token;

    const profile =
      provider === 'facebook' ? await verifyFacebook(token) : await verifyGoogle(token);
    await linkSocial(req.auth!.sub, profile);
    res.json({ ok: true, accounts: await socialAccountsFor(req.auth!.sub) });
  }),
);

authRouter.delete(
  '/link/:provider',
  requireAuth,
  route(async (req, res) => {
    const provider = z.enum(['facebook', 'google']).parse(req.params.provider);
    await unlinkSocial(req.auth!.sub, provider);
    res.json({ ok: true, accounts: await socialAccountsFor(req.auth!.sub) });
  }),
);

/**
 * Facebook calls this when a user removes the app. The signed request is
 * verified before anything is marked revoked.
 */
authRouter.post(
  '/facebook/deauthorize',
  route(async (req, res) => {
    const body = z.object({ signed_request: z.string().min(10) }).parse(req.body);
    const parsed = await parseSignedRequest(body.signed_request);
    if (parsed?.user_id) {
      await markSocialRevoked('facebook', parsed.user_id);
      logger.info({ providerUserId: parsed.user_id }, 'facebook permissions revoked');
    }
    res.json({ ok: true });
  }),
);

async function parseSignedRequest(signed: string): Promise<{ user_id?: string } | null> {
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const { FACEBOOK_APP_SECRET } = await import('../lib/env.js');
  if (!FACEBOOK_APP_SECRET) return null;

  const [encodedSig, payload] = signed.split('.');
  if (!encodedSig || !payload) return null;

  const expected = createHmac('sha256', FACEBOOK_APP_SECRET).update(payload).digest();
  const provided = Buffer.from(encodedSig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
}

/* ---------------------------------- guest --------------------------------- */

authRouter.post(
  '/guest',
  authRateLimit,
  route(async (req, res) => {
    if (!ALLOW_GUEST) throw badRequest('Guest play is disabled here', 'guest_disabled');
    const body = z.object({ displayName: z.string().min(1).max(40).optional() }).parse(req.body ?? {});

    const displayName = body.displayName?.trim() || 'Guest';
    const username = await suggestUsername(displayName === 'Guest' ? 'guest' : displayName);
    const user = await createUser({ username, displayName, isGuest: true });

    res.status(201).json(await sessionFor(user, req));
  }),
);

/** Turn a guest account into a full one without losing coins or cosmetics. */
authRouter.post(
  '/upgrade',
  requireAuth,
  authRateLimit,
  route(async (req, res) => {
    if (!req.auth!.guest) throw badRequest('This account is already registered', 'not_guest');
    const body = z
      .object({
        email: emailSchema,
        password: passwordSchema,
        username: usernameSchema.optional(),
        displayName: z.string().min(1).max(40).optional(),
      })
      .parse(req.body);

    const passwordHash = await hashPassword(body.password);
    const user = await upgradeGuest(req.auth!.sub, {
      email: body.email,
      passwordHash,
      username: body.username,
      displayName: body.displayName,
    });
    res.json(await sessionFor(user, req));
  }),
);

/* -------------------------------- sessions -------------------------------- */

authRouter.post(
  '/refresh',
  route(async (req, res) => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(10) }).parse(req.body);
    const tokens = await rotateRefreshToken(refreshToken, claimsFor, {
      userAgent: String(req.headers['user-agent'] ?? ''),
      ip: req.ip,
    });
    res.json({ tokens });
  }),
);

authRouter.post(
  '/logout',
  route(async (req, res) => {
    const body = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
    if (body.refreshToken) await revokeRefreshToken(body.refreshToken);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/logout-all',
  requireAuth,
  route(async (req, res) => {
    await revokeAllForUser(req.auth!.sub);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  route(async (req, res) => {
    const user = await findUserById(req.auth!.sub);
    if (!user) throw notFound('That account no longer exists');
    const profileRow = await findProfile(user.id);
    if (!profileRow) throw notFound('Profile missing for that account');

    res.json({
      user: toUser(user),
      profile: toProfile(profileRow, user.username),
      socialAccounts: await socialAccountsFor(user.id),
    });
  }),
);
