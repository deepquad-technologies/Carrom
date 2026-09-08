import { Router } from 'express';
import { z } from 'zod';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound, route } from '../lib/errors.js';
import { generalRateLimit, rateLimit, requireAuth } from '../auth/middleware.js';
import { PRESENCE_META, type PresenceState } from '@carrom/config';
import { presenceFor } from './presence.js';
import { fairPlayFor } from './fairplay.js';

/**
 * Friends, requests, blocks and the leaderboards.
 *
 * Friendship is stored as two rows so both directions can be indexed and read
 * cheaply. Blocking is one-directional and hides the blocker from the blocked.
 */
export const socialRouter = Router();
export const leaderboardRouter = Router();

function onlineExpr(alias = 'p'): string {
  return `(${alias}.last_seen_at > now() - INTERVAL '90 seconds')`;
}

socialRouter.get(
  '/friends',
  requireAuth,
  route(async (req, res) => {
    const rows = await query<{
      user_id: string; username: string; display_name: string; avatar_url: string | null;
      level: number; trophies: number; presence: PresenceState;
      current_match_id: string | null; title_id: string | null; since: Date;
    }>(
      `SELECT u.id AS user_id, u.username, p.display_name, p.avatar_url,
              p.level, p.trophies, p.presence, p.current_match_id, p.title_id,
              f.created_at AS since
         FROM friends f
         JOIN users u ON u.id = f.friend_id
         JOIN profiles p ON p.user_id = u.id
        WHERE f.user_id = $1 AND f.status = 'accepted'
        ORDER BY (p.presence <> 'offline') DESC, p.trophies DESC`,
      [req.auth!.sub],
    );

    // The database mirror can lag a few seconds; Redis has the live answer.
    const live = await presenceFor(rows.map((row) => row.user_id));

    res.json({
      friends: rows.map((row) => {
        const presence = live.get(row.user_id);
        const state: PresenceState = presence?.state ?? row.presence ?? 'offline';
        return {
          ...row,
          presence: state,
          presenceLabel: PRESENCE_META[state].name,
          presenceColor: PRESENCE_META[state].color,
          online: state !== 'offline',
          currentMatchId: presence?.matchId ?? row.current_match_id,
          /** Only a live public match can be watched. */
          watchable: state === 'in_game' && Boolean(presence?.matchId ?? row.current_match_id),
        };
      }),
      presenceStates: PRESENCE_META,
    });
  }),
);

/* --------------------------------- following ------------------------------- */

socialRouter.post(
  '/follow',
  requireAuth,
  rateLimit('follow', 40),
  route(async (req, res) => {
    const { userId, follow } = z
      .object({ userId: z.string().uuid(), follow: z.boolean() })
      .parse(req.body);

    if (userId === req.auth!.sub) throw badRequest('You cannot follow yourself');

    if (follow) {
      await query(
        'INSERT INTO follows (follower_id, followee_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [req.auth!.sub, userId],
      );
    } else {
      await query('DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2', [
        req.auth!.sub,
        userId,
      ]);
    }

    const counts = await one<{ followers: string; following: string }>(
      `SELECT (SELECT COUNT(*) FROM follows WHERE followee_id = $1)::text AS followers,
              (SELECT COUNT(*) FROM follows WHERE follower_id = $1)::text AS following`,
      [userId],
    );

    res.json({ ok: true, followers: Number(counts?.followers ?? 0) });
  }),
);

socialRouter.get(
  '/following',
  requireAuth,
  route(async (req, res) => {
    const rows = await query<{ user_id: string; presence: PresenceState }>(
      `SELECT u.id AS user_id, u.username, p.display_name, p.avatar_url,
              p.level, p.trophies, p.presence, p.current_match_id, p.title_id
         FROM follows f
         JOIN users u ON u.id = f.followee_id
         JOIN profiles p ON p.user_id = u.id
        WHERE f.follower_id = $1
        ORDER BY (p.presence <> 'offline') DESC, p.trophies DESC
        LIMIT 100`,
      [req.auth!.sub],
    );

    const live = await presenceFor(rows.map((row) => row.user_id));
    res.json({
      following: rows.map((row) => {
        const state = live.get(row.user_id)?.state ?? row.presence ?? 'offline';
        return { ...row, presence: state, presenceLabel: PRESENCE_META[state].name };
      }),
    });
  }),
);

/** Fair play standing, shown on a profile. */
socialRouter.get(
  '/fair-play/:id',
  requireAuth,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await fairPlayFor(id));
  }),
);

socialRouter.get(
  '/requests',
  requireAuth,
  route(async (req, res) => {
    const [incoming, outgoing] = await Promise.all([
      query(
        `SELECT fr.id, fr.created_at, u.id AS user_id, u.username,
                p.display_name, p.avatar_url, p.level, p.trophies
           FROM friend_requests fr
           JOIN users u ON u.id = fr.from_user
           JOIN profiles p ON p.user_id = u.id
          WHERE fr.to_user = $1 AND fr.status = 'pending'
          ORDER BY fr.created_at DESC`,
        [req.auth!.sub],
      ),
      query(
        `SELECT fr.id, fr.created_at, u.id AS user_id, u.username,
                p.display_name, p.avatar_url
           FROM friend_requests fr
           JOIN users u ON u.id = fr.to_user
           JOIN profiles p ON p.user_id = u.id
          WHERE fr.from_user = $1 AND fr.status = 'pending'
          ORDER BY fr.created_at DESC`,
        [req.auth!.sub],
      ),
    ]);
    res.json({ incoming, outgoing });
  }),
);

socialRouter.post(
  '/requests',
  requireAuth,
  rateLimit('friend_request', 20),
  route(async (req, res) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    const me = req.auth!.sub;
    if (userId === me) throw badRequest('You cannot add yourself');

    const target = await one('SELECT id FROM users WHERE id = $1', [userId]);
    if (!target) throw notFound('No such player');

    const blocked = await one(
      `SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2 AND status = 'blocked'`,
      [userId, me],
    );
    // Give nothing away about a block; the request simply never arrives.
    if (blocked) return res.json({ ok: true });

    const already = await one(
      `SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2 AND status = 'accepted'`,
      [me, userId],
    );
    if (already) throw conflict('You are already friends', 'already_friends');

    // If they already asked you, accept instead of creating a mirror request.
    const reciprocal = await one<{ id: string }>(
      `SELECT id FROM friend_requests
        WHERE from_user = $1 AND to_user = $2 AND status = 'pending'`,
      [userId, me],
    );
    if (reciprocal) {
      await acceptRequest(reciprocal.id, me);
      return res.json({ ok: true, accepted: true });
    }

    await query(
      `INSERT INTO friend_requests (from_user, to_user)
       VALUES ($1,$2)
       ON CONFLICT (from_user, to_user) DO UPDATE SET
         status = 'pending', created_at = now(), resolved_at = NULL`,
      [me, userId],
    );

    await query(
      `INSERT INTO notifications (user_id, kind, title, body, data)
       VALUES ($1,'friend_request','Friend request',$2,$3)`,
      [userId, `${req.auth!.username} wants to be friends`, JSON.stringify({ fromUserId: me })],
    );

    res.status(201).json({ ok: true });
  }),
);

async function acceptRequest(requestId: string, meId: string): Promise<void> {
  await transaction(async (client) => {
    const row = await client.query<{ from_user: string; to_user: string; status: string }>(
      'SELECT from_user, to_user, status FROM friend_requests WHERE id = $1 FOR UPDATE',
      [requestId],
    );
    const request = row.rows[0];
    if (!request) throw notFound('No such request');
    if (request.to_user !== meId) throw badRequest('That request is not yours to accept');
    if (request.status !== 'pending') throw conflict('That request is already resolved');

    await client.query(
      `UPDATE friend_requests SET status = 'accepted', resolved_at = now() WHERE id = $1`,
      [requestId],
    );
    await client.query(
      `INSERT INTO friends (user_id, friend_id) VALUES ($1,$2),($2,$1)
       ON CONFLICT DO NOTHING`,
      [request.from_user, request.to_user],
    );
    await client.query(
      `INSERT INTO notifications (user_id, kind, title, body, data)
       VALUES ($1,'friend_accepted','Friend added','You are now friends',$2)`,
      [request.from_user, JSON.stringify({ userId: request.to_user })],
    );
  });
}

socialRouter.post(
  '/requests/:id/accept',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await acceptRequest(id, req.auth!.sub);
    res.json({ ok: true });
  }),
);

socialRouter.post(
  '/requests/:id/reject',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const updated = await query(
      `UPDATE friend_requests SET status = 'rejected', resolved_at = now()
        WHERE id = $1 AND to_user = $2 AND status = 'pending'
        RETURNING id`,
      [id, req.auth!.sub],
    );
    if (updated.length === 0) throw notFound('No such request');
    res.json({ ok: true });
  }),
);

socialRouter.delete(
  '/friends/:id',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await query(
      `DELETE FROM friends
        WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
      [req.auth!.sub, id],
    );
    await query(
      `DELETE FROM friend_requests
        WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)`,
      [req.auth!.sub, id],
    );
    res.json({ ok: true });
  }),
);

socialRouter.post(
  '/block',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const { userId, blocked } = z
      .object({ userId: z.string().uuid(), blocked: z.boolean() })
      .parse(req.body);
    const me = req.auth!.sub;
    if (userId === me) throw badRequest('You cannot block yourself');

    if (blocked) {
      await transaction(async (client) => {
        await client.query(
          `DELETE FROM friends
            WHERE (user_id = $1 AND friend_id = $2) OR (user_id = $2 AND friend_id = $1)`,
          [me, userId],
        );
        await client.query(
          `INSERT INTO friends (user_id, friend_id, status) VALUES ($1,$2,'blocked')
           ON CONFLICT (user_id, friend_id) DO UPDATE SET status = 'blocked'`,
          [me, userId],
        );
      });
    } else {
      await query(
        `DELETE FROM friends WHERE user_id = $1 AND friend_id = $2 AND status = 'blocked'`,
        [me, userId],
      );
    }
    res.json({ ok: true });
  }),
);

socialRouter.get(
  '/search',
  requireAuth,
  rateLimit('search', 40),
  route(async (req, res) => {
    const { q } = z.object({ q: z.string().min(2).max(20) }).parse(req.query);
    const rows = await query(
      `SELECT u.id AS user_id, u.username, p.display_name, p.avatar_url,
              p.level, p.trophies, ${onlineExpr()} AS online
         FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE u.username ILIKE $1 ESCAPE '\\' AND u.id <> $2
          AND NOT u.is_guest AND NOT u.is_bot
        ORDER BY p.trophies DESC
        LIMIT 20`,
      // % and _ are LIKE wildcards; escaping them makes the search mean what
      // the player typed rather than matching half the service.
      [`${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`, req.auth!.sub],
    );
    res.json({ players: rows });
  }),
);

/** People you played recently, the easiest place to add someone from. */
socialRouter.get(
  '/recent',
  requireAuth,
  route(async (req, res) => {
    const rows = await query(
      `SELECT DISTINCT ON (u.id)
              u.id AS user_id, u.username, p.display_name, p.avatar_url,
              p.level, p.trophies, m.created_at AS played_at,
              EXISTS (SELECT 1 FROM friends f
                       WHERE f.user_id = $1 AND f.friend_id = u.id
                         AND f.status = 'accepted') AS is_friend
         FROM match_players mine
         JOIN match_players theirs ON theirs.match_id = mine.match_id
                                  AND theirs.user_id <> mine.user_id
         JOIN matches m ON m.id = mine.match_id
         JOIN users u ON u.id = theirs.user_id
         JOIN profiles p ON p.user_id = u.id
        WHERE mine.user_id = $1 AND NOT u.is_guest
        ORDER BY u.id, m.created_at DESC
        LIMIT 30`,
      [req.auth!.sub],
    );
    res.json({ players: rows });
  }),
);

/* ------------------------------- leaderboards ------------------------------ */

const METRIC_COLUMN = {
  trophies: 'p.trophies',
  wins: 'p.wins',
  streak: 'p.best_streak',
  xp: 'p.xp',
  tournament_points: 'p.tournament_points',
} as const;

leaderboardRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    const q = z
      .object({
        scope: z.enum(['global', 'country', 'friends']).default('global'),
        metric: z.enum(['trophies', 'wins', 'streak', 'xp', 'tournament_points']).default('trophies'),
        window: z.enum(['weekly', 'monthly', 'all_time']).default('all_time'),
        limit: z.coerce.number().min(1).max(100).default(50),
      })
      .parse(req.query);

    const column = METRIC_COLUMN[q.metric];
    const me = req.auth!.sub;

    // Weekly and monthly read from match results in the period; all-time reads
    // the career totals on the profile.
    if (q.window !== 'all_time' && (q.metric === 'wins' || q.metric === 'xp')) {
      const interval = q.window === 'weekly' ? '7 days' : '30 days';
      const valueExpr = q.metric === 'wins' ? 'COUNT(*) FILTER (WHERE mr.won)' : 'SUM(mr.xp_gained)';
      const rows = await query(
        `SELECT u.id AS user_id, u.username, p.display_name, p.avatar_url, p.level,
                p.country, ${valueExpr}::bigint AS value
           FROM match_results mr
           JOIN users u ON u.id = mr.user_id
           JOIN profiles p ON p.user_id = u.id
          WHERE mr.created_at > now() - INTERVAL '${interval}'
            AND NOT u.is_guest
            AND NOT u.is_bot
          GROUP BY u.id, u.username, p.display_name, p.avatar_url, p.level, p.country
          ORDER BY value DESC
          LIMIT $1`,
        [q.limit],
      );
      return res.json({ rows: rows.map((r, i) => ({ ...r, position: i + 1 })), scope: q.scope, metric: q.metric, window: q.window });
    }

    let where = 'NOT u.is_guest AND NOT u.is_bot';
    const params: unknown[] = [q.limit];

    if (q.scope === 'country') {
      const mine = await one<{ country: string | null }>(
        'SELECT country FROM profiles WHERE user_id = $1',
        [me],
      );
      if (!mine?.country) return res.json({ rows: [], scope: q.scope, metric: q.metric, window: q.window, needsCountry: true });
      params.push(mine.country);
      where += ` AND p.country = $${params.length}`;
    }

    if (q.scope === 'friends') {
      params.push(me);
      where += ` AND (u.id = $${params.length} OR u.id IN (
        SELECT friend_id FROM friends WHERE user_id = $${params.length} AND status = 'accepted'))`;
    }

    const rows = await query(
      `SELECT u.id AS user_id, u.username, p.display_name, p.avatar_url,
              p.level, p.country, ${column}::bigint AS value
         FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE ${where}
        ORDER BY value DESC
        LIMIT $1`,
      params,
    );

    const myPosition = await one<{ position: string }>(
      `SELECT COUNT(*) + 1 AS position
         FROM users u JOIN profiles p ON p.user_id = u.id
        WHERE NOT u.is_guest AND ${column} > (SELECT ${column} FROM profiles p WHERE p.user_id = $1)`,
      [me],
    );

    res.json({
      rows: rows.map((r, i) => ({ ...r, position: i + 1 })),
      scope: q.scope,
      metric: q.metric,
      window: q.window,
      myPosition: myPosition ? Number(myPosition.position) : null,
    });
  }),
);
