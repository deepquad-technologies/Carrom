import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { itemById } from '@carrom/content';
import { one, query, transaction } from '../db/pool.js';
import { badRequest, conflict, notFound, route } from '../lib/errors.js';
import { generalRateLimit, rateLimit, requireAuth, requireRole } from '../auth/middleware.js';
import { STORE_CURRENCY } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { moveCoins } from './economy.js';
import { grantEntitlement, moveGems, revokeEntitlement, gemBalance } from './entitlements.js';
import { availableProviders, verifyReceipt, type Provider } from './payments.js';
import { awardCrate } from './crates.js';

/**
 * The store.
 *
 * Two rules run through everything here:
 *
 *  1. **The client never confirms a purchase.** It asks to buy, then hands us a
 *     receipt. We verify that receipt with the payment provider, compare what
 *     the provider says was bought against our own product row, and only then
 *     grant anything.
 *  2. **Nothing sold gives a gameplay advantage.** Currency, cosmetics, crates
 *     and conveniences only. A player who spends nothing can win every match.
 *
 * There is no wagering, no cash-out, and no purchase whose contents are unknown
 * before paying — a crate bought here is always listed with its contents.
 */
export const storeRouter = Router();
export const storeAdminRouter = Router();

/* --------------------------------- types ---------------------------------- */

export type ProductKind =
  | 'coin_pack'
  | 'gem_pack'
  | 'pass'
  | 'subscription'
  | 'bundle'
  | 'ad_free'
  | 'cosmetic';

/** What a product hands over once payment is verified. */
export interface Grants {
  coins?: number;
  gems?: number;
  /** Crate kinds to award, e.g. ['champion','rookie']. */
  crates?: string[];
  /** Cosmetic item ids. */
  items?: string[];
  /** Entitlement to grant, with an optional duration. */
  entitlement?: { kind: 'ad_free' | 'pass_premium' | 'subscription' | 'vip'; days?: number | null; scope?: string | null };
}

interface ProductRow {
  id: string;
  kind: ProductKind;
  name: string;
  description: string;
  grants: Grants;
  price_minor: number;
  currency: string;
  compare_minor: number | null;
  sku_apple: string | null;
  sku_google: string | null;
  sku_stripe: string | null;
  period_days: number | null;
  sort_order: number;
  badge: string | null;
  max_per_user: number | null;
}

function toProduct(row: ProductRow, owned = 0) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    grants: row.grants,
    priceMinor: row.price_minor,
    compareMinor: row.compare_minor,
    currency: row.currency,
    badge: row.badge,
    periodDays: row.period_days,
    skus: { apple: row.sku_apple, google: row.sku_google, stripe: row.sku_stripe },
    maxPerUser: row.max_per_user,
    owned,
    soldOut: row.max_per_user !== null && owned >= row.max_per_user,
  };
}

/* -------------------------------- catalogue -------------------------------- */

storeRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    const rows = await query<ProductRow & { owned: string }>(
      `SELECT p.*,
              (SELECT COUNT(*) FROM purchases pu
                WHERE pu.user_id = $1 AND pu.product_id = p.id AND pu.status = 'granted')::text AS owned
         FROM store_products p
        WHERE p.active = TRUE
          AND (p.available_from IS NULL OR p.available_from <= now())
          AND (p.available_to IS NULL OR p.available_to > now())
        ORDER BY p.kind, p.sort_order, p.price_minor`,
      [req.auth!.sub],
    );

    const balances = await one<{ coins: string; gems: string }>(
      'SELECT coins::text, gems::text FROM profiles WHERE user_id = $1',
      [req.auth!.sub],
    );

    res.json({
      products: rows.map((row) => toProduct(row, Number(row.owned))),
      currency: STORE_CURRENCY,
      providers: availableProviders(),
      balances: { coins: Number(balances?.coins ?? 0), gems: Number(balances?.gems ?? 0) },
      notice:
        'Purchases buy virtual currency and cosmetics. They are not redeemable for money and ' +
        'never affect the outcome of a match.',
    });
  }),
);

/* ------------------------------ purchase flow ------------------------------ */

/**
 * Step one: record the intent.
 *
 * This creates a pending row and returns its id plus the platform SKU. It takes
 * no money and grants nothing. Its purpose is to have a record even if the
 * player's app dies mid-payment, so support can reconcile later.
 */
storeRouter.post(
  '/checkout',
  requireAuth,
  rateLimit('checkout', 20),
  route(async (req, res) => {
    const body = z
      .object({
        productId: z.string().max(64),
        platform: z.enum(['web', 'ios', 'android']),
      })
      .parse(req.body);

    const product = await one<ProductRow>(
      `SELECT * FROM store_products
        WHERE id = $1 AND active = TRUE
          AND (available_from IS NULL OR available_from <= now())
          AND (available_to IS NULL OR available_to > now())`,
      [body.productId],
    );
    if (!product) throw notFound('That product is not for sale');

    if (product.max_per_user !== null) {
      const owned = await one<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM purchases
          WHERE user_id = $1 AND product_id = $2 AND status = 'granted'`,
        [req.auth!.sub, product.id],
      );
      if (Number(owned?.count ?? 0) >= product.max_per_user) {
        throw conflict('You already own this', 'already_owned');
      }
    }

    const provider: Provider =
      body.platform === 'ios' ? 'apple' : body.platform === 'android' ? 'google' : 'stripe';

    const available = availableProviders();
    // Fall back to sandbox only when it is genuinely enabled — which is never
    // in production.
    const chosen: Provider = available.includes(provider)
      ? provider
      : available.includes('sandbox')
        ? 'sandbox'
        : provider;

    if (!available.includes(chosen)) {
      throw conflict('Purchases are not available right now', 'payments_unconfigured');
    }

    const purchase = await one<{ id: string }>(
      `INSERT INTO purchases (user_id, product_id, platform, provider, price_minor, currency)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.auth!.sub, product.id, body.platform, chosen, product.price_minor, product.currency],
    );

    res.json({
      purchaseId: purchase!.id,
      provider: chosen,
      sku:
        chosen === 'apple'
          ? product.sku_apple
          : chosen === 'google'
            ? product.sku_google
            : product.sku_stripe,
      priceMinor: product.price_minor,
      currency: product.currency,
    });
  }),
);

/**
 * Step two: verify and grant.
 *
 * Everything the client sends here is treated as a claim to be checked. The
 * price comes from our product row, not the request. The transaction id comes
 * from the provider, not the request. A duplicate transaction id is rejected by
 * a unique index rather than by a read-then-write that could race.
 */
storeRouter.post(
  '/confirm',
  requireAuth,
  rateLimit('purchase_confirm', 20),
  route(async (req, res) => {
    const body = z
      .object({
        purchaseId: z.string().uuid(),
        receipt: z.string().min(4).max(20_000),
      })
      .parse(req.body);

    const purchase = await one<{
      id: string;
      user_id: string;
      product_id: string;
      provider: Provider;
      status: string;
      price_minor: number;
      currency: string;
    }>('SELECT * FROM purchases WHERE id = $1 AND user_id = $2', [
      body.purchaseId,
      req.auth!.sub,
    ]);
    if (!purchase) throw notFound('No such purchase');

    if (purchase.status === 'granted') {
      // A retry after a lost response. Report success without granting twice.
      res.json({ status: 'granted', alreadyGranted: true });
      return;
    }
    if (purchase.status === 'refunded' || purchase.status === 'revoked') {
      throw conflict('That purchase has been refunded', 'refunded');
    }

    const product = await one<ProductRow>('SELECT * FROM store_products WHERE id = $1', [
      purchase.product_id,
    ]);
    if (!product) throw notFound('Product no longer exists');

    await query("UPDATE purchases SET status = 'verifying', updated_at = now() WHERE id = $1", [
      purchase.id,
    ]);

    const sku =
      purchase.provider === 'apple'
        ? product.sku_apple
        : purchase.provider === 'google'
          ? product.sku_google
          : product.sku_stripe;

    const verification = await verifyReceipt({
      provider: purchase.provider,
      receipt: body.receipt,
      sku,
    });

    const reject = async (reason: string) => {
      await query(
        `UPDATE purchases SET status = 'failed', failure_reason = $2,
                verification = $3::jsonb, receipt = $4, updated_at = now()
          WHERE id = $1`,
        [purchase.id, reason, JSON.stringify(verification.raw), body.receipt],
      );
      logger.warn({ purchase: purchase.id, reason }, 'purchase rejected');
      throw badRequest(reason);
    };

    if (!verification.configured) await reject('Payments are not configured for this platform');
    if (!verification.ok) await reject(verification.reason ?? 'The payment could not be verified');
    if (verification.refunded) await reject('That payment was refunded');

    // The provider must agree about which product this was, when it says.
    if (verification.productSku && sku && verification.productSku !== sku) {
      await reject('The receipt is for a different product');
    }

    // And about the price, when it reports one. A mismatch means either a
    // tampered client or a price change mid-flight; either way, stop.
    if (
      verification.amountMinor !== null &&
      Math.abs(verification.amountMinor - product.price_minor) > 1
    ) {
      await reject('The amount paid does not match the price of this item');
    }

    try {
      await transaction(async (client) => {
        // Claim the transaction id first. The unique index means a replay from
        // another device fails here rather than granting twice.
        const claimed = await client.query(
          `UPDATE purchases
              SET status = 'granted', provider_txn = $2, receipt = $3,
                  verification = $4::jsonb, granted_at = now(), updated_at = now()
            WHERE id = $1 AND status IN ('pending','verifying')
            RETURNING id`,
          [
            purchase.id,
            verification.transactionId,
            body.receipt,
            JSON.stringify(verification.raw),
          ],
        );
        if (claimed.rowCount === 0) throw conflict('That purchase was already settled', 'settled');

        await applyGrants(client, {
          userId: req.auth!.sub,
          purchaseId: purchase.id,
          product,
          expiresAt: verification.expiresAt,
          provider: purchase.provider,
          // The provider's transaction id is what renewal notices arrive keyed
          // on, so it becomes the subscription's identifier too.
          providerSub: verification.transactionId,
        });
      });
    } catch (err) {
      // A duplicate provider transaction is a replay, not an error worth
      // alarming the player about.
      if ((err as { code?: string }).code === '23505') {
        await query(
          `UPDATE purchases SET status = 'failed',
                  failure_reason = 'duplicate transaction', updated_at = now()
            WHERE id = $1`,
          [purchase.id],
        );
        throw conflict('That receipt has already been used', 'duplicate_receipt');
      }
      throw err;
    }

    logger.info(
      { purchase: purchase.id, product: product.id, user: req.auth!.sub },
      'purchase granted',
    );

    const balances = await one<{ coins: string; gems: string }>(
      'SELECT coins::text, gems::text FROM profiles WHERE user_id = $1',
      [req.auth!.sub],
    );

    res.json({
      status: 'granted',
      product: toProduct(product),
      balances: { coins: Number(balances?.coins ?? 0), gems: Number(balances?.gems ?? 0) },
    });
  }),
);

/**
 * Hand over what a product grants.
 *
 * Called inside the same transaction that marks the purchase granted, so a
 * failure anywhere rolls the whole thing back and the player can retry.
 */
export async function applyGrants(
  client: PoolClient,
  input: {
    userId: string;
    purchaseId: string | null;
    product: ProductRow;
    expiresAt?: string | null;
    /** Which provider settled this, and its own id for the subscription. */
    provider?: string;
    providerSub?: string | null;
  },
): Promise<void> {
  const grants = input.product.grants ?? {};

  if (grants.coins && grants.coins > 0) {
    await moveCoins(client, {
      userId: input.userId,
      delta: grants.coins,
      reason: 'shop',
      note: `store:${input.product.id}`,
    });
  }

  if (grants.gems && grants.gems > 0) {
    await moveGems(client, {
      userId: input.userId,
      delta: grants.gems,
      reason: 'purchase',
      purchaseId: input.purchaseId,
      note: `store:${input.product.id}`,
    });
  }

  for (const itemId of grants.items ?? []) {
    // Unknown ids are skipped rather than failing the purchase: a retired
    // cosmetic must not cost somebody their coins.
    if (!itemById(itemId)) {
      logger.warn({ itemId, product: input.product.id }, 'store grant referenced unknown item');
      continue;
    }
    await client.query(
      `INSERT INTO inventory (user_id, item_id, source)
       VALUES ($1, $2, 'shop')
       ON CONFLICT (user_id, item_id) DO UPDATE SET duplicates = inventory.duplicates + 1`,
      [input.userId, itemId],
    );
  }

  for (const tierId of grants.crates ?? []) {
    // A store crate has no match behind it, so the match id is null.
    await awardCrate(client, input.userId, tierId, 0, null, 'mission');
  }

  if (grants.entitlement) {
    const days =
      grants.entitlement.days ??
      (input.product.period_days ?? null);

    await grantEntitlement(client, {
      userId: input.userId,
      kind: grants.entitlement.kind,
      scope: grants.entitlement.scope ?? null,
      source: 'purchase',
      purchaseId: input.purchaseId,
      days,
      note: `store:${input.product.id}`,
    });

    // A subscription also gets a row of its own, so renewals have somewhere to
    // land and cancellation has something to cancel.
    if (input.product.kind === 'subscription') {
      const endsAt =
        input.expiresAt ??
        new Date(Date.now() + (input.product.period_days ?? 30) * 86_400_000).toISOString();

      // The provider's own subscription id is what every renewal notice is
      // keyed on, so it has to be recorded here or the subscription can never
      // be renewed, cancelled or expired.
      await client.query(
        `INSERT INTO subscriptions
           (user_id, product_id, provider, provider_sub, status, current_end, last_grant_for)
         VALUES ($1,$2,$3,$4,'active',$5, now())
         ON CONFLICT (provider, provider_sub) WHERE provider_sub IS NOT NULL
         DO UPDATE SET status = 'active', current_end = EXCLUDED.current_end,
                       cancel_at_end = FALSE, updated_at = now()`,
        [
          input.userId,
          input.product.id,
          input.provider ?? 'sandbox',
          input.providerSub ?? input.purchaseId,
          endsAt,
        ],
      );
    }
  }
}

/* -------------------------------- purchases -------------------------------- */

storeRouter.get(
  '/purchases',
  requireAuth,
  route(async (req, res) => {
    const rows = await query<{
      id: string; product_id: string; status: string; price_minor: number;
      currency: string; created_at: string; granted_at: string | null; name: string;
    }>(
      `SELECT pu.id, pu.product_id, pu.status, pu.price_minor, pu.currency,
              pu.created_at, pu.granted_at, sp.name
         FROM purchases pu
         JOIN store_products sp ON sp.id = pu.product_id
        WHERE pu.user_id = $1
        ORDER BY pu.created_at DESC
        LIMIT 50`,
      [req.auth!.sub],
    );
    res.json({ purchases: rows });
  }),
);

/**
 * Restore purchases.
 *
 * Re-applies the entitlements from every granted purchase. It deliberately does
 * not re-grant currency: coins already paid out have been spent, and paying
 * them again on every tap of "Restore" would be a duplication bug with a
 * button attached.
 */
storeRouter.post(
  '/restore',
  requireAuth,
  rateLimit('restore', 10),
  route(async (req, res) => {
    const rows = await query<ProductRow & { purchase_id: string; expires_at: string | null }>(
      `SELECT sp.*, pu.id AS purchase_id, NULL::timestamptz AS expires_at
         FROM purchases pu
         JOIN store_products sp ON sp.id = pu.product_id
        WHERE pu.user_id = $1 AND pu.status = 'granted'
          AND sp.grants ? 'entitlement'`,
      [req.auth!.sub],
    );

    let restored = 0;
    await transaction(async (client) => {
      for (const row of rows) {
        const entitlement = row.grants?.entitlement;
        if (!entitlement) continue;
        await grantEntitlement(client, {
          userId: req.auth!.sub,
          kind: entitlement.kind,
          scope: entitlement.scope ?? null,
          source: 'purchase',
          purchaseId: row.purchase_id,
          // Permanent entitlements restore as permanent; timed ones are not
          // extended again, they are simply left as they are.
          days: entitlement.days ?? null,
          note: 'restore',
        });
        restored += 1;
      }
    });

    res.json({ restored, message: restored > 0 ? 'Your purchases are back.' : 'Nothing to restore.' });
  }),
);

storeRouter.get(
  '/wallet',
  requireAuth,
  route(async (req, res) => {
    const row = await one<{ coins: string; gems: string }>(
      'SELECT coins::text, gems::text FROM profiles WHERE user_id = $1',
      [req.auth!.sub],
    );
    const ledger = await query<{ delta: string; reason: string; note: string | null; created_at: string }>(
      `SELECT delta::text, reason, note, created_at FROM gem_ledger
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 25`,
      [req.auth!.sub],
    );
    res.json({
      coins: Number(row?.coins ?? 0),
      gems: Number(row?.gems ?? 0),
      gemHistory: ledger.map((entry) => ({
        delta: Number(entry.delta),
        reason: entry.reason,
        note: entry.note,
        at: entry.created_at,
      })),
    });
  }),
);

/** Spend gems on something priced in gems. Used by the locker and crates. */
storeRouter.post(
  '/spend-gems',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const body = z
      .object({ amount: z.number().int().min(1).max(1_000_000), note: z.string().max(120) })
      .parse(req.body);

    const balance = await transaction((client) =>
      moveGems(client, {
        userId: req.auth!.sub,
        delta: -body.amount,
        reason: 'spend',
        note: body.note,
      }),
    );
    res.json({ gems: balance });
  }),
);

/* --------------------------------- admin ---------------------------------- */

const productInput = z.object({
  id: z.string().min(2).max(64).regex(/^[a-z0-9_.-]+$/),
  kind: z.enum(['coin_pack', 'gem_pack', 'pass', 'subscription', 'bundle', 'ad_free', 'cosmetic']),
  name: z.string().min(2).max(80),
  description: z.string().max(400).default(''),
  grants: z
    .object({
      coins: z.number().int().min(0).max(100_000_000).optional(),
      gems: z.number().int().min(0).max(1_000_000).optional(),
      crates: z.array(z.string().max(32)).max(10).optional(),
      items: z.array(z.string().max(64)).max(20).optional(),
      entitlement: z
        .object({
          kind: z.enum(['ad_free', 'pass_premium', 'subscription', 'vip']),
          days: z.number().int().min(1).max(3_650).nullable().optional(),
          scope: z.string().max(64).nullable().optional(),
        })
        .optional(),
    })
    .default({}),
  priceMinor: z.number().int().min(0).max(10_000_000),
  currency: z.string().length(3).default(STORE_CURRENCY),
  compareMinor: z.number().int().min(0).nullable().default(null),
  skuApple: z.string().max(120).nullable().default(null),
  skuGoogle: z.string().max(120).nullable().default(null),
  skuStripe: z.string().max(120).nullable().default(null),
  periodDays: z.number().int().min(1).max(3_650).nullable().default(null),
  sortOrder: z.number().int().min(0).max(10_000).default(100),
  badge: z.string().max(24).nullable().default(null),
  active: z.boolean().default(true),
  maxPerUser: z.number().int().min(1).max(1_000).nullable().default(null),
});

storeAdminRouter.get(
  '/products',
  requireAuth,
  requireRole('admin'),
  route(async (_req, res) => {
    const rows = await query<ProductRow>('SELECT * FROM store_products ORDER BY kind, sort_order');
    res.json({ products: rows.map((row) => toProduct(row)) });
  }),
);

storeAdminRouter.post(
  '/products',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = productInput.parse(req.body);

    if (body.compareMinor !== null && body.compareMinor <= body.priceMinor) {
      throw badRequest('The compare-at price must be higher than the price.');
    }

    const row = await one<ProductRow>(
      `INSERT INTO store_products
         (id, kind, name, description, grants, price_minor, currency, compare_minor,
          sku_apple, sku_google, sku_stripe, period_days, sort_order, badge, active, max_per_user)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO UPDATE SET
         kind = EXCLUDED.kind, name = EXCLUDED.name, description = EXCLUDED.description,
         grants = EXCLUDED.grants, price_minor = EXCLUDED.price_minor,
         currency = EXCLUDED.currency, compare_minor = EXCLUDED.compare_minor,
         sku_apple = EXCLUDED.sku_apple, sku_google = EXCLUDED.sku_google,
         sku_stripe = EXCLUDED.sku_stripe, period_days = EXCLUDED.period_days,
         sort_order = EXCLUDED.sort_order, badge = EXCLUDED.badge,
         active = EXCLUDED.active, max_per_user = EXCLUDED.max_per_user,
         updated_at = now()
       RETURNING *`,
      [
        body.id, body.kind, body.name, body.description, JSON.stringify(body.grants),
        body.priceMinor, body.currency.toUpperCase(), body.compareMinor,
        body.skuApple, body.skuGoogle, body.skuStripe, body.periodDays,
        body.sortOrder, body.badge, body.active, body.maxPerUser,
      ],
    );

    logger.info({ product: body.id, admin: req.auth!.sub }, 'store product saved');
    res.json({ product: toProduct(row!) });
  }),
);

/**
 * Refund a purchase.
 *
 * Clawing back is the default, but it is allowed to fail: a player who has
 * already spent the coins should not end up with a negative balance and a
 * broken account. In that case the refund is still recorded, with a note.
 */
storeAdminRouter.post(
  '/refund',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        purchaseId: z.string().uuid(),
        reason: z.string().min(3).max(200),
        clawBack: z.boolean().default(true),
      })
      .parse(req.body);

    const purchase = await one<{
      id: string; user_id: string; product_id: string; status: string;
      price_minor: number; currency: string;
    }>('SELECT * FROM purchases WHERE id = $1', [body.purchaseId]);
    if (!purchase) throw notFound('No such purchase');
    if (purchase.status !== 'granted') throw conflict('Only granted purchases can be refunded');

    const product = await one<ProductRow>('SELECT * FROM store_products WHERE id = $1', [
      purchase.product_id,
    ]);

    let clawedBack = false;
    await transaction(async (client) => {
      await client.query(
        "UPDATE purchases SET status = 'refunded', updated_at = now() WHERE id = $1",
        [purchase.id],
      );

      if (body.clawBack && product) {
        const grants = product.grants ?? {};
        try {
          if (grants.coins) {
            await moveCoins(client, {
              userId: purchase.user_id,
              delta: -grants.coins,
              reason: 'refund',
              note: `refund:${purchase.id}`,
            });
          }
          if (grants.gems) {
            await moveGems(client, {
              userId: purchase.user_id,
              delta: -grants.gems,
              reason: 'refund',
              purchaseId: purchase.id,
              note: `refund:${purchase.id}`,
            });
          }
          clawedBack = true;
        } catch {
          // Already spent. Record the refund anyway rather than failing it.
          clawedBack = false;
        }
      }

      if (product?.grants?.entitlement) {
        await client.query(
          `UPDATE entitlements SET revoked_at = now(), note = 'refunded'
            WHERE purchase_id = $1 AND revoked_at IS NULL`,
          [purchase.id],
        );
      }

      await client.query(
        `INSERT INTO refunds (purchase_id, user_id, amount_minor, currency, reason, clawed_back, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          purchase.id, purchase.user_id, purchase.price_minor, purchase.currency,
          body.reason, clawedBack, req.auth!.sub,
        ],
      );
    });

    logger.warn(
      { purchase: purchase.id, admin: req.auth!.sub, clawedBack },
      'purchase refunded',
    );
    res.json({ ok: true, clawedBack });
  }),
);

/** Grant a product to a player without payment: compensation, testing, a gift. */
storeAdminRouter.post(
  '/grant',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        userId: z.string().uuid(),
        productId: z.string().max(64),
        note: z.string().max(200).default('admin grant'),
      })
      .parse(req.body);

    const product = await one<ProductRow>('SELECT * FROM store_products WHERE id = $1', [
      body.productId,
    ]);
    if (!product) throw notFound('No such product');

    const purchaseId = await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO purchases
           (user_id, product_id, platform, provider, status, price_minor, currency, granted_at, failure_reason)
         VALUES ($1,$2,'admin','admin','granted',0,$3, now(), $4)
         RETURNING id`,
        [body.userId, product.id, product.currency, body.note],
      );
      const id = inserted.rows[0]!.id;
      await applyGrants(client, { userId: body.userId, purchaseId: id, product });
      return id;
    });

    logger.warn(
      { admin: req.auth!.sub, user: body.userId, product: product.id },
      'admin granted a store product',
    );
    res.json({ ok: true, purchaseId });
  }),
);

/** Remove an entitlement by hand, e.g. after a chargeback. */
storeAdminRouter.post(
  '/revoke-entitlement',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        userId: z.string().uuid(),
        kind: z.enum(['ad_free', 'pass_premium', 'subscription', 'vip']),
        scope: z.string().max(64).nullable().default(null),
        reason: z.string().max(200).default('admin'),
      })
      .parse(req.body);

    const revoked = await revokeEntitlement(body.userId, body.kind, body.scope, body.reason);
    logger.warn({ admin: req.auth!.sub, user: body.userId, kind: body.kind }, 'entitlement revoked');
    res.json({ revoked });
  }),
);

export { gemBalance };
