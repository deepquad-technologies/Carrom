import { Router } from 'express';
import { z } from 'zod';
import { GAME_MODE_LIST, MATCH_TIERS, RANKS, TIMER_LIST, formatCoins } from '@carrom/config';
import { BOARDS, CATALOG_COUNTS, QUICK_MESSAGES, EMOJI_REACTIONS, CRATE_LIST, dropTable } from '@carrom/content';
import { one, query } from '../db/pool.js';
import { badRequest, notFound, route } from '../lib/errors.js';
import { generalRateLimit, optionalAuth, requireAuth } from '../auth/middleware.js';
import { findProfile, findUserById, socialAccountsFor, toProfile } from '../auth/users.js';
import { claimBonus, ledgerFor } from './economy.js';
import { achievementsFor, claimMission, missionsFor, profileStats } from './progression.js';
import { crateSummary } from './crates.js';
import { matchHistory, matchHistorySummary } from '../game/matches.js';

export const profileRouter = Router();
export const catalogRouter = Router();

/** Everything static the clients need to render menus. Cacheable, no auth. */
catalogRouter.get('/', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    modes: GAME_MODE_LIST,
    tiers: MATCH_TIERS.map((t) => ({ ...t, entryLabel: formatCoins(t.entry) })),
    timers: TIMER_LIST,
    ranks: RANKS,
    boards: BOARDS,
    quickMessages: QUICK_MESSAGES,
    reactions: EMOJI_REACTIONS,
    crates: CRATE_LIST.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      unlockMs: c.unlockMs,
      itemDrops: c.itemDrops,
      guaranteed: c.guaranteed,
      xp: c.xp,
      color: c.color,
      accent: c.accent,
      dropRates: dropTable(c.id),
    })),
    counts: CATALOG_COUNTS,
    /** Stated plainly wherever coins appear. */
    currencyNotice: 'Coins are virtual and have no cash value.',
  });
});

/** The home screen payload, in one round trip. */
profileRouter.get(
  '/home',
  requireAuth,
  route(async (req, res) => {
    const userId = req.auth!.sub;
    const [user, profileRow, stats, crates, missions] = await Promise.all([
      findUserById(userId),
      findProfile(userId),
      profileStats(userId),
      crateSummary(userId),
      missionsFor(userId),
    ]);
    if (!user || !profileRow) throw notFound('Profile not found');

    const unread = await one<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [userId],
    );
    const pendingFriends = await one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM friend_requests
        WHERE to_user = $1 AND status = 'pending'`,
      [userId],
    );

    res.json({
      profile: toProfile(profileRow, user.username),
      stats,
      crates,
      missions,
      unreadNotifications: Number(unread?.count ?? 0),
      pendingFriendRequests: Number(pendingFriends?.count ?? 0),
      isGuest: user.is_guest,
    });
  }),
);

profileRouter.get(
  '/me',
  requireAuth,
  route(async (req, res) => {
    const userId = req.auth!.sub;
    const [user, profileRow, stats, socials] = await Promise.all([
      findUserById(userId),
      findProfile(userId),
      profileStats(userId),
      socialAccountsFor(userId),
    ]);
    if (!user || !profileRow) throw notFound('Profile not found');

    res.json({
      profile: toProfile(profileRow, user.username),
      stats,
      socialAccounts: socials.map((s) => ({
        provider: s.provider,
        displayName: s.display_name,
        avatarUrl: s.avatar_url,
        linkedAt: s.linked_at,
        revoked: s.revoked_at !== null,
      })),
    });
  }),
);

/** Someone else's public profile. */
profileRouter.get(
  '/players/:id',
  optionalAuth,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const [user, profileRow, stats] = await Promise.all([
      findUserById(id),
      findProfile(id),
      profileStats(id),
    ]);
    if (!user || !profileRow) throw notFound('No such player');

    const profile = toProfile(profileRow, user.username);
    res.json({
      profile: {
        userId: profile.userId,
        username: profile.username,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        country: profile.country,
        level: profile.level,
        trophies: profile.trophies,
        gamesPlayed: profile.gamesPlayed,
        wins: profile.wins,
        losses: profile.losses,
        bestStreak: profile.bestStreak,
        equippedStriker: profile.equippedStriker,
        equippedCoinSet: profile.equippedCoinSet,
        equippedBoard: profile.equippedBoard,
        createdAt: profile.createdAt,
      },
      stats: stats ? { winRate: stats.winRate, rank: stats.rank, globalPosition: stats.globalPosition } : null,
    });
  }),
);

profileRouter.patch(
  '/me',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const body = z
      .object({
        displayName: z.string().min(1).max(40).optional(),
        country: z.string().length(2).toUpperCase().optional(),
        avatarUrl: z.string().url().max(500).nullable().optional(),
      })
      .parse(req.body);

    if (Object.keys(body).length === 0) throw badRequest('Nothing to change');

    await query(
      `UPDATE profiles SET
         display_name = COALESCE($2, display_name),
         country = COALESCE($3, country),
         avatar_url = CASE WHEN $4::boolean THEN $5 ELSE avatar_url END
       WHERE user_id = $1`,
      [
        req.auth!.sub,
        body.displayName ?? null,
        body.country ?? null,
        body.avatarUrl !== undefined,
        body.avatarUrl ?? null,
      ],
    );

    const [user, profileRow] = await Promise.all([
      findUserById(req.auth!.sub),
      findProfile(req.auth!.sub),
    ]);
    res.json({ profile: toProfile(profileRow!, user!.username) });
  }),
);

profileRouter.get(
  '/history',
  requireAuth,
  route(async (req, res) => {
    const q = z
      .object({
        limit: z.coerce.number().min(1).max(100).default(25),
        offset: z.coerce.number().min(0).default(0),
        outcome: z.enum(['win', 'loss']).optional(),
        modeId: z.string().max(40).optional(),
        tierId: z.string().max(40).optional(),
        days: z.coerce.number().int().min(1).max(365).optional(),
      })
      .parse(req.query);

    const [matches, summary] = await Promise.all([
      matchHistory(req.auth!.sub, q),
      matchHistorySummary(req.auth!.sub, q),
    ]);
    res.json({ matches, summary });
  }),
);

profileRouter.get(
  '/achievements',
  requireAuth,
  route(async (req, res) => {
    res.json({ achievements: await achievementsFor(req.auth!.sub) });
  }),
);

profileRouter.get(
  '/missions',
  requireAuth,
  route(async (req, res) => {
    res.json({ missions: await missionsFor(req.auth!.sub) });
  }),
);

profileRouter.post(
  '/missions/:id/claim',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().min(1).max(64).parse(req.params.id);
    res.json(await claimMission(req.auth!.sub, id));
  }),
);

/** Free top-up when a player is too low to sit at the lowest table. */
profileRouter.post(
  '/bonus',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    res.json(await claimBonus(req.auth!.sub));
  }),
);

profileRouter.get(
  '/wallet',
  requireAuth,
  route(async (req, res) => {
    const profileRow = await findProfile(req.auth!.sub);
    res.json({
      balance: Number(profileRow?.coins ?? 0),
      ledger: await ledgerFor(req.auth!.sub, 50),
      notice: 'Coins are virtual and have no cash value.',
    });
  }),
);

/* ------------------------------ notifications ------------------------------ */

profileRouter.get(
  '/notifications',
  requireAuth,
  route(async (req, res) => {
    const rows = await query(
      `SELECT id, kind, title, body, data, read_at, created_at
         FROM notifications WHERE user_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.auth!.sub],
    );
    res.json({ notifications: rows });
  }),
);

profileRouter.post(
  '/notifications/read',
  requireAuth,
  route(async (req, res) => {
    const body = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
    if (body.ids?.length) {
      await query(
        'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[])',
        [req.auth!.sub, body.ids],
      );
    } else {
      await query(
        'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
        [req.auth!.sub],
      );
    }
    res.json({ ok: true });
  }),
);
