import {
  APPLE_ENABLED, APPLE_SHARED_SECRET, GOOGLE_PLAY_ACCESS_TOKEN, GOOGLE_PLAY_ENABLED,
  GOOGLE_PLAY_PACKAGE, IS_PROD, SANDBOX_PAYMENTS, STRIPE_ENABLED, STRIPE_SECRET_KEY,
} from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Receipt verification.
 *
 * The rule this file exists to enforce: **a purchase is only real when the
 * payment provider says so**. The client sends a receipt; it never sends a
 * price, a product entitlement, or a "success" flag we act on. Every verifier
 * below returns what the *provider* reported, and the caller then checks that
 * against the product row in our own database.
 *
 * A provider with no credentials configured returns `configured: false` and the
 * purchase fails closed. That is deliberate: a misconfigured production deploy
 * must refuse to sell rather than give things away.
 */
export type Provider = 'stripe' | 'apple' | 'google' | 'sandbox';

export interface VerificationResult {
  ok: boolean;
  /** Whether this provider has credentials at all. */
  configured: boolean;
  /** The provider's own transaction id, used to make grants idempotent. */
  transactionId: string | null;
  /** The product identifier the provider says was bought. */
  productSku: string | null;
  /** Amount in the smallest currency unit, when the provider reports one. */
  amountMinor: number | null;
  currency: string | null;
  /** For subscriptions: when the current period ends. */
  expiresAt: string | null;
  /** Whether the provider says this was already refunded or cancelled. */
  refunded: boolean;
  reason?: string;
  /** Raw response, stored for dispute resolution. Never returned to a client. */
  raw: Record<string, unknown>;
}

function failed(reason: string, configured = true): VerificationResult {
  return {
    ok: false,
    configured,
    transactionId: null,
    productSku: null,
    amountMinor: null,
    currency: null,
    expiresAt: null,
    refunded: false,
    reason,
    raw: {},
  };
}

export interface VerifyInput {
  provider: Provider;
  /** Platform receipt, Stripe session id, or Play purchase token. */
  receipt: string;
  /** Play needs the product id alongside the token; others ignore it. */
  sku?: string | null;
}

export async function verifyReceipt(input: VerifyInput): Promise<VerificationResult> {
  switch (input.provider) {
    case 'stripe':
      return verifyStripe(input.receipt);
    case 'apple':
      return verifyApple(input.receipt);
    case 'google':
      return verifyGoogle(input.receipt, input.sku ?? null);
    case 'sandbox':
      return verifySandbox(input.receipt);
    default:
      return failed('Unknown payment provider');
  }
}

/* --------------------------------- Stripe --------------------------------- */

/**
 * Stripe Checkout: we look the session up ourselves rather than believing the
 * redirect the browser came back with, because that redirect is trivially
 * forged.
 */
async function verifyStripe(sessionId: string): Promise<VerificationResult> {
  if (!STRIPE_ENABLED) return failed('Stripe is not configured', false);

  try {
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { authorization: `Bearer ${STRIPE_SECRET_KEY}` } },
    );
    const body = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      return { ...failed(String((body as { error?: { message?: string } }).error?.message ?? 'Stripe rejected the session')), raw: body };
    }

    const paid = body.payment_status === 'paid';
    const amount = typeof body.amount_total === 'number' ? body.amount_total : null;
    const metadata = (body.metadata ?? {}) as Record<string, string>;

    return {
      ok: paid,
      configured: true,
      transactionId: typeof body.payment_intent === 'string' ? body.payment_intent : sessionId,
      productSku: metadata.productId ?? null,
      amountMinor: amount,
      currency: typeof body.currency === 'string' ? body.currency.toUpperCase() : null,
      expiresAt: null,
      refunded: false,
      reason: paid ? undefined : `Stripe payment_status is ${String(body.payment_status)}`,
      raw: body,
    };
  } catch (err) {
    logger.error({ err }, 'stripe verification failed');
    return failed('Could not reach Stripe');
  }
}

/* --------------------------------- Apple ---------------------------------- */

async function verifyApple(receipt: string): Promise<VerificationResult> {
  if (!APPLE_ENABLED) return failed('App Store purchases are not configured', false);

  const call = (url: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        'receipt-data': receipt,
        password: APPLE_SHARED_SECRET,
        'exclude-old-transactions': true,
      }),
    }).then((r) => r.json() as Promise<Record<string, unknown>>);

  try {
    // Apple's documented flow: try production, and only on status 21007 (a
    // sandbox receipt sent to production) retry against sandbox.
    let body = await call('https://buy.itunes.apple.com/verifyReceipt');
    if (body.status === 21_007) {
      body = await call('https://sandbox.itunes.apple.com/verifyReceipt');
    }

    if (body.status !== 0) {
      return { ...failed(`App Store status ${String(body.status)}`), raw: body };
    }

    const info = (body.latest_receipt_info ?? []) as Array<Record<string, string>>;
    const latest = info[info.length - 1];
    if (!latest) return { ...failed('Receipt contained no transactions'), raw: body };

    const expiresMs = latest.expires_date_ms ? Number(latest.expires_date_ms) : null;

    return {
      ok: true,
      configured: true,
      transactionId: latest.transaction_id ?? null,
      productSku: latest.product_id ?? null,
      // Apple does not return a price in the receipt; the product row is the
      // source of truth for what it cost.
      amountMinor: null,
      currency: null,
      expiresAt: expiresMs ? new Date(expiresMs).toISOString() : null,
      refunded: Boolean(latest.cancellation_date_ms),
      raw: body,
    };
  } catch (err) {
    logger.error({ err }, 'apple verification failed');
    return failed('Could not reach the App Store');
  }
}

/* --------------------------------- Google --------------------------------- */

async function verifyGoogle(token: string, sku: string | null): Promise<VerificationResult> {
  if (!GOOGLE_PLAY_ENABLED) return failed('Play purchases are not configured', false);
  if (!sku) return failed('Play verification needs the product id');

  try {
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(GOOGLE_PLAY_PACKAGE)}/purchases/products/` +
      `${encodeURIComponent(sku)}/tokens/${encodeURIComponent(token)}`;

    const res = await fetch(url, {
      headers: { authorization: `Bearer ${GOOGLE_PLAY_ACCESS_TOKEN}` },
    });
    const body = (await res.json()) as Record<string, unknown>;

    if (!res.ok) {
      return { ...failed('Play rejected the purchase token'), raw: body };
    }

    // purchaseState: 0 purchased, 1 cancelled, 2 pending.
    const state = Number(body.purchaseState ?? 1);
    const priceMicros = body.priceAmountMicros ? Number(body.priceAmountMicros) : null;

    return {
      ok: state === 0,
      configured: true,
      transactionId: typeof body.orderId === 'string' ? body.orderId : token,
      productSku: sku,
      amountMinor: priceMicros === null ? null : Math.round(priceMicros / 10_000),
      currency: typeof body.priceCurrencyCode === 'string' ? body.priceCurrencyCode : null,
      expiresAt: null,
      refunded: state === 1,
      reason: state === 0 ? undefined : `Play purchaseState ${state}`,
      raw: body,
    };
  } catch (err) {
    logger.error({ err }, 'google play verification failed');
    return failed('Could not reach Google Play');
  }
}

/* --------------------------------- sandbox -------------------------------- */

/**
 * Development and tests only.
 *
 * Accepts a receipt of the form `sandbox:<transaction id>` and treats it as
 * paid. It is hard-disabled in production by {@link SANDBOX_PAYMENTS}, so no
 * configuration mistake can turn a real deployment into a free shop.
 */
async function verifySandbox(receipt: string): Promise<VerificationResult> {
  if (IS_PROD || !SANDBOX_PAYMENTS) {
    return failed('Sandbox payments are disabled', false);
  }
  if (!receipt.startsWith('sandbox:') || receipt.length < 12) {
    return failed('Sandbox receipts must look like sandbox:<id>');
  }

  return {
    ok: true,
    configured: true,
    transactionId: receipt.slice('sandbox:'.length),
    productSku: null,
    amountMinor: null,
    currency: null,
    expiresAt: null,
    refunded: false,
    raw: { sandbox: true, receipt },
  };
}

/** Which providers this deployment can actually take money through. */
export function availableProviders(): Provider[] {
  const list: Provider[] = [];
  if (STRIPE_ENABLED) list.push('stripe');
  if (APPLE_ENABLED) list.push('apple');
  if (GOOGLE_PLAY_ENABLED) list.push('google');
  if (SANDBOX_PAYMENTS) list.push('sandbox');
  return list;
}
