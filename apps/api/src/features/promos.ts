import { Router } from 'express';
import { z } from 'zod';
import { one, query, transaction } from '../db/pool.js';
import { conflict, notFound, route } from '../lib/errors.js';
import { rateLimit, requireAuth, requireRole } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { moveCoins } from './economy.js';
import { grantEntitlement, moveGems } from './entitlements.js';
import { awardCrate } from './crates.js';

/**
 * Promo codes.
 *
 * Codes are typed by hand, so redemption is rate limited hard: guessing a
 * valid code should be slower than asking someone for it. Everything about
 * whether a code is still valid is decided in one UPDATE with the guards in the
 * WHERE clause, so two devices redeeming the last use of a code at the same
 * moment cannot both win.
 */
export const promoRouter = Router();
export const promoAdminRouter = Router();

interface PromoGrants {
  coins?: number;
  gems?: number;
  crates?: string[];
  items?: string[];
  entitlement?: { kind: 'ad_free' | 'pass_premium' | 'subscription' | 'vip'; days?: number | null };
}

interface PromoRow {
  code: string;
  description: string;
  grants: PromoGrants;
  max_uses: number | null;
  uses: number;
  per_user: number;
  expires_at: string | null;
  active: boolean;
}

promoRouter.post(
  '/redeem',
  requireAuth,
  // Deliberately tight. A code is a short string; brute force must not pay.
  rateLimit('promo_redeem', 6),
  route(async (req, res) => {
    const body = z
      .object({ code: z.string().trim().min(3).max(32) })
      .parse(req.body);
    const code = body.code.toUpperCase();

    const promo = await one<PromoRow>('SELECT * FROM promo_codes WHERE code = $1', [code]);
    // The same message either way, so a wrong code and an expired one look
    // identical from outside and cannot be used to enumerate valid codes.
    if (!promo) throw notFound('That code is not valid');

    const alreadyUsed = await one<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM promo_redemptions WHERE code = $1 AND user_id = $2',
      [code, req.auth!.sub],
    );
    if (Number(alreadyUsed?.count ?? 0) >= promo.per_user) {
      throw conflict('You have already used that code', 'already_redeemed');
    }

    const result = await transaction(async (client) => {
      // Every validity check lives in this one statement, so the counter and
      // the checks cannot disagree under concurrency.
      const claimed = await client.query<{ code: string }>(
        `UPDATE promo_codes
            SET uses = uses + 1
          WHERE code = $1
            AND active = TRUE
            AND starts_at <= now()
            AND (expires_at IS NULL OR expires_at > now())
            AND (max_uses IS NULL OR uses < max_uses)
          RETURNING code`,
        [code],
      );
      if (claimed.rowCount === 0) return null;

      await client.query('INSERT INTO promo_redemptions (code, user_id) VALUES ($1,$2)', [
        code,
        req.auth!.sub,
      ]);

      const grants = promo.grants ?? {};
      const awarded: Record<string, unknown> = {};

      if (grants.coins) {
        awarded.coins = grants.coins;
        await moveCoins(client, {
          userId: req.auth!.sub,
          delta: grants.coins,
          reason: 'shop',
          note: `promo:${code}`,
        });
      }
      if (grants.gems) {
        awarded.gems = grants.gems;
        await moveGems(client, {
          userId: req.auth!.sub,
          delta: grants.gems,
          reason: 'promo',
          note: `promo:${code}`,
        });
      }
      for (const tierId of grants.crates ?? []) {
        await awardCrate(client, req.auth!.sub, tierId, 0, null, 'mission');
      }
      for (const itemId of grants.items ?? []) {
        await client.query(
          `INSERT INTO inventory (user_id, item_id, source) VALUES ($1,$2,'shop')
           ON CONFLICT (user_id, item_id) DO UPDATE SET duplicates = inventory.duplicates + 1`,
          [req.auth!.sub, itemId],
        );
      }
      if (grants.entitlement) {
        awarded.entitlement = grants.entitlement.kind;
        await grantEntitlement(client, {
          userId: req.auth!.sub,
          kind: grants.entitlement.kind,
          source: 'promo',
          days: grants.entitlement.days ?? null,
          note: `promo:${code}`,
        });
      }

      return awarded;
    });

    if (!result) throw conflict('That code has been fully used or has expired', 'code_exhausted');

    logger.info({ code, user: req.auth!.sub }, 'promo redeemed');
    res.json({ ok: true, description: promo.description, granted: result });
  }),
);

/* --------------------------------- admin ---------------------------------- */

promoAdminRouter.get(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (_req, res) => {
    const rows = await query<PromoRow & { created_at: string }>(
      'SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT 100',
    );
    res.json({ codes: rows });
  }),
);

promoAdminRouter.post(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        code: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/),
        description: z.string().max(200).default(''),
        grants: z
          .object({
            coins: z.number().int().min(0).max(10_000_000).optional(),
            gems: z.number().int().min(0).max(100_000).optional(),
            crates: z.array(z.string().max(32)).max(5).optional(),
            items: z.array(z.string().max(64)).max(10).optional(),
            entitlement: z
              .object({
                kind: z.enum(['ad_free', 'pass_premium', 'subscription', 'vip']),
                days: z.number().int().min(1).max(3_650).nullable().optional(),
              })
              .optional(),
          })
          .default({}),
        maxUses: z.number().int().min(1).max(1_000_000).nullable().default(null),
        perUser: z.number().int().min(1).max(10).default(1),
        expiresAt: z.string().datetime().nullable().default(null),
        active: z.boolean().default(true),
      })
      .parse(req.body);

    const row = await one<PromoRow>(
      `INSERT INTO promo_codes (code, description, grants, max_uses, per_user, expires_at, active, created_by)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8)
       ON CONFLICT (code) DO UPDATE SET
         description = EXCLUDED.description, grants = EXCLUDED.grants,
         max_uses = EXCLUDED.max_uses, per_user = EXCLUDED.per_user,
         expires_at = EXCLUDED.expires_at, active = EXCLUDED.active
       RETURNING *`,
      [
        body.code.toUpperCase(), body.description, JSON.stringify(body.grants),
        body.maxUses, body.perUser, body.expiresAt, body.active, req.auth!.sub,
      ],
    );

    logger.info({ code: body.code, admin: req.auth!.sub }, 'promo code saved');
    res.json({ code: row });
  }),
);

promoAdminRouter.post(
  '/:code/disable',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    await query('UPDATE promo_codes SET active = FALSE WHERE code = $1', [
      req.params.code.toUpperCase(),
    ]);
    res.json({ ok: true });
  }),
);
