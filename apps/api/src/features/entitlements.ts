import type { PoolClient } from 'pg';
import { one, query, transaction } from '../db/pool.js';
import { conflict } from '../lib/errors.js';

/**
 * Gems and entitlements.
 *
 * Gems are the premium currency: bought with money, spent on cosmetics and
 * conveniences. Like coins, every movement is written to an append-only ledger
 * in the same transaction as the balance change, so the two can never drift.
 * Also like coins, there is no path back out to money.
 *
 * Entitlements answer "may this account do X right now" — ad-free, premium
 * pass, an active subscription. Everything that grants one writes a row here
 * rather than flipping a private flag, so a support agent can see where a
 * benefit came from and revoking it is one operation instead of five.
 */

/* ---------------------------------- gems ---------------------------------- */

export type GemReason =
  | 'purchase'
  | 'spend'
  | 'refund'
  | 'promo'
  | 'pass_reward'
  | 'gift'
  | 'admin_grant'
  | 'admin_revoke'
  | 'rewarded_ad';

export interface GemMovement {
  userId: string;
  delta: number;
  reason: GemReason;
  purchaseId?: string | null;
  note?: string;
}

export async function moveGems(client: PoolClient, m: GemMovement): Promise<number> {
  const result = await client.query<{ gems: string }>(
    `UPDATE profiles SET gems = gems + $2
      WHERE user_id = $1 AND gems + $2 >= 0
      RETURNING gems`,
    [m.userId, m.delta],
  );

  if (result.rowCount === 0) {
    throw conflict('Not enough gems for that', 'insufficient_gems');
  }
  const balance = Number(result.rows[0]!.gems);

  await client.query(
    `INSERT INTO gem_ledger (user_id, delta, balance, reason, purchase_id, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [m.userId, m.delta, balance, m.reason, m.purchaseId ?? null, m.note ?? null],
  );

  return balance;
}

export function moveGemsStandalone(m: GemMovement): Promise<number> {
  return transaction((client) => moveGems(client, m));
}

export async function gemBalance(userId: string): Promise<number> {
  const row = await one<{ gems: string }>('SELECT gems FROM profiles WHERE user_id = $1', [userId]);
  return row ? Number(row.gems) : 0;
}

/* ------------------------------ entitlements ------------------------------ */

export type EntitlementKind = 'ad_free' | 'pass_premium' | 'subscription' | 'vip';
export type EntitlementSource = 'purchase' | 'promo' | 'admin' | 'subscription' | 'gift';

export interface Entitlement {
  id: string;
  kind: EntitlementKind;
  scope: string | null;
  source: EntitlementSource;
  grantedAt: string;
  expiresAt: string | null;
}

interface EntitlementRow {
  id: string;
  kind: EntitlementKind;
  scope: string | null;
  source: EntitlementSource;
  granted_at: string;
  expires_at: string | null;
}

/**
 * Grant an entitlement.
 *
 * Granting the same kind and scope twice extends rather than duplicating, so a
 * player who buys two months of ad-free gets two months, not two rows that both
 * expire in one.
 */
export async function grantEntitlement(
  client: PoolClient,
  input: {
    userId: string;
    kind: EntitlementKind;
    scope?: string | null;
    source: EntitlementSource;
    purchaseId?: string | null;
    days?: number | null;
    note?: string;
  },
): Promise<void> {
  const scope = input.scope ?? null;

  if (input.days == null) {
    // Permanent. If they already have a permanent one, there is nothing to do.
    const existing = await client.query(
      `SELECT id FROM entitlements
        WHERE user_id = $1 AND kind = $2 AND scope IS NOT DISTINCT FROM $3
          AND revoked_at IS NULL AND expires_at IS NULL`,
      [input.userId, input.kind, scope],
    );
    if (existing.rowCount && existing.rowCount > 0) return;
  } else {
    // Extend an unexpired one rather than stacking rows.
    const extended = await client.query(
      `UPDATE entitlements
          SET expires_at = GREATEST(expires_at, now()) + ($4 || ' days')::interval
        WHERE user_id = $1 AND kind = $2 AND scope IS NOT DISTINCT FROM $3
          AND revoked_at IS NULL AND expires_at IS NOT NULL AND expires_at > now()
        RETURNING id`,
      [input.userId, input.kind, scope, String(input.days)],
    );
    if (extended.rowCount && extended.rowCount > 0) return;
  }

  await client.query(
    `INSERT INTO entitlements (user_id, kind, scope, source, purchase_id, expires_at, note)
     VALUES ($1,$2,$3,$4,$5,
             CASE WHEN $6::text IS NULL THEN NULL ELSE now() + ($6 || ' days')::interval END,
             $7)`,
    [
      input.userId,
      input.kind,
      scope,
      input.source,
      input.purchaseId ?? null,
      input.days == null ? null : String(input.days),
      input.note ?? null,
    ],
  );
}

export async function revokeEntitlement(
  userId: string,
  kind: EntitlementKind,
  scope: string | null = null,
  note = 'revoked',
): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE entitlements SET revoked_at = now(), note = COALESCE(note || ' | ', '') || $4
      WHERE user_id = $1 AND kind = $2 AND scope IS NOT DISTINCT FROM $3 AND revoked_at IS NULL
      RETURNING id`,
    [userId, kind, scope, note],
  );
  return rows.length;
}

/** Every live entitlement for an account. */
export async function entitlementsFor(userId: string): Promise<Entitlement[]> {
  const rows = await query<EntitlementRow>(
    `SELECT id, kind, scope, source, granted_at, expires_at
       FROM entitlements
      WHERE user_id = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY granted_at DESC`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    source: row.source,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
  }));
}

export async function hasEntitlement(
  userId: string,
  kind: EntitlementKind,
  scope: string | null = null,
): Promise<boolean> {
  const row = await one<{ id: string }>(
    `SELECT id FROM entitlements
      WHERE user_id = $1 AND kind = $2
        AND ($3::text IS NULL OR scope = $3)
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1`,
    [userId, kind, scope],
  );
  return Boolean(row);
}

/**
 * Whether ads should be suppressed for this account.
 *
 * A subscription implies ad-free, so this checks both rather than requiring
 * every subscription grant to remember to also write an ad_free row.
 */
export async function isAdFree(userId: string): Promise<boolean> {
  const row = await one<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM entitlements
        WHERE user_id = $1 AND kind IN ('ad_free','subscription','vip')
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
     ) AS ok`,
    [userId],
  );
  return Boolean(row?.ok);
}
