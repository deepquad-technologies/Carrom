import { Router } from 'express';
import { z } from 'zod';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound, route } from '../lib/errors.js';
import { generalRateLimit, rateLimit, requireAuth, requireRole } from '../auth/middleware.js';
import { revokeAllForUser } from '../auth/tokens.js';
import { logger } from '../lib/logger.js';

/**
 * Reporting and moderation.
 *
 * A player reports someone from a match or a profile. The report lands in the
 * admin queue with everything a reviewer needs — the account, its recent
 * matches, and any automated cheat flags raised against it. Nothing is
 * automatic: a ban only ever happens because a moderator decided on a report.
 */
export const reportRouter = Router();
export const moderationRouter = Router();

const REPORT_CATEGORIES = [
  'cheating',
  'bot',
  'stalling',
  'abuse',
  'offensive_name',
  'collusion',
  'other',
] as const;

export const REPORT_CATEGORY_LABELS: Record<(typeof REPORT_CATEGORIES)[number], string> = {
  cheating: 'Cheating or modified client',
  bot: 'Playing with a bot',
  stalling: 'Stalling or wasting time',
  abuse: 'Abusive behaviour',
  offensive_name: 'Offensive name',
  collusion: 'Teaming up unfairly',
  other: 'Something else',
};

reportRouter.get('/categories', (_req, res) => {
  res.json({
    categories: REPORT_CATEGORIES.map((id) => ({ id, label: REPORT_CATEGORY_LABELS[id] })),
  });
});

/** File a report. One open report per pair, enforced by a partial unique index. */
reportRouter.post(
  '/',
  requireAuth,
  rateLimit('report', 6),
  route(async (req, res) => {
    const body = z
      .object({
        reportedUserId: z.string().uuid(),
        category: z.enum(REPORT_CATEGORIES),
        matchId: z.string().uuid().optional(),
        detail: z.string().max(500).optional(),
      })
      .parse(req.body);

    const reporterId = req.auth!.sub;
    if (body.reportedUserId === reporterId) {
      throw badRequest('You cannot report yourself', 'self_report');
    }

    const target = await one('SELECT id FROM users WHERE id = $1', [body.reportedUserId]);
    if (!target) throw notFound('No such player');

    // Only report someone you actually played against.
    if (body.matchId) {
      const shared = await one(
        `SELECT 1 FROM match_players a
           JOIN match_players b ON b.match_id = a.match_id
          WHERE a.match_id = $1 AND a.user_id = $2 AND b.user_id = $3`,
        [body.matchId, reporterId, body.reportedUserId],
      );
      if (!shared) throw badRequest('You were not in that match', 'not_in_match');
    }

    try {
      const row = await one<{ id: string }>(
        `INSERT INTO reports (reporter_id, reported_id, match_id, category, detail)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id`,
        [reporterId, body.reportedUserId, body.matchId ?? null, body.category, body.detail ?? null],
      );

      logger.info(
        { reportId: row?.id, reporterId, reportedId: body.reportedUserId, category: body.category },
        'report filed',
      );

      res.status(201).json({
        ok: true,
        reportId: row?.id,
        message: 'Thanks. Our team will review this.',
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw conflict('You already have an open report about that player', 'duplicate_report');
      }
      throw err;
    }
  }),
);

/** Reports this player has filed, so they can see they were received. */
reportRouter.get(
  '/mine',
  requireAuth,
  route(async (req, res) => {
    const rows = await query<{
      id: string; category: string; status: string; created_at: Date; reviewed_at: Date | null;
    }>(
      `SELECT id, category, status, created_at, reviewed_at
         FROM reports WHERE reporter_id = $1
        ORDER BY created_at DESC LIMIT 50`,
      [req.auth!.sub],
    );
    res.json({ reports: rows });
  }),
);

/* ----------------------------------- mutes --------------------------------- */

reportRouter.post(
  '/mute',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const { userId, muted } = z
      .object({ userId: z.string().uuid(), muted: z.boolean() })
      .parse(req.body);

    if (userId === req.auth!.sub) throw badRequest('You cannot mute yourself');

    if (muted) {
      await query(
        `INSERT INTO mutes (user_id, muted_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [req.auth!.sub, userId],
      );
    } else {
      await query('DELETE FROM mutes WHERE user_id = $1 AND muted_id = $2', [req.auth!.sub, userId]);
    }
    res.json({ ok: true });
  }),
);

export async function mutedBy(userId: string): Promise<Set<string>> {
  const rows = await query<{ muted_id: string }>(
    'SELECT muted_id FROM mutes WHERE user_id = $1',
    [userId],
  );
  return new Set(rows.map((r) => r.muted_id));
}

/* ------------------------------ admin review ------------------------------- */

moderationRouter.use(requireAuth, requireRole('moderator', 'admin'));

/** The review queue, newest first. */
moderationRouter.get(
  '/reports',
  route(async (req, res) => {
    const q = z
      .object({
        status: z.enum(['open', 'reviewing', 'actioned', 'dismissed']).optional(),
        limit: z.coerce.number().min(1).max(200).default(50),
        offset: z.coerce.number().min(0).default(0),
      })
      .parse(req.query);

    const rows = await query(
      `SELECT r.id, r.category, r.detail, r.status, r.resolution, r.created_at,
              r.reviewed_at, r.review_note, r.match_id,
              reporter.username AS reporter_username, r.reporter_id,
              reported.username AS reported_username, r.reported_id,
              p.level, p.trophies, p.games_played, p.wins,
              (SELECT COUNT(*) FROM reports r2
                WHERE r2.reported_id = r.reported_id) AS reports_against,
              (SELECT COUNT(*) FROM cheat_flags cf
                WHERE cf.user_id = r.reported_id AND NOT cf.reviewed) AS open_flags
         FROM reports r
         JOIN users reporter ON reporter.id = r.reporter_id
         JOIN users reported ON reported.id = r.reported_id
         LEFT JOIN profiles p ON p.user_id = r.reported_id
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3`,
      [q.status ?? null, q.limit, q.offset],
    );

    const counts = await one<{ open: string; reviewing: string }>(
      `SELECT COUNT(*) FILTER (WHERE status = 'open')::text AS open,
              COUNT(*) FILTER (WHERE status = 'reviewing')::text AS reviewing
         FROM reports`,
    );

    res.json({
      reports: rows,
      counts: { open: Number(counts?.open ?? 0), reviewing: Number(counts?.reviewing ?? 0) },
    });
  }),
);

/**
 * Everything a reviewer needs about one report: the account, its record, its
 * recent matches and every automated flag against it.
 */
moderationRouter.get(
  '/reports/:id',
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);

    const report = await one<{ reported_id: string; reporter_id: string; match_id: string | null }>(
      'SELECT * FROM reports WHERE id = $1',
      [id],
    );
    if (!report) throw notFound('No such report');

    const [account, matches, flags, otherReports, bans, ledger] = await Promise.all([
      one(
        `SELECT u.id, u.username, u.email, u.created_at, u.is_guest, u.role,
                p.display_name, p.level, p.xp, p.coins, p.trophies,
                p.games_played, p.wins, p.losses, p.best_streak, p.last_seen_at,
                CASE WHEN p.games_played > 0
                     THEN ROUND(p.wins::numeric / p.games_played, 3)
                     ELSE 0 END AS win_rate
           FROM users u LEFT JOIN profiles p ON p.user_id = u.id
          WHERE u.id = $1`,
        [report.reported_id],
      ),
      query(
        `SELECT m.id, m.mode_id, m.tier_id, m.status, m.end_reason, m.turn_count,
                m.created_at, mp.won, mp.pocketed, mp.fouls, mp.left_early
           FROM match_players mp
           JOIN matches m ON m.id = mp.match_id
          WHERE mp.user_id = $1
          ORDER BY m.created_at DESC
          LIMIT 25`,
        [report.reported_id],
      ),
      query(
        `SELECT id, signal, severity, detail, match_id, reviewed, created_at
           FROM cheat_flags
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [report.reported_id],
      ),
      query(
        `SELECT r.id, r.category, r.status, r.resolution, r.created_at, u.username AS reporter
           FROM reports r JOIN users u ON u.id = r.reporter_id
          WHERE r.reported_id = $1 AND r.id <> $2
          ORDER BY r.created_at DESC LIMIT 25`,
        [report.reported_id, id],
      ),
      query(
        `SELECT id, reason, scope, expires_at, lifted_at, created_at
           FROM bans WHERE user_id = $1 ORDER BY created_at DESC`,
        [report.reported_id],
      ),
      query(
        `SELECT delta, reason, note, created_at FROM coin_ledger
          WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [report.reported_id],
      ),
    ]);

    // Opening the case marks it as being looked at.
    await query(
      `UPDATE reports SET status = 'reviewing' WHERE id = $1 AND status = 'open'`,
      [id],
    );

    res.json({ report, account, matches, cheatFlags: flags, otherReports, bans, ledger });
  }),
);

/**
 * Resolve a report. `ban` is the only path that suspends an account, and it
 * always records who decided it and why.
 */
moderationRouter.post(
  '/reports/:id/resolve',
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        resolution: z.enum(['ban', 'warn', 'no_action', 'duplicate']),
        note: z.string().max(1000).optional(),
        ban: z
          .object({
            reason: z.string().min(3).max(200),
            scope: z.enum(['account', 'ranked', 'chat']).default('account'),
            /** Omit for a permanent ban. */
            days: z.number().int().min(1).max(3650).optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const moderatorId = req.auth!.sub;

    const result = await transaction(async (client) => {
      const reportRow = await client.query<{ reported_id: string; status: string }>(
        'SELECT reported_id, status FROM reports WHERE id = $1 FOR UPDATE',
        [id],
      );
      const report = reportRow.rows[0];
      if (!report) throw notFound('No such report');
      if (report.status === 'actioned' || report.status === 'dismissed') {
        throw conflict('That report is already resolved', 'already_resolved');
      }

      let banId: string | null = null;

      if (body.resolution === 'ban') {
        if (!body.ban) throw badRequest('A ban needs a reason', 'ban_reason_required');

        const expiresAt = body.ban.days
          ? new Date(Date.now() + body.ban.days * 86_400_000)
          : null;

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO bans (user_id, reason, scope, expires_at, issued_by, report_id)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [report.reported_id, body.ban.reason, body.ban.scope, expiresAt, moderatorId, id],
        );
        banId = inserted.rows[0].id;

        await client.query(
          `INSERT INTO notifications (user_id, kind, title, body, data)
           VALUES ($1,'system',$2,$3,$4)`,
          [
            report.reported_id,
            body.ban.scope === 'account' ? 'Account suspended' : 'Restriction applied',
            body.ban.reason,
            JSON.stringify({ scope: body.ban.scope, expiresAt }),
          ],
        );
      }

      if (body.resolution === 'warn') {
        await client.query(
          `INSERT INTO notifications (user_id, kind, title, body, data)
           VALUES ($1,'system','Warning',$2,'{}'::jsonb)`,
          [report.reported_id, body.note ?? 'Please review the community rules.'],
        );
      }

      await client.query(
        `UPDATE reports
            SET status = $2, resolution = $3, reviewed_by = $4,
                reviewed_at = now(), review_note = $5
          WHERE id = $1`,
        [
          id,
          body.resolution === 'ban' || body.resolution === 'warn' ? 'actioned' : 'dismissed',
          body.resolution,
          moderatorId,
          body.note ?? null,
        ],
      );

      // Any automated flags on this account are now considered reviewed.
      await client.query(
        'UPDATE cheat_flags SET reviewed = TRUE WHERE user_id = $1 AND NOT reviewed',
        [report.reported_id],
      );

      await client.query(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip)
         VALUES ($1,'report.resolve','report',$2,$3,$4)`,
        [moderatorId, id, JSON.stringify({ ...body, banId }), req.ip ?? null],
      );

      return { reportedId: report.reported_id, banId };
    });

    // A suspended account should not keep playing on an old token.
    if (body.resolution === 'ban' && body.ban?.scope === 'account') {
      await revokeAllForUser(result.reportedId);
    }

    logger.info(
      { reportId: id, moderatorId, resolution: body.resolution, banId: result.banId },
      'report resolved',
    );

    res.json({ ok: true, ...result });
  }),
);

/** Ban directly, without a report — for cases staff find themselves. */
moderationRouter.post(
  '/users/:id/ban',
  requireRole('admin'),
  route(async (req, res) => {
    const userId = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        reason: z.string().min(3).max(200),
        scope: z.enum(['account', 'ranked', 'chat']).default('account'),
        days: z.number().int().min(1).max(3650).optional(),
      })
      .parse(req.body);

    const target = await one<{ role: string }>('SELECT role FROM users WHERE id = $1', [userId]);
    if (!target) throw notFound('No such player');
    if (target.role === 'admin') throw badRequest('Admins cannot be banned from here');

    const expiresAt = body.days ? new Date(Date.now() + body.days * 86_400_000) : null;

    const ban = await one<{ id: string }>(
      `INSERT INTO bans (user_id, reason, scope, expires_at, issued_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [userId, body.reason, body.scope, expiresAt, req.auth!.sub],
    );

    await query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip)
       VALUES ($1,'user.ban','user',$2,$3,$4)`,
      [req.auth!.sub, userId, JSON.stringify(body), req.ip ?? null],
    );

    if (body.scope === 'account') await revokeAllForUser(userId);

    res.json({ ok: true, banId: ban?.id });
  }),
);

moderationRouter.post(
  '/users/:id/unban',
  requireRole('admin'),
  route(async (req, res) => {
    const userId = z.string().uuid().parse(req.params.id);
    const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});

    const lifted = await query(
      `UPDATE bans SET lifted_at = now(), lifted_by = $2
        WHERE user_id = $1 AND lifted_at IS NULL
        RETURNING id`,
      [userId, req.auth!.sub],
    );

    await query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail, ip)
       VALUES ($1,'user.unban','user',$2,$3,$4)`,
      [req.auth!.sub, userId, JSON.stringify({ note, lifted: lifted.length }), req.ip ?? null],
    );

    await query(
      `INSERT INTO notifications (user_id, kind, title, body)
       VALUES ($1,'system','Restriction lifted','Your account is active again.')`,
      [userId],
    );

    res.json({ ok: true, lifted: lifted.length });
  }),
);

/** The automated cheat-flag queue, independent of player reports. */
moderationRouter.get(
  '/flags',
  route(async (req, res) => {
    const q = z
      .object({
        reviewed: z.coerce.boolean().optional(),
        limit: z.coerce.number().min(1).max(200).default(50),
      })
      .parse(req.query);

    const rows = await query(
      `SELECT cf.id, cf.signal, cf.severity, cf.detail, cf.match_id, cf.reviewed, cf.created_at,
              u.id AS user_id, u.username, p.level, p.trophies, p.games_played, p.wins
         FROM cheat_flags cf
         JOIN users u ON u.id = cf.user_id
         LEFT JOIN profiles p ON p.user_id = cf.user_id
        WHERE ($1::boolean IS NULL OR cf.reviewed = $1)
        ORDER BY cf.severity DESC, cf.created_at DESC
        LIMIT $2`,
      [q.reviewed ?? null, q.limit],
    );
    res.json({ flags: rows });
  }),
);

moderationRouter.post(
  '/flags/:id/review',
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await query('UPDATE cheat_flags SET reviewed = TRUE WHERE id = $1', [id]);
    await query(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id)
       VALUES ($1,'flag.review','cheat_flag',$2)`,
      [req.auth!.sub, id],
    );
    res.json({ ok: true });
  }),
);
