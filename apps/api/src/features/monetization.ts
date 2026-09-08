import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool.js';
import { route } from '../lib/errors.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { STORE_CURRENCY } from '../lib/env.js';

/**
 * Monetization reporting.
 *
 * Revenue, conversion, and where it comes from. Two deliberate choices:
 *
 *  * Money is reported in minor units throughout and only formatted at the very
 *    edge, so no rounding creeps into a total.
 *  * Refunds are subtracted rather than hidden. A dashboard that only shows
 *    gross revenue tells you what you sold, not what you kept.
 */
export const monetizationRouter = Router();

monetizationRouter.get(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const params = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
      .parse(req.query);
    const days = String(params.days);

    const totals = await one<{
      gross: string; refunded: string; orders: string; payers: string;
      players: string; failed: string;
    }>(
      `SELECT
         COALESCE((SELECT SUM(price_minor) FROM purchases
                    WHERE status = 'granted' AND provider <> 'admin'
                      AND created_at > now() - ($1 || ' days')::interval), 0)::text AS gross,
         COALESCE((SELECT SUM(amount_minor) FROM refunds
                    WHERE created_at > now() - ($1 || ' days')::interval), 0)::text AS refunded,
         (SELECT COUNT(*) FROM purchases
           WHERE status = 'granted' AND created_at > now() - ($1 || ' days')::interval)::text AS orders,
         (SELECT COUNT(DISTINCT user_id) FROM purchases
           WHERE status = 'granted' AND provider <> 'admin'
             AND created_at > now() - ($1 || ' days')::interval)::text AS payers,
         (SELECT COUNT(*) FROM users u WHERE NOT EXISTS (
            SELECT 1 FROM bans b WHERE b.user_id = u.id AND b.scope = 'account'
              AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > now())
          ))::text AS players,
         (SELECT COUNT(*) FROM purchases
           WHERE status = 'failed' AND created_at > now() - ($1 || ' days')::interval)::text AS failed`,
      [days],
    );

    const gross = Number(totals?.gross ?? 0);
    const refunded = Number(totals?.refunded ?? 0);
    const orders = Number(totals?.orders ?? 0);
    const payers = Number(totals?.payers ?? 0);
    const players = Number(totals?.players ?? 0);

    const daily = await query<{ day: string; gross: string; orders: string }>(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              COALESCE(SUM(price_minor), 0)::text AS gross,
              COUNT(*)::text                      AS orders
         FROM purchases
        WHERE status = 'granted' AND provider <> 'admin'
          AND created_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY 1`,
      [days],
    );

    const byProduct = await query<{
      product_id: string; name: string; kind: string; orders: string; gross: string;
    }>(
      `SELECT pu.product_id, sp.name, sp.kind,
              COUNT(*)::text                       AS orders,
              COALESCE(SUM(pu.price_minor),0)::text AS gross
         FROM purchases pu
         JOIN store_products sp ON sp.id = pu.product_id
        WHERE pu.status = 'granted' AND pu.provider <> 'admin'
          AND pu.created_at > now() - ($1 || ' days')::interval
        GROUP BY pu.product_id, sp.name, sp.kind
        ORDER BY SUM(pu.price_minor) DESC
        LIMIT 25`,
      [days],
    );

    const byProvider = await query<{ provider: string; orders: string; gross: string }>(
      `SELECT provider, COUNT(*)::text AS orders, COALESCE(SUM(price_minor),0)::text AS gross
         FROM purchases
        WHERE status = 'granted' AND created_at > now() - ($1 || ' days')::interval
        GROUP BY provider ORDER BY SUM(price_minor) DESC`,
      [days],
    );

    const entitlements = await query<{ kind: string; live: string }>(
      `SELECT kind, COUNT(*)::text AS live FROM entitlements
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
        GROUP BY kind ORDER BY COUNT(*) DESC`,
    );

    const subscriptions = await one<{ active: string; cancelling: string }>(
      `SELECT
         (SELECT COUNT(*) FROM subscriptions WHERE status = 'active')::text        AS active,
         (SELECT COUNT(*) FROM subscriptions
           WHERE status = 'active' AND cancel_at_end)::text                        AS cancelling`,
    );

    const ads = await one<{ impressions: string; clicks: string; rewarded: string; revenue: string }>(
      `SELECT
         (SELECT COUNT(*) FROM ad_impressions
           WHERE shown_at > now() - ($1 || ' days')::interval)::text                AS impressions,
         (SELECT COUNT(*) FROM ad_impressions
           WHERE clicked AND shown_at > now() - ($1 || ' days')::interval)::text    AS clicks,
         (SELECT COUNT(*) FROM ad_impressions
           WHERE rewarded AND shown_at > now() - ($1 || ' days')::interval)::text   AS rewarded,
         COALESCE((SELECT SUM(spent_minor) FROM ad_campaigns), 0)::text             AS revenue`,
      [days],
    );

    const failures = await query<{ reason: string; count: string }>(
      `SELECT COALESCE(failure_reason, 'unknown') AS reason, COUNT(*)::text AS count
         FROM purchases
        WHERE status = 'failed' AND created_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 10`,
      [days],
    );

    res.json({
      days: params.days,
      currency: STORE_CURRENCY,
      totals: {
        grossMinor: gross,
        refundedMinor: refunded,
        netMinor: gross - refunded,
        orders,
        payers,
        players,
        failed: Number(totals?.failed ?? 0),
        // The two numbers a monetization review always asks for.
        conversion: players > 0 ? payers / players : 0,
        arppuMinor: payers > 0 ? Math.round((gross - refunded) / payers) : 0,
      },
      daily: daily.map((row) => ({
        day: row.day,
        grossMinor: Number(row.gross),
        orders: Number(row.orders),
      })),
      byProduct: byProduct.map((row) => ({
        productId: row.product_id,
        name: row.name,
        kind: row.kind,
        orders: Number(row.orders),
        grossMinor: Number(row.gross),
      })),
      byProvider: byProvider.map((row) => ({
        provider: row.provider,
        orders: Number(row.orders),
        grossMinor: Number(row.gross),
      })),
      entitlements: entitlements.map((row) => ({ kind: row.kind, live: Number(row.live) })),
      subscriptions: {
        active: Number(subscriptions?.active ?? 0),
        cancelling: Number(subscriptions?.cancelling ?? 0),
      },
      ads: {
        impressions: Number(ads?.impressions ?? 0),
        clicks: Number(ads?.clicks ?? 0),
        rewarded: Number(ads?.rewarded ?? 0),
        revenueMinor: Number(ads?.revenue ?? 0),
      },
      failures: failures.map((row) => ({ reason: row.reason, count: Number(row.count) })),
    });
  }),
);

/** Recent orders, for support. */
monetizationRouter.get(
  '/purchases',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const params = z
      .object({
        status: z.enum(['pending', 'verifying', 'granted', 'failed', 'refunded', 'revoked']).optional(),
        userId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);

    const rows = await query(
      `SELECT pu.id, pu.user_id, u.username, pu.product_id, sp.name AS product_name,
              pu.status, pu.provider, pu.platform, pu.price_minor, pu.currency,
              pu.provider_txn, pu.failure_reason, pu.created_at, pu.granted_at
         FROM purchases pu
         JOIN users u ON u.id = pu.user_id
         LEFT JOIN store_products sp ON sp.id = pu.product_id
        WHERE ($1::text IS NULL OR pu.status = $1)
          AND ($2::uuid IS NULL OR pu.user_id = $2)
        ORDER BY pu.created_at DESC
        LIMIT $3`,
      [params.status ?? null, params.userId ?? null, params.limit],
    );

    res.json({ purchases: rows });
  }),
);

/**
 * Gem ledger integrity.
 *
 * The same check the coin audit does: every balance must equal the sum of its
 * ledger. A mismatch is a bug worth waking somebody for, so it is a first-class
 * endpoint rather than a query somebody has to remember.
 */
monetizationRouter.get(
  '/gem-audit',
  requireAuth,
  requireRole('admin'),
  route(async (_req, res) => {
    const drift = await query<{ user_id: string; username: string; balance: string; ledger: string }>(
      `SELECT p.user_id, u.username, p.gems::text AS balance,
              COALESCE(SUM(g.delta), 0)::text AS ledger
         FROM profiles p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN gem_ledger g ON g.user_id = p.user_id
        GROUP BY p.user_id, u.username, p.gems
       HAVING p.gems <> COALESCE(SUM(g.delta), 0)
        LIMIT 50`,
    );

    res.json({
      ok: drift.length === 0,
      mismatches: drift.map((row) => ({
        userId: row.user_id,
        username: row.username,
        balance: Number(row.balance),
        ledger: Number(row.ledger),
        difference: Number(row.balance) - Number(row.ledger),
      })),
    });
  }),
);
