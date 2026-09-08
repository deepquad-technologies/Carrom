import { Router } from 'express';
import { z } from 'zod';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound, route } from '../lib/errors.js';
import { rateLimit, requireAuth, requireFullAccount } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { moveCoins } from './economy.js';
import { notify } from './notifications.js';

/**
 * Coin gifts between friends.
 *
 * A gift **moves** coins; it never creates them. The sender is debited and the
 * recipient credited inside one transaction, so both balances still equal the
 * sum of their ledgers afterwards and the economy audit stays clean.
 *
 * The thing this has to be designed against is alt-account farming: making
 * throwaway accounts and funnelling their starting coins into a main. Four
 * things stand in the way of that:
 *
 *   * **One gift per sender per day**, enforced by a unique index rather than a
 *     read-then-write, so two devices tapping at once cannot both succeed.
 *   * **A cap on the amount**, so a single gift cannot move a fortune.
 *   * **Full accounts only** — a guest cannot gift, which is what makes
 *     throwaway accounts useless for it.
 *   * **Friends only, and not brand new ones**, so an account cannot be created
 *     and drained the same hour.
 */
export const giftRouter = Router();

export const GIFT_LIMITS = {
  /** Most coins that can be sent in one gift. */
  maxAmount: 25_000,
  /** Fewest, so the feature is a gift rather than a notification spam vector. */
  minAmount: 500,
  /** The sender must keep at least this much, so nobody empties themselves. */
  senderFloor: 1_000,
  /** How long two accounts must have been friends before coins can move. */
  friendshipHours: 24,
};

interface GiftRow {
  id: string;
  from_user: string;
  to_user: string;
  amount: string;
  created_at: string;
  from_name: string;
  to_name: string;
}

/** Whether this account has already sent its gift today (UTC). */
async function sentToday(userId: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `SELECT id FROM coin_gifts
      WHERE from_user = $1 AND sent_on = (now() AT TIME ZONE 'utc')::date`,
    [userId],
  );
  return Boolean(row);
}

giftRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    const me = req.auth!.sub;

    const [received, sent] = await Promise.all([
      query<GiftRow>(
        `SELECT g.id::text, g.from_user, g.to_user, g.amount::text, g.created_at,
                pf.display_name AS from_name, pt.display_name AS to_name
           FROM coin_gifts g
           JOIN profiles pf ON pf.user_id = g.from_user
           JOIN profiles pt ON pt.user_id = g.to_user
          WHERE g.to_user = $1
          ORDER BY g.created_at DESC LIMIT 20`,
        [me],
      ),
      query<GiftRow>(
        `SELECT g.id::text, g.from_user, g.to_user, g.amount::text, g.created_at,
                pf.display_name AS from_name, pt.display_name AS to_name
           FROM coin_gifts g
           JOIN profiles pf ON pf.user_id = g.from_user
           JOIN profiles pt ON pt.user_id = g.to_user
          WHERE g.from_user = $1
          ORDER BY g.created_at DESC LIMIT 20`,
        [me],
      ),
    ]);

    const map = (rows: GiftRow[]) =>
      rows.map((row) => ({
        id: row.id,
        fromUserId: row.from_user,
        toUserId: row.to_user,
        from: row.from_name,
        to: row.to_name,
        amount: Number(row.amount),
        at: row.created_at,
      }));

    res.json({
      canSendToday: !(await sentToday(me)),
      limits: GIFT_LIMITS,
      received: map(received),
      sent: map(sent),
      notice: 'Gifts move virtual coins between accounts. They have no cash value.',
    });
  }),
);

giftRouter.post(
  '/',
  requireAuth,
  // A gift needs a real account: this is what makes throwaway accounts useless
  // for funnelling coins.
  requireFullAccount,
  rateLimit('gift', 10),
  route(async (req, res) => {
    const body = z
      .object({
        userId: z.string().uuid(),
        amount: z.number().int().min(GIFT_LIMITS.minAmount).max(GIFT_LIMITS.maxAmount),
      })
      .parse(req.body);

    const me = req.auth!.sub;
    if (body.userId === me) throw badRequest('You cannot gift yourself');

    // Friends only, and only once the friendship has had time to be real.
    const friendship = await one<{ created_at: string }>(
      `SELECT created_at FROM friends
        WHERE user_id = $1 AND friend_id = $2 AND status = 'accepted'`,
      [me, body.userId],
    );
    if (!friendship) throw badRequest('You can only gift coins to a friend');

    const friendlyFor = Date.now() - new Date(friendship.created_at).getTime();
    if (friendlyFor < GIFT_LIMITS.friendshipHours * 3_600_000) {
      throw conflict(
        `You can gift a friend once you have been friends for ${GIFT_LIMITS.friendshipHours} hours.`,
        'friendship_too_new',
      );
    }

    const recipient = await one<{ is_bot: boolean; display_name: string }>(
      `SELECT u.is_bot, p.display_name
         FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE u.id = $1`,
      [body.userId],
    );
    if (!recipient) throw notFound('That player does not exist');
    if (recipient.is_bot) throw badRequest('That is a practice opponent, not a player');

    const sender = await one<{ coins: string; display_name: string }>(
      'SELECT coins::text, display_name FROM profiles WHERE user_id = $1',
      [me],
    );
    if (!sender) throw notFound('Profile not found');

    if (Number(sender.coins) - body.amount < GIFT_LIMITS.senderFloor) {
      throw conflict(
        `You need to keep at least ${GIFT_LIMITS.senderFloor.toLocaleString()} coins for yourself.`,
        'insufficient_coins',
      );
    }

    let balance = Number(sender.coins);

    try {
      balance = await transaction(async (client) => {
        // Claim today's gift first. The unique index on (from_user, sent_on) is
        // what actually enforces "once a day" — a second request racing this one
        // fails here rather than both succeeding.
        await client.query(
          'INSERT INTO coin_gifts (from_user, to_user, amount) VALUES ($1, $2, $3)',
          [me, body.userId, body.amount],
        );

        const after = await moveCoins(client, {
          userId: me,
          delta: -body.amount,
          reason: 'gift_sent',
          note: `gift to ${recipient.display_name}`,
        });

        await moveCoins(client, {
          userId: body.userId,
          delta: body.amount,
          reason: 'gift_received',
          note: `gift from ${sender.display_name}`,
        });

        return after;
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('You have already sent a gift today. Try again tomorrow.', 'already_gifted');
      }
      throw err;
    }

    await notify(
      body.userId,
      'system',
      'A gift from a friend',
      `${sender.display_name} sent you ${body.amount.toLocaleString()} coins.`,
      { kind: 'coin_gift', fromUserId: me, amount: body.amount },
    );

    logger.info({ from: me, to: body.userId, amount: body.amount }, 'coin gift sent');

    res.json({
      ok: true,
      amount: body.amount,
      balance,
      to: recipient.display_name,
      canSendToday: false,
    });
  }),
);

/** Who this player could gift to right now, and why not when they cannot. */
giftRouter.get(
  '/eligible',
  requireAuth,
  route(async (req, res) => {
    const me = req.auth!.sub;

    const rows = await query<{
      user_id: string;
      username: string;
      display_name: string;
      avatar_url: string | null;
      level: number;
      friends_since: string;
    }>(
      `SELECT u.id AS user_id, u.username, p.display_name, p.avatar_url, p.level,
              f.created_at AS friends_since
         FROM friends f
         JOIN users u ON u.id = f.friend_id
         JOIN profiles p ON p.user_id = u.id
        WHERE f.user_id = $1 AND f.status = 'accepted'
          AND u.is_bot = FALSE AND u.is_guest = FALSE
        ORDER BY p.display_name`,
      [me],
    );

    const cutoff = GIFT_LIMITS.friendshipHours * 3_600_000;

    res.json({
      canSendToday: !(await sentToday(me)),
      limits: GIFT_LIMITS,
      friends: rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        level: row.level,
        eligible: Date.now() - new Date(row.friends_since).getTime() >= cutoff,
      })),
    });
  }),
);
