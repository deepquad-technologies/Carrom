import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool.js';
import { route } from '../lib/errors.js';
import { generalRateLimit, requireAuth } from '../auth/middleware.js';

/**
 * Notifications.
 *
 * Rows are written all over the app — a friend request, a crate finishing, a
 * moderation decision, a season ending. This is the read side: a list, an
 * unread count for the header badge, and the two ways of clearing them.
 *
 * There is deliberately no "delete all" that runs across the whole table. A
 * player clearing their list should not be able to make the server walk years
 * of history, so reads and writes are always bounded by a window.
 */
export const notificationRouter = Router();

/** Nothing older than this is shown; the retention job removes it eventually. */
const WINDOW_DAYS = 60;

interface Row {
  id: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

function toNotification(row: Row) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/** Write a notification. Used by every feature that needs to tell someone something. */
export async function notify(
  userId: string,
  kind: string,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await query(
    `INSERT INTO notifications (user_id, kind, title, body, data)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, kind, title, body, JSON.stringify(data)],
  );
}

notificationRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    const params = z
      .object({
        unread: z.enum(['true', 'false']).optional(),
        kind: z.string().max(40).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(30),
        before: z.string().datetime().optional(),
      })
      .parse(req.query);

    const rows = await query<Row>(
      `SELECT id, kind, title, body, data, read_at, created_at
         FROM notifications
        WHERE user_id = $1
          AND created_at > now() - ($2 || ' days')::interval
          AND ($3::boolean IS NOT TRUE OR read_at IS NULL)
          AND ($4::text IS NULL OR kind = $4)
          AND ($5::timestamptz IS NULL OR created_at < $5)
        ORDER BY created_at DESC
        LIMIT $6`,
      [
        req.auth!.sub,
        String(WINDOW_DAYS),
        params.unread === 'true',
        params.kind ?? null,
        params.before ?? null,
        params.limit,
      ],
    );

    const unread = await one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications
        WHERE user_id = $1 AND read_at IS NULL
          AND created_at > now() - ($2 || ' days')::interval`,
      [req.auth!.sub, String(WINDOW_DAYS)],
    );

    res.json({
      notifications: rows.map(toNotification),
      unread: Number(unread?.count ?? 0),
    });
  }),
);

notificationRouter.get(
  '/unread-count',
  requireAuth,
  route(async (req, res) => {
    const row = await one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications
        WHERE user_id = $1 AND read_at IS NULL
          AND created_at > now() - ($2 || ' days')::interval`,
      [req.auth!.sub, String(WINDOW_DAYS)],
    );
    res.json({ unread: Number(row?.count ?? 0) });
  }),
);

notificationRouter.post(
  '/read',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).parse(req.body);

    // The user_id predicate is what stops one player marking another's read.
    const rows = await query<{ id: string }>(
      `UPDATE notifications SET read_at = now()
        WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL
        RETURNING id`,
      [req.auth!.sub, body.ids],
    );
    res.json({ updated: rows.length });
  }),
);

notificationRouter.post(
  '/read-all',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const rows = await query<{ id: string }>(
      `UPDATE notifications SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL
          AND created_at > now() - ($2 || ' days')::interval
        RETURNING id`,
      [req.auth!.sub, String(WINDOW_DAYS)],
    );
    res.json({ updated: rows.length });
  }),
);

notificationRouter.delete(
  '/:id',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await query('DELETE FROM notifications WHERE user_id = $1 AND id = $2', [req.auth!.sub, id]);
    res.json({ ok: true });
  }),
);
