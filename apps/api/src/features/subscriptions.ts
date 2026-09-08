import { Router } from 'express';
import { z } from 'zod';
import { one, query, transaction } from '../db/pool.js';
import { conflict, notFound, route } from '../lib/errors.js';
import { generalRateLimit, requireAuth, requireRole } from '../auth/middleware.js';
import { logger } from '../lib/logger.js';
import { moveCoins } from './economy.js';
import { grantEntitlement, moveGems, revokeEntitlement } from './entitlements.js';
import { awardCrate } from './crates.js';

/**
 * Subscriptions: renewal, cancellation and expiry.
 *
 * Three rules shape this:
 *
 *  1. **A subscription only renews when the provider says it did.** Nothing here
 *     extends a period on a timer — a renewal is a webhook or a receipt check,
 *     because the alternative is giving away membership to somebody whose card
 *     was declined.
 *  2. **Cancelling never takes away time already paid for.** It clears the
 *     renewal, and the entitlement runs to the end of the period.
 *  3. **Period perks are paid once per period.** `last_grant_for` marks the
 *     period already paid, so a webhook delivered twice — which every provider
 *     does eventually — cannot pay twice.
 */
export const subscriptionRouter = Router();
export const subscriptionAdminRouter = Router();

export type SubscriptionStatus = 'active' | 'past_due' | 'cancelled' | 'expired';

interface SubscriptionRow {
  id: string;
  user_id: string;
  product_id: string;
  provider: string;
  provider_sub: string | null;
  status: SubscriptionStatus;
  current_start: string;
  current_end: string;
  cancel_at_end: boolean;
  last_grant_for: string | null;
  name: string;
  period_days: number | null;
  grants: {
    coins?: number;
    gems?: number;
    crates?: string[];
    entitlement?: { kind: 'ad_free' | 'pass_premium' | 'subscription' | 'vip'; days?: number | null };
  };
}

function toSubscription(row: SubscriptionRow) {
  return {
    id: row.id,
    productId: row.product_id,
    name: row.name,
    provider: row.provider,
    status: row.status,
    currentStart: row.current_start,
    currentEnd: row.current_end,
    cancelAtEnd: row.cancel_at_end,
    periodDays: row.period_days,
    /** Live means the entitlement is currently in force. */
    active: row.status === 'active' && new Date(row.current_end).getTime() > Date.now(),
  };
}

const SELECT = `
  SELECT s.*, sp.name, sp.period_days, sp.grants
    FROM subscriptions s
    JOIN store_products sp ON sp.id = s.product_id
`;

/* -------------------------------- player API ------------------------------ */

subscriptionRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    const rows = await query<SubscriptionRow>(
      `${SELECT} WHERE s.user_id = $1 ORDER BY s.created_at DESC`,
      [req.auth!.sub],
    );
    res.json({
      subscriptions: rows.map(toSubscription),
      notice:
        'A membership renews through the app store that sold it. Cancelling keeps every day ' +
        'already paid for.',
    });
  }),
);

/**
 * Cancel at the end of the period.
 *
 * Deliberately not an immediate revoke: the player paid for this period and
 * keeps it. Only the automatic renewal stops.
 */
subscriptionRouter.post(
  '/:id/cancel',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);

    const row = await one<SubscriptionRow>(
      `UPDATE subscriptions SET cancel_at_end = TRUE, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'active'
        RETURNING *, (SELECT name FROM store_products WHERE id = product_id) AS name,
                  (SELECT period_days FROM store_products WHERE id = product_id) AS period_days,
                  (SELECT grants FROM store_products WHERE id = product_id) AS grants`,
      [id, req.auth!.sub],
    );
    if (!row) throw notFound('No active membership with that id');

    logger.info({ subscription: id, user: req.auth!.sub }, 'subscription set to cancel at period end');

    res.json({
      ok: true,
      subscription: toSubscription(row),
      message: `Your membership stays active until ${new Date(row.current_end).toDateString()}.`,
    });
  }),
);

/** Undo a pending cancellation, while the period is still running. */
subscriptionRouter.post(
  '/:id/resume',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);

    const row = await one<SubscriptionRow>(
      `UPDATE subscriptions SET cancel_at_end = FALSE, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND status = 'active' AND current_end > now()
        RETURNING *, (SELECT name FROM store_products WHERE id = product_id) AS name,
                  (SELECT period_days FROM store_products WHERE id = product_id) AS period_days,
                  (SELECT grants FROM store_products WHERE id = product_id) AS grants`,
      [id, req.auth!.sub],
    );
    if (!row) throw conflict('That membership cannot be resumed', 'not_resumable');

    res.json({ ok: true, subscription: toSubscription(row) });
  }),
);

/* ------------------------------ period perks ------------------------------ */

/**
 * Pay the perks for the current period, once.
 *
 * `last_grant_for` is set to the period start inside the same statement that
 * checks it, so two calls racing — a webhook and the sweep, say — cannot both
 * pay. The row that comes back is the one that won.
 */
export async function grantPeriodPerks(subscriptionId: string): Promise<boolean> {
  const row = await one<SubscriptionRow>(
    `UPDATE subscriptions s
        SET last_grant_for = s.current_start, updated_at = now()
      WHERE s.id = $1
        AND s.status = 'active'
        AND s.current_end > now()
        AND (s.last_grant_for IS NULL OR s.last_grant_for < s.current_start)
      RETURNING s.*,
                (SELECT name FROM store_products WHERE id = s.product_id) AS name,
                (SELECT period_days FROM store_products WHERE id = s.product_id) AS period_days,
                (SELECT grants FROM store_products WHERE id = s.product_id) AS grants`,
    [subscriptionId],
  );
  if (!row) return false;

  const grants = row.grants ?? {};

  await transaction(async (client) => {
    if (grants.coins) {
      await moveCoins(client, {
        userId: row.user_id,
        delta: grants.coins,
        reason: 'shop',
        note: `${row.name} · period perks`,
      });
    }
    if (grants.gems) {
      await moveGems(client, {
        userId: row.user_id,
        delta: grants.gems,
        reason: 'purchase',
        note: `${row.name} · period perks`,
      });
    }
    for (const tierId of grants.crates ?? []) {
      await awardCrate(client, row.user_id, tierId, 0, null, 'mission');
    }
    if (grants.entitlement) {
      await grantEntitlement(client, {
        userId: row.user_id,
        kind: grants.entitlement.kind,
        source: 'subscription',
        days: row.period_days ?? grants.entitlement.days ?? 30,
        note: `${row.name} · renewal`,
      });
    }
  });

  logger.info({ subscription: subscriptionId, user: row.user_id }, 'subscription perks granted');
  return true;
}

/* -------------------------------- renewal --------------------------------- */

export interface RenewalNotice {
  provider: 'stripe' | 'apple' | 'google' | 'sandbox';
  /** The provider's subscription identifier. */
  providerSub: string;
  /** What the provider says happened. */
  event: 'renewed' | 'cancelled' | 'expired' | 'past_due';
  /** New period end, for a renewal. */
  periodEnd?: string;
}

/**
 * Apply what a payment provider told us about a subscription.
 *
 * This is the single entry point for every provider's webhook, so the state
 * machine lives in one place rather than three. It is deliberately keyed on the
 * provider's own identifier: we never take the client's word for which
 * subscription changed.
 */
export async function applyRenewalNotice(notice: RenewalNotice): Promise<'applied' | 'unknown'> {
  const subscription = await one<{ id: string; user_id: string; current_end: string }>(
    'SELECT id, user_id, current_end FROM subscriptions WHERE provider = $1 AND provider_sub = $2',
    [notice.provider, notice.providerSub],
  );
  if (!subscription) return 'unknown';

  switch (notice.event) {
    case 'renewed': {
      const end = notice.periodEnd ?? new Date(Date.now() + 30 * 86_400_000).toISOString();

      // A renewal that does not actually move the period forward is not a
      // renewal — it is the same webhook arriving twice, which every provider
      // does. The guard is in the WHERE clause so two of them racing cannot
      // both win, and the minute of tolerance absorbs a duplicate whose end
      // date we computed ourselves a moment later.
      const advanced = await one<{ id: string }>(
        `UPDATE subscriptions
            SET status = 'active', current_start = now(), current_end = $2, updated_at = now()
          WHERE id = $1
            AND $2::timestamptz > current_end + INTERVAL '1 minute'
          RETURNING id`,
        [subscription.id, end],
      );

      if (!advanced) {
        logger.info(
          { subscription: subscription.id, provider: notice.provider },
          'duplicate renewal notice ignored',
        );
        break;
      }

      // A genuinely new period means a new set of perks — and last_grant_for
      // now lags current_start, so exactly one grant happens.
      await grantPeriodPerks(subscription.id);
      break;
    }

    case 'past_due':
      await query(
        `UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE id = $1`,
        [subscription.id],
      );
      break;

    case 'cancelled':
      // Cancelled at the provider still means the paid period runs out.
      await query(
        `UPDATE subscriptions SET cancel_at_end = TRUE, updated_at = now() WHERE id = $1`,
        [subscription.id],
      );
      break;

    case 'expired':
      await query(
        `UPDATE subscriptions SET status = 'expired', updated_at = now() WHERE id = $1`,
        [subscription.id],
      );
      await revokeEntitlement(subscription.user_id, 'subscription', null, 'subscription expired');
      break;
  }

  logger.info(
    { subscription: subscription.id, event: notice.event, provider: notice.provider },
    'subscription notice applied',
  );
  return 'applied';
}

/**
 * Retire subscriptions whose period has run out.
 *
 * This is not a renewal — it never extends anything. It only closes the ones the
 * provider has stopped paying for, so a lapsed membership stops granting ad-free
 * instead of running forever because no webhook arrived.
 */
export async function expireLapsedSubscriptions(): Promise<number> {
  const lapsed = await query<{ id: string; user_id: string }>(
    `UPDATE subscriptions
        SET status = 'expired', updated_at = now()
      WHERE status IN ('active', 'past_due')
        AND current_end <= now()
        AND (cancel_at_end = TRUE OR current_end <= now() - INTERVAL '3 days')
      RETURNING id, user_id`,
  );

  for (const row of lapsed) {
    await revokeEntitlement(row.user_id, 'subscription', null, 'period ended').catch(() => undefined);
  }

  if (lapsed.length > 0) {
    logger.info({ count: lapsed.length }, 'lapsed subscriptions retired');
  }
  return lapsed.length;
}

/*
 * The three-day grace above is deliberate. Providers are late with renewal
 * webhooks all the time, and cutting somebody off at the exact second their
 * period ends turns a provider's slow queue into a support ticket. A member who
 * actually cancelled has `cancel_at_end` set and is retired immediately.
 */

/* --------------------------------- admin ---------------------------------- */

subscriptionAdminRouter.get(
  '/',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const params = z
      .object({
        status: z.enum(['active', 'past_due', 'cancelled', 'expired']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);

    const rows = await query<SubscriptionRow & { username: string }>(
      `${SELECT}
        JOIN users u ON u.id = s.user_id
       WHERE ($1::text IS NULL OR s.status = $1)
       ORDER BY s.created_at DESC
       LIMIT $2`,
      [params.status ?? null, params.limit],
    );

    const totals = await one<{ active: string; past_due: string; cancelling: string; expired: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'active')::text                        AS active,
         COUNT(*) FILTER (WHERE status = 'past_due')::text                      AS past_due,
         COUNT(*) FILTER (WHERE status = 'active' AND cancel_at_end)::text      AS cancelling,
         COUNT(*) FILTER (WHERE status = 'expired')::text                       AS expired
       FROM subscriptions`,
    );

    res.json({
      subscriptions: rows.map((row) => ({ ...toSubscription(row), username: row.username })),
      totals: {
        active: Number(totals?.active ?? 0),
        pastDue: Number(totals?.past_due ?? 0),
        cancelling: Number(totals?.cancelling ?? 0),
        expired: Number(totals?.expired ?? 0),
      },
    });
  }),
);

/**
 * Apply a provider notice by hand.
 *
 * Used for reconciliation when a webhook was missed, and by the tests. It takes
 * the provider's identifier rather than ours, exactly like the real webhook, so
 * the same code path is exercised.
 */
subscriptionAdminRouter.post(
  '/notice',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        provider: z.enum(['stripe', 'apple', 'google', 'sandbox']),
        providerSub: z.string().min(1).max(200),
        event: z.enum(['renewed', 'cancelled', 'expired', 'past_due']),
        periodEnd: z.string().datetime().optional(),
      })
      .parse(req.body);

    const outcome = await applyRenewalNotice(body);
    if (outcome === 'unknown') throw notFound('No subscription with that provider id');

    res.json({ ok: true });
  }),
);

subscriptionAdminRouter.post(
  '/expire-lapsed',
  requireAuth,
  requireRole('admin'),
  route(async (_req, res) => {
    res.json({ expired: await expireLapsedSubscriptions() });
  }),
);
