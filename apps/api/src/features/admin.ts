import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool.js';
import { badRequest, notFound, route } from '../lib/errors.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { auditBalances } from './economy.js';
import { healthy } from '../db/pool.js';
import { redisReady } from '../lib/redis.js';
import { liveStats } from '../game/gateway.js';
import { queueSnapshot } from '../game/matchmaking.js';
import { detectCollusion } from '../game/antiCheat.js';
import { matchReplay } from '../game/matches.js';

/**
 * Admin dashboard API. Every mutating route writes an audit log entry, so the
 * question "who changed this and when" always has an answer.
 */
export const adminRouter = Router();
export const analyticsRouter = Router();

adminRouter.use(requireAuth, requireRole('moderator', 'admin'));

async function audit(
  actorId: string,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail: Record<string, unknown>,
  ip?: string,
): Promise<void> {
  await query(
    `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actorId, action, targetType, targetId, JSON.stringify(detail), ip ?? null],
  );
}

/* --------------------------------- players -------------------------------- */

adminRouter.get(
  '/users',
  route(async (req, res) => {
    const q = z
      .object({
        search: z.string().max(64).optional(),
        banned: z.coerce.boolean().optional(),
        limit: z.coerce.number().min(1).max(200).default(50),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const rows = await query(
      `SELECT u.id, u.username, u.email, u.role, u.is_guest, u.created_at,
              p.display_name, p.level, p.coins, p.trophies,
              p.games_played, p.wins, p.losses, p.last_seen_at,
              CASE WHEN p.games_played > 0
                   THEN ROUND(p.wins::numeric / p.games_played, 3) ELSE 0 END AS win_rate,
              EXISTS (SELECT 1 FROM bans b
                       WHERE b.user_id = u.id AND b.lifted_at IS NULL
                         AND (b.expires_at IS NULL OR b.expires_at > now())) AS banned,
              (SELECT COUNT(*) FROM reports r WHERE r.reported_id = u.id) AS reports_against,
              (SELECT COUNT(*) FROM cheat_flags cf
                WHERE cf.user_id = u.id AND NOT cf.reviewed) AS open_flags
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id
        WHERE ($1::text IS NULL OR u.username ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
        ORDER BY u.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q.search ?? null, q.limit, q.offset],
    );

    const filtered = q.banned === undefined ? rows : rows.filter((r) => Boolean(r.banned) === q.banned);
    res.json({ users: filtered });
  }),
);

adminRouter.get(
  '/users/:id',
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);

    const [user, matches, flags, reports, bans, ledger, inventoryCount, socials] = await Promise.all([
      one(
        `SELECT u.id, u.username, u.email, u.role, u.is_guest, u.email_verified, u.created_at,
                p.* FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
        [id],
      ),
      query(
        `SELECT m.id, m.mode_id, m.tier_id, m.status, m.end_reason, m.turn_count, m.created_at,
                mp.won, mp.pocketed, mp.fouls, mp.left_early
           FROM match_players mp JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = $1 ORDER BY m.created_at DESC LIMIT 50`,
        [id],
      ),
      query(
        `SELECT id, signal, severity, detail, match_id, reviewed, created_at
           FROM cheat_flags WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [id],
      ),
      query(
        `SELECT r.id, r.category, r.status, r.resolution, r.created_at, u.username AS reporter
           FROM reports r JOIN users u ON u.id = r.reporter_id
          WHERE r.reported_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
        [id],
      ),
      query(
        `SELECT id, reason, scope, expires_at, lifted_at, created_at FROM bans
          WHERE user_id = $1 ORDER BY created_at DESC`,
        [id],
      ),
      query(
        `SELECT delta, balance_after, reason, note, created_at FROM coin_ledger
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [id],
      ),
      one<{ count: string }>('SELECT COUNT(*)::text AS count FROM inventory WHERE user_id = $1', [id]),
      query('SELECT provider, provider_user_id, linked_at, revoked_at FROM social_accounts WHERE user_id = $1', [id]),
    ]);

    if (!user) throw notFound('No such player');
    res.json({
      user,
      matches,
      cheatFlags: flags,
      reports,
      bans,
      ledger,
      inventoryCount: Number(inventoryCount?.count ?? 0),
      socialAccounts: socials,
    });
  }),
);

adminRouter.post(
  '/users/:id/role',
  requireRole('admin'),
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { role } = z.object({ role: z.enum(['player', 'moderator', 'admin']) }).parse(req.body);

    if (id === req.auth!.sub) throw badRequest('You cannot change your own role');

    await query('UPDATE users SET role = $2, updated_at = now() WHERE id = $1', [id, role]);
    await audit(req.auth!.sub, 'user.role', 'user', id, { role }, req.ip);
    res.json({ ok: true });
  }),
);

/** Adjust a virtual coin balance, always with a reason on the record. */
adminRouter.post(
  '/users/:id/coins',
  requireRole('admin'),
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        delta: z.number().int().min(-10_000_000).max(10_000_000),
        note: z.string().min(3).max(200),
      })
      .parse(req.body);

    const { moveCoinsStandalone } = await import('./economy.js');
    const balance = await moveCoinsStandalone({
      userId: id,
      delta: body.delta,
      reason: 'admin',
      note: `${body.note} (by ${req.auth!.username})`,
    });

    await audit(req.auth!.sub, 'user.coins', 'user', id, body, req.ip);
    res.json({ ok: true, balance });
  }),
);

/* --------------------------------- matches -------------------------------- */

adminRouter.get(
  '/matches',
  route(async (req, res) => {
    const q = z
      .object({
        status: z.enum(['waiting', 'playing', 'finished', 'cancelled']).optional(),
        suspicious: z.coerce.boolean().optional(),
        limit: z.coerce.number().min(1).max(200).default(50),
      })
      .parse(req.query);

    const rows = await query(
      `SELECT m.*,
              ARRAY(SELECT u.username FROM match_players mp
                      JOIN users u ON u.id = mp.user_id
                     WHERE mp.match_id = m.id ORDER BY mp.seat) AS players,
              (SELECT COUNT(*) FROM cheat_flags cf WHERE cf.match_id = m.id) AS flags
         FROM matches m
        WHERE ($1::text IS NULL OR m.status = $1)
        ORDER BY m.created_at DESC
        LIMIT $2`,
      [q.status ?? null, q.limit],
    );

    res.json({
      matches: q.suspicious ? rows.filter((r) => Number(r.flags) > 0) : rows,
    });
  }),
);

adminRouter.get(
  '/matches/:id/replay',
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const [match, events, players] = await Promise.all([
      one('SELECT * FROM matches WHERE id = $1', [id]),
      matchReplay(id),
      query(
        `SELECT mp.*, u.username FROM match_players mp
           JOIN users u ON u.id = mp.user_id WHERE mp.match_id = $1 ORDER BY mp.seat`,
        [id],
      ),
    ]);
    if (!match) throw notFound('No such match');
    res.json({ match, players, events });
  }),
);

/* ---------------------------------- items --------------------------------- */

adminRouter.get(
  '/items',
  route(async (_req, res) => {
    const rows = await query(
      `SELECT i.*, (SELECT COUNT(*) FROM inventory inv WHERE inv.item_id = i.id) AS owners
         FROM items i ORDER BY i.category, i.rarity, i.name`,
    );
    res.json({ items: rows });
  }),
);

adminRouter.patch(
  '/items/:id',
  requireRole('admin'),
  route(async (req, res) => {
    const id = z.string().min(1).max(64).parse(req.params.id);
    const body = z
      .object({
        enabled: z.boolean().optional(),
        droppable: z.boolean().optional(),
        priceCoins: z.number().int().min(0).max(100_000_000).nullable().optional(),
      })
      .parse(req.body);

    const updated = await query(
      `UPDATE items SET
         enabled = COALESCE($2, enabled),
         droppable = COALESCE($3, droppable),
         price_coins = CASE WHEN $4::boolean THEN $5 ELSE price_coins END,
         updated_at = now()
       WHERE id = $1 RETURNING id`,
      [id, body.enabled ?? null, body.droppable ?? null, body.priceCoins !== undefined, body.priceCoins ?? null],
    );
    if (updated.length === 0) throw notFound('No such item');

    await audit(req.auth!.sub, 'item.update', 'item', id, body, req.ip);
    res.json({ ok: true });
  }),
);

/* -------------------------------- dashboard -------------------------------- */

adminRouter.get(
  '/overview',
  route(async (_req, res) => {
    const [users, matches, economy, moderation] = await Promise.all([
      one(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '1 day')::int AS new_today,
                COUNT(*) FILTER (WHERE is_guest)::int AS guests
           FROM users`,
      ),
      one(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE created_at > now() - INTERVAL '1 day')::int AS today,
                COUNT(*) FILTER (WHERE status = 'playing')::int AS live,
                COUNT(*) FILTER (WHERE end_reason IN ('forfeit','abandoned'))::int AS abandoned,
                COALESCE(AVG(EXTRACT(EPOCH FROM (ended_at - started_at)))
                         FILTER (WHERE ended_at IS NOT NULL), 0)::int AS avg_seconds
           FROM matches`,
      ),
      one(
        `SELECT COALESCE(SUM(coins), 0)::bigint AS coins_in_circulation,
                COUNT(*)::int AS wallets
           FROM profiles`,
      ),
      one(
        `SELECT (SELECT COUNT(*) FROM reports WHERE status = 'open')::int AS open_reports,
                (SELECT COUNT(*) FROM cheat_flags WHERE NOT reviewed)::int AS open_flags,
                (SELECT COUNT(*) FROM bans
                  WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now()))::int AS active_bans`,
      ),
    ]);

    res.json({
      users,
      matches,
      economy,
      moderation,
      live: liveStats(),
      queues: queueSnapshot(),
      health: { database: await healthy(), redis: redisReady() },
    });
  }),
);

adminRouter.get(
  '/economy/audit',
  requireRole('admin'),
  route(async (_req, res) => {
    const mismatches = await auditBalances();
    res.json({
      ok: mismatches.length === 0,
      mismatches,
      note: 'Each profile balance should equal the sum of its coin ledger.',
    });
  }),
);

adminRouter.post(
  '/anti-cheat/collusion-scan',
  requireRole('admin'),
  route(async (req, res) => {
    await detectCollusion();
    await audit(req.auth!.sub, 'anticheat.collusion_scan', null, null, {}, req.ip);
    res.json({ ok: true, message: 'Scan complete; results are in the flag queue.' });
  }),
);

adminRouter.get(
  '/audit-log',
  route(async (req, res) => {
    const limit = z.coerce.number().min(1).max(500).default(100).parse(req.query.limit);
    const rows = await query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at,
              u.username AS actor
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
        ORDER BY a.created_at DESC LIMIT $1`,
      [limit],
    );
    res.json({ entries: rows });
  }),
);

/* -------------------------------- analytics -------------------------------- */

/** Product metrics. No personal data beyond the user id is recorded. */
analyticsRouter.post(
  '/event',
  requireAuth,
  route(async (req, res) => {
    const body = z
      .object({
        name: z.string().min(1).max(64),
        props: z.record(z.unknown()).default({}),
        platform: z.enum(['web', 'android', 'ios', 'unknown']).default('unknown'),
      })
      .parse(req.body);

    await query(
      'INSERT INTO analytics_events (user_id, name, props, platform) VALUES ($1,$2,$3,$4)',
      [req.auth!.sub, body.name, JSON.stringify(body.props), body.platform],
    );
    res.status(202).json({ ok: true });
  }),
);

analyticsRouter.get(
  '/summary',
  requireAuth,
  requireRole('moderator', 'admin'),
  route(async (_req, res) => {
    const [active, retention, popular, crates, levels] = await Promise.all([
      one(
        `SELECT COUNT(DISTINCT user_id) FILTER (WHERE created_at > now() - INTERVAL '1 day')::int AS dau,
                COUNT(DISTINCT user_id) FILTER (WHERE created_at > now() - INTERVAL '30 days')::int AS mau
           FROM match_results`,
      ),
      one(
        `SELECT COUNT(*) FILTER (WHERE last_seen_at > now() - INTERVAL '1 day')::int AS d1,
                COUNT(*) FILTER (WHERE last_seen_at > now() - INTERVAL '7 days')::int AS d7,
                COUNT(*) FILTER (WHERE last_seen_at > now() - INTERVAL '30 days')::int AS d30
           FROM profiles`,
      ),
      Promise.all([
        query(
          `SELECT board_id AS id, COUNT(*)::int AS plays FROM matches
            GROUP BY board_id ORDER BY plays DESC LIMIT 10`,
        ),
        query(
          `SELECT striker_skin AS id, COUNT(*)::int AS uses FROM match_players
            GROUP BY striker_skin ORDER BY uses DESC LIMIT 10`,
        ),
        query(
          `SELECT coin_skin AS id, COUNT(*)::int AS uses FROM match_players
            GROUP BY coin_skin ORDER BY uses DESC LIMIT 10`,
        ),
      ]),
      query(
        `SELECT kind, COUNT(*)::int AS opened FROM crates
          WHERE opened_at IS NOT NULL GROUP BY kind`,
      ),
      query(
        `SELECT level, COUNT(*)::int AS players FROM profiles
          GROUP BY level ORDER BY level`,
      ),
    ]);

    const [boards, strikers, coinSets] = popular;
    res.json({
      active,
      retention,
      popular: { boards, strikers, coinSets },
      crates,
      levelDistribution: levels,
    });
  }),
);
