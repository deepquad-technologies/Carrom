import { Router } from 'express';
import { z } from 'zod';
import { one, query, transaction } from '../db/pool.js';
import { conflict, notFound, route } from '../lib/errors.js';
import { generalRateLimit, rateLimit, requireAuth, requireRole } from '../auth/middleware.js';
import { ADS_ENABLED } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { moveCoins } from './economy.js';
import { isAdFree, moveGems } from './entitlements.js';

/**
 * Advertising.
 *
 * House-served, from campaigns an advertiser books with us. Three things shape
 * the design:
 *
 *  * **Ads are drawn, not downloaded.** A creative is a headline, a line of
 *    body text, a call to action and two colours. Nothing loads a third-party
 *    script, so no ad can track a player across the internet or slow the game
 *    down, and every ad matches the app's own look.
 *  * **Frequency is enforced on the server.** A client that asks ten times in a
 *    row gets one ad and nine refusals. The counter lives in the database, so
 *    clearing app data does not reset somebody's daily allowance.
 *  * **Targeting is coarse on purpose.** Country, platform and level band. No
 *    behavioural profile, no cross-app identity, nothing a player told us in
 *    confidence.
 *
 * Rewarded video pays out only after the server has seen the impression it is
 * paying for, and only once per impression.
 */
export const adRouter = Router();
export const adAdminRouter = Router();

export type Placement = 'banner' | 'interstitial' | 'rewarded' | 'sponsored';

/**
 * How often each placement may appear, per player per day, and the minimum gap.
 * Interstitials are the intrusive one, so they are the tightest.
 */
export const AD_LIMITS: Record<Placement, { perDay: number; minGapSeconds: number }> = {
  banner: { perDay: 200, minGapSeconds: 0 },
  interstitial: { perDay: 8, minGapSeconds: 180 },
  rewarded: { perDay: 12, minGapSeconds: 30 },
  sponsored: { perDay: 50, minGapSeconds: 0 },
};

/** What a completed rewarded view pays. Deliberately modest. */
export const REWARDED_PAYOUT = { coins: 500, gems: 0 };

interface CreativeRow {
  campaign_id: string;
  creative_id: string;
  headline: string;
  body: string;
  cta: string;
  click_url: string | null;
  accent: string;
  background: string;
  emblem: string;
  weight: number;
}

/* --------------------------------- serving -------------------------------- */

adRouter.get(
  '/next',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const params = z
      .object({
        placement: z.enum(['banner', 'interstitial', 'rewarded', 'sponsored']),
        platform: z.enum(['web', 'ios', 'android', 'unknown']).default('unknown'),
      })
      .parse(req.query);

    if (!ADS_ENABLED) {
      res.json({ ad: null, reason: 'ads_disabled' });
      return;
    }

    // Paying players never see an ad, whatever they ask for.
    if (await isAdFree(req.auth!.sub)) {
      res.json({ ad: null, reason: 'ad_free' });
      return;
    }

    const limit = AD_LIMITS[params.placement];
    const frequency = await one<{ shown: number; last_shown: string }>(
      `SELECT shown, last_shown FROM ad_frequency
        WHERE user_id = $1 AND placement = $2 AND day = CURRENT_DATE`,
      [req.auth!.sub, params.placement],
    );

    if (frequency) {
      if (frequency.shown >= limit.perDay) {
        res.json({ ad: null, reason: 'daily_cap', retryAfter: secondsUntilMidnight() });
        return;
      }
      const sinceLast = (Date.now() - new Date(frequency.last_shown).getTime()) / 1000;
      if (sinceLast < limit.minGapSeconds) {
        res.json({
          ad: null,
          reason: 'too_soon',
          retryAfter: Math.ceil(limit.minGapSeconds - sinceLast),
        });
        return;
      }
    }

    const profile = await one<{ level: number; country: string | null }>(
      'SELECT level, country FROM profiles WHERE user_id = $1',
      [req.auth!.sub],
    );

    const candidates = await query<CreativeRow>(
      `SELECT c.id AS campaign_id, cr.id AS creative_id, cr.headline, cr.body, cr.cta,
              cr.click_url, cr.accent, cr.background, cr.emblem, c.weight
         FROM ad_campaigns c
         JOIN ad_creatives cr ON cr.campaign_id = c.id AND cr.active = TRUE
        WHERE c.status = 'running'
          AND c.placement = $1
          AND c.starts_at <= now()
          AND (c.ends_at IS NULL OR c.ends_at > now())
          AND (c.budget_minor = 0 OR c.spent_minor < c.budget_minor)
          AND (c.target_countries IS NULL OR $2 = ANY(c.target_countries))
          AND (c.target_platforms IS NULL OR $3 = ANY(c.target_platforms))
          AND (c.min_level IS NULL OR $4 >= c.min_level)
          AND (c.max_level IS NULL OR $4 <= c.max_level)
          AND (
            SELECT COUNT(*) FROM ad_impressions i
             WHERE i.campaign_id = c.id AND i.user_id = $5
               AND i.shown_at > now() - INTERVAL '1 day'
          ) < c.daily_cap`,
      [
        params.placement,
        profile?.country ?? '',
        params.platform,
        profile?.level ?? 1,
        req.auth!.sub,
      ],
    );

    if (candidates.length === 0) {
      res.json({ ad: null, reason: 'no_fill' });
      return;
    }

    const chosen = weightedPick(candidates);

    // Record the impression before returning it. An ad we cannot account for is
    // an ad we cannot bill for, and a rewarded view we cannot verify.
    const impression = await transaction(async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO ad_impressions (campaign_id, creative_id, user_id, placement, platform, country)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          chosen.campaign_id,
          chosen.creative_id,
          req.auth!.sub,
          params.placement,
          params.platform,
          profile?.country ?? null,
        ],
      );

      await client.query(
        `INSERT INTO ad_frequency (user_id, placement, day, shown, last_shown)
         VALUES ($1,$2,CURRENT_DATE,1, now())
         ON CONFLICT (user_id, placement, day)
         DO UPDATE SET shown = ad_frequency.shown + 1, last_shown = now()`,
        [req.auth!.sub, params.placement],
      );

      // Charge the campaign per thousand impressions, rounded up in our favour
      // only at the campaign level, never per view.
      await client.query(
        `UPDATE ad_campaigns
            SET spent_minor = spent_minor + (cpm_minor / 1000.0)::bigint,
                status = CASE
                  WHEN budget_minor > 0 AND spent_minor + (cpm_minor / 1000.0)::bigint >= budget_minor
                  THEN 'finished' ELSE status END
          WHERE id = $1`,
        [chosen.campaign_id],
      );

      return inserted.rows[0]!.id;
    });

    res.json({
      ad: {
        impressionId: impression,
        placement: params.placement,
        headline: chosen.headline,
        body: chosen.body,
        cta: chosen.cta,
        clickUrl: chosen.click_url,
        accent: chosen.accent,
        background: chosen.background,
        emblem: chosen.emblem,
      },
      reward: params.placement === 'rewarded' ? REWARDED_PAYOUT : null,
    });
  }),
);

function weightedPick(rows: CreativeRow[]): CreativeRow {
  const total = rows.reduce((sum, row) => sum + Math.max(1, row.weight), 0);
  let roll = Math.random() * total;
  for (const row of rows) {
    roll -= Math.max(1, row.weight);
    if (roll <= 0) return row;
  }
  return rows[rows.length - 1]!;
}

function secondsUntilMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.ceil((midnight.getTime() - now.getTime()) / 1000);
}

/* -------------------------------- feedback -------------------------------- */

adRouter.post(
  '/click',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const body = z.object({ impressionId: z.coerce.number().int().positive() }).parse(req.body);
    await query(
      'UPDATE ad_impressions SET clicked = TRUE WHERE id = $1 AND user_id = $2',
      [body.impressionId, req.auth!.sub],
    );
    res.json({ ok: true });
  }),
);

/**
 * A rewarded video finished.
 *
 * The impression must exist, belong to this player, be a rewarded placement,
 * and not already have been paid. The `ad_rewards` primary key is the
 * impression id, so a replayed callback collides rather than paying twice.
 */
adRouter.post(
  '/complete',
  requireAuth,
  rateLimit('ad_complete', 20),
  route(async (req, res) => {
    const body = z.object({ impressionId: z.coerce.number().int().positive() }).parse(req.body);

    const impression = await one<{ id: string; placement: string; shown_at: string }>(
      `SELECT id, placement, shown_at FROM ad_impressions
        WHERE id = $1 AND user_id = $2`,
      [body.impressionId, req.auth!.sub],
    );
    if (!impression) throw notFound('No such ad view');
    if (impression.placement !== 'rewarded') {
      throw conflict('That placement does not pay a reward', 'not_rewarded');
    }

    // A rewarded video takes time. Anything faster than this did not play.
    const elapsed = (Date.now() - new Date(impression.shown_at).getTime()) / 1000;
    if (elapsed < 5) {
      throw conflict('That video did not finish', 'too_fast');
    }

    const payout = await transaction(async (client) => {
      const claim = await client.query(
        `INSERT INTO ad_rewards (impression_id, user_id, reward_kind, amount)
         VALUES ($1,$2,'coins',$3) ON CONFLICT DO NOTHING RETURNING impression_id`,
        [body.impressionId, req.auth!.sub, REWARDED_PAYOUT.coins],
      );
      if (claim.rowCount === 0) return null;

      await client.query(
        'UPDATE ad_impressions SET completed = TRUE, rewarded = TRUE WHERE id = $1',
        [body.impressionId],
      );

      const coins = await moveCoins(client, {
        userId: req.auth!.sub,
        delta: REWARDED_PAYOUT.coins,
        reason: 'bonus',
        note: `rewarded_ad:${body.impressionId}`,
      });

      let gems: number | null = null;
      if (REWARDED_PAYOUT.gems > 0) {
        gems = await moveGems(client, {
          userId: req.auth!.sub,
          delta: REWARDED_PAYOUT.gems,
          reason: 'rewarded_ad',
          note: `rewarded_ad:${body.impressionId}`,
        });
      }

      return { coins, gems };
    });

    if (!payout) {
      res.json({ ok: true, alreadyRewarded: true });
      return;
    }

    res.json({ ok: true, granted: REWARDED_PAYOUT, balance: payout.coins });
  }),
);

/** What the client needs to know before it decides whether to show anything. */
adRouter.get(
  '/policy',
  requireAuth,
  route(async (req, res) => {
    const adFree = await isAdFree(req.auth!.sub);
    const rows = await query<{ placement: string; shown: number }>(
      `SELECT placement, shown FROM ad_frequency
        WHERE user_id = $1 AND day = CURRENT_DATE`,
      [req.auth!.sub],
    );

    res.json({
      enabled: ADS_ENABLED && !adFree,
      adFree,
      limits: AD_LIMITS,
      shownToday: Object.fromEntries(rows.map((row) => [row.placement, row.shown])),
      rewardedPayout: REWARDED_PAYOUT,
    });
  }),
);

/* --------------------------- advertiser management ------------------------- */

adAdminRouter.get(
  '/advertisers',
  requireAuth,
  requireRole('admin'),
  route(async (_req, res) => {
    const rows = await query(
      `SELECT a.*,
              (SELECT COUNT(*) FROM ad_campaigns c WHERE c.advertiser_id = a.id)::text AS campaigns
         FROM advertisers a ORDER BY a.created_at DESC`,
    );
    res.json({ advertisers: rows });
  }),
);

adAdminRouter.post(
  '/advertisers',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        id: z.string().uuid().optional(),
        name: z.string().min(2).max(120),
        contactEmail: z.string().email().nullable().default(null),
        status: z.enum(['active', 'paused', 'banned']).default('active'),
        notes: z.string().max(1_000).nullable().default(null),
      })
      .parse(req.body);

    const row = body.id
      ? await one(
          `UPDATE advertisers SET name = $2, contact_email = $3, status = $4, notes = $5
            WHERE id = $1 RETURNING *`,
          [body.id, body.name, body.contactEmail, body.status, body.notes],
        )
      : await one(
          `INSERT INTO advertisers (name, contact_email, status, notes, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [body.name, body.contactEmail, body.status, body.notes, req.auth!.sub],
        );

    res.json({ advertiser: row });
  }),
);

adAdminRouter.get(
  '/campaigns',
  requireAuth,
  requireRole('admin'),
  route(async (_req, res) => {
    const rows = await query(
      `SELECT c.*, a.name AS advertiser_name,
              (SELECT COUNT(*) FROM ad_creatives cr WHERE cr.campaign_id = c.id)::text AS creatives,
              (SELECT COUNT(*) FROM ad_impressions i WHERE i.campaign_id = c.id)::text AS impressions,
              (SELECT COUNT(*) FROM ad_impressions i WHERE i.campaign_id = c.id AND i.clicked)::text AS clicks
         FROM ad_campaigns c
         JOIN advertisers a ON a.id = c.advertiser_id
        ORDER BY c.created_at DESC LIMIT 100`,
    );
    res.json({ campaigns: rows });
  }),
);

adAdminRouter.post(
  '/campaigns',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        id: z.string().uuid().optional(),
        advertiserId: z.string().uuid(),
        name: z.string().min(2).max(120),
        status: z.enum(['draft', 'running', 'paused', 'finished']).default('draft'),
        placement: z.enum(['banner', 'interstitial', 'rewarded', 'sponsored']),
        budgetMinor: z.number().int().min(0).max(1_000_000_000).default(0),
        cpmMinor: z.number().int().min(0).max(1_000_000).default(0),
        currency: z.string().length(3).default('INR'),
        targetCountries: z.array(z.string().length(2)).max(50).nullable().default(null),
        targetPlatforms: z.array(z.enum(['web', 'ios', 'android'])).max(3).nullable().default(null),
        minLevel: z.number().int().min(1).max(200).nullable().default(null),
        maxLevel: z.number().int().min(1).max(200).nullable().default(null),
        dailyCap: z.number().int().min(1).max(100).default(10),
        weight: z.number().int().min(1).max(1_000).default(100),
        startsAt: z.string().datetime().optional(),
        endsAt: z.string().datetime().nullable().default(null),
      })
      .parse(req.body);

    const values = [
      body.advertiserId, body.name, body.status, body.placement, body.budgetMinor,
      body.cpmMinor, body.currency.toUpperCase(),
      body.targetCountries?.map((c) => c.toUpperCase()) ?? null,
      body.targetPlatforms ?? null, body.minLevel, body.maxLevel,
      body.dailyCap, body.weight, body.startsAt ?? new Date().toISOString(), body.endsAt,
    ];

    const row = body.id
      ? await one(
          `UPDATE ad_campaigns SET advertiser_id=$2, name=$3, status=$4, placement=$5,
                  budget_minor=$6, cpm_minor=$7, currency=$8, target_countries=$9,
                  target_platforms=$10, min_level=$11, max_level=$12, daily_cap=$13,
                  weight=$14, starts_at=$15, ends_at=$16
            WHERE id=$1 RETURNING *`,
          [body.id, ...values],
        )
      : await one(
          `INSERT INTO ad_campaigns
             (advertiser_id, name, status, placement, budget_minor, cpm_minor, currency,
              target_countries, target_platforms, min_level, max_level, daily_cap, weight,
              starts_at, ends_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          values,
        );

    logger.info({ campaign: (row as { id: string }).id, admin: req.auth!.sub }, 'ad campaign saved');
    res.json({ campaign: row });
  }),
);

adAdminRouter.get(
  '/campaigns/:id/creatives',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const rows = await query('SELECT * FROM ad_creatives WHERE campaign_id = $1 ORDER BY created_at', [id]);
    res.json({ creatives: rows });
  }),
);

adAdminRouter.post(
  '/creatives',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const body = z
      .object({
        id: z.string().uuid().optional(),
        campaignId: z.string().uuid(),
        headline: z.string().min(2).max(80),
        body: z.string().max(160).default(''),
        cta: z.string().max(30).default('Learn more'),
        clickUrl: z.string().url().nullable().default(null),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f2c94c'),
        background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#12151f'),
        emblem: z.string().max(24).default('star'),
        active: z.boolean().default(true),
      })
      .parse(req.body);

    const row = body.id
      ? await one(
          `UPDATE ad_creatives SET headline=$2, body=$3, cta=$4, click_url=$5,
                  accent=$6, background=$7, emblem=$8, active=$9
            WHERE id=$1 RETURNING *`,
          [body.id, body.headline, body.body, body.cta, body.clickUrl, body.accent, body.background, body.emblem, body.active],
        )
      : await one(
          `INSERT INTO ad_creatives (campaign_id, headline, body, cta, click_url, accent, background, emblem, active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [body.campaignId, body.headline, body.body, body.cta, body.clickUrl, body.accent, body.background, body.emblem, body.active],
        );

    res.json({ creative: row });
  }),
);

/** Delivery and performance, per campaign. */
adAdminRouter.get(
  '/report',
  requireAuth,
  requireRole('admin'),
  route(async (req, res) => {
    const params = z
      .object({ days: z.coerce.number().int().min(1).max(90).default(7) })
      .parse(req.query);

    const rows = await query<{
      id: string; name: string; advertiser_name: string; placement: string;
      impressions: string; clicks: string; completions: string; reach: string;
      budget_minor: string; spent_minor: string; currency: string;
    }>(
      `SELECT c.id, c.name, a.name AS advertiser_name, c.placement,
              c.budget_minor::text, c.spent_minor::text, c.currency,
              COUNT(i.id)::text                                     AS impressions,
              COUNT(i.id) FILTER (WHERE i.clicked)::text            AS clicks,
              COUNT(i.id) FILTER (WHERE i.completed)::text          AS completions,
              COUNT(DISTINCT i.user_id)::text                       AS reach
         FROM ad_campaigns c
         JOIN advertisers a ON a.id = c.advertiser_id
         LEFT JOIN ad_impressions i
                ON i.campaign_id = c.id
               AND i.shown_at > now() - ($1 || ' days')::interval
        GROUP BY c.id, a.name
        ORDER BY COUNT(i.id) DESC
        LIMIT 100`,
      [String(params.days)],
    );

    const daily = await query<{ day: string; impressions: string; clicks: string }>(
      `SELECT to_char(date_trunc('day', shown_at), 'YYYY-MM-DD') AS day,
              COUNT(*)::text AS impressions,
              COUNT(*) FILTER (WHERE clicked)::text AS clicks
         FROM ad_impressions
        WHERE shown_at > now() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY 1`,
      [String(params.days)],
    );

    res.json({
      days: params.days,
      campaigns: rows.map((row) => {
        const impressions = Number(row.impressions);
        const clicks = Number(row.clicks);
        return {
          id: row.id,
          name: row.name,
          advertiser: row.advertiser_name,
          placement: row.placement,
          impressions,
          clicks,
          completions: Number(row.completions),
          reach: Number(row.reach),
          ctr: impressions > 0 ? clicks / impressions : 0,
          budgetMinor: Number(row.budget_minor),
          spentMinor: Number(row.spent_minor),
          currency: row.currency,
        };
      }),
      daily: daily.map((row) => ({
        day: row.day,
        impressions: Number(row.impressions),
        clicks: Number(row.clicks),
      })),
    });
  }),
);
