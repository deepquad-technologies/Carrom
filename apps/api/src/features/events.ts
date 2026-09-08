import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool.js';
import { notFound, route } from '../lib/errors.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';

/**
 * Limited-time events: a double-XP weekend, a festival theme, a coin boost.
 *
 * Events live in the database rather than in code so running one is an admin
 * action, not a deploy. The multiplier is read at payout time through
 * {@link eventMultipliers}, which is cached for a few seconds — a live event
 * should not add a query to every single match settlement.
 */
export const eventRouter = Router();
export const eventAdminRouter = Router();

export type EventKind = 'xp_boost' | 'coin_boost' | 'crate_boost' | 'themed' | 'tournament';

export interface LiveEvent {
  id: string;
  name: string;
  description: string;
  kind: EventKind;
  multiplier: number;
  accent: string;
  bannerId: string | null;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

interface Row {
  id: string;
  name: string;
  description: string;
  kind: EventKind;
  multiplier: string;
  accent: string;
  banner_id: string | null;
  starts_at: string;
  ends_at: string;
  active: boolean;
}

function toEvent(row: Row): LiveEvent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    multiplier: Number(row.multiplier),
    accent: row.accent,
    bannerId: row.banner_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    active: row.active,
  };
}

/* --------------------------------- cache ---------------------------------- */

let cache: { at: number; events: LiveEvent[] } = { at: 0, events: [] };
const CACHE_MS = 10_000;

/** Events running right now. Cached, because payouts read this constantly. */
export async function activeEvents(): Promise<LiveEvent[]> {
  const now = Date.now();
  if (now - cache.at < CACHE_MS) return cache.events;

  const rows = await query<Row>(
    `SELECT * FROM live_events
      WHERE active = TRUE AND starts_at <= now() AND ends_at > now()
      ORDER BY starts_at`,
  );
  cache = { at: now, events: rows.map(toEvent) };
  return cache.events;
}

/** Invalidate after an admin edit so the change is visible immediately. */
function bustCache(): void {
  cache = { at: 0, events: [] };
}

export interface EventMultipliers {
  xp: number;
  coins: number;
  crate: number;
}

/**
 * Combined multipliers for a payout. Overlapping events of the same kind take
 * the largest rather than multiplying, so two well-meaning admins cannot
 * accidentally ship a 9x coin weekend.
 */
export async function eventMultipliers(): Promise<EventMultipliers> {
  const events = await activeEvents();
  const best = (kind: EventKind) =>
    events.filter((e) => e.kind === kind).reduce((max, e) => Math.max(max, e.multiplier), 1);

  return { xp: best('xp_boost'), coins: best('coin_boost'), crate: best('crate_boost') };
}

/* -------------------------------- player API ------------------------------ */

eventRouter.get(
  '/',
  requireAuth,
  route(async (_req, res) => {
    const events = await activeEvents();

    const upcoming = await query<Row>(
      `SELECT * FROM live_events
        WHERE active = TRUE AND starts_at > now() AND starts_at < now() + INTERVAL '14 days'
        ORDER BY starts_at LIMIT 5`,
    );

    res.json({
      active: events,
      upcoming: upcoming.map(toEvent),
      multipliers: await eventMultipliers(),
    });
  }),
);

/* -------------------------------- admin API ------------------------------- */

const eventInput = z.object({
  id: z
    .string()
    .min(3)
    .max(48)
    .regex(/^[a-z0-9_-]+$/, 'Use lowercase letters, digits, dash and underscore.'),
  name: z.string().min(3).max(80),
  description: z.string().max(400).default(''),
  kind: z.enum(['xp_boost', 'coin_boost', 'crate_boost', 'themed', 'tournament']),
  multiplier: z.number().min(1).max(10).default(1),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f2c94c'),
  bannerId: z.string().max(48).nullable().default(null),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  active: z.boolean().default(true),
});

eventAdminRouter.get(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (_req, res) => {
    const rows = await query<Row>('SELECT * FROM live_events ORDER BY starts_at DESC LIMIT 100');
    res.json({ events: rows.map(toEvent) });
  }),
);

eventAdminRouter.post(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = eventInput.parse(req.body);
    if (new Date(body.endsAt) <= new Date(body.startsAt)) {
      res.status(400).json({
        error: { code: 'BAD_WINDOW', message: 'The event must end after it starts.' },
      });
      return;
    }

    const row = await one<Row>(
      `INSERT INTO live_events
         (id, name, description, kind, multiplier, accent, banner_id, starts_at, ends_at, active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, kind = EXCLUDED.kind,
         multiplier = EXCLUDED.multiplier, accent = EXCLUDED.accent, banner_id = EXCLUDED.banner_id,
         starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, active = EXCLUDED.active
       RETURNING *`,
      [
        body.id, body.name, body.description, body.kind, body.multiplier, body.accent,
        body.bannerId, body.startsAt, body.endsAt, body.active, req.auth!.sub,
      ],
    );

    bustCache();
    logger.info({ event: body.id, admin: req.auth!.sub }, 'live event saved');
    res.json({ event: toEvent(row!) });
  }),
);

eventAdminRouter.post(
  '/:id/stop',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const row = await one<Row>(
      'UPDATE live_events SET active = FALSE WHERE id = $1 RETURNING *',
      [req.params.id],
    );
    if (!row) throw notFound('Event not found');

    bustCache();
    logger.info({ event: req.params.id, admin: req.auth!.sub }, 'live event stopped');
    res.json({ event: toEvent(row) });
  }),
);
