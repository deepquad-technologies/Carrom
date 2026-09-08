/**
 * The subscription lifecycle, end to end.
 *
 * Buy, renew, cancel, resume, expire. This was the piece the documentation
 * listed as unwired: subscriptions were created and granted an entitlement, but
 * nothing processed a renewal or a cancellation, so a membership either ran
 * forever or stopped for no visible reason.
 *
 * Run with the API up:  npx tsx test/e2e-subscriptions.ts
 */
import pg from 'pg';

const API = process.env.API_URL ?? 'http://localhost:4000';
const DB = process.env.DATABASE_URL ?? 'postgres://carrom:carrom@localhost:5432/carrom';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call<T = any>(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  return { ok: res.ok, status: res.status, data: data as T };
}

interface Session {
  user: { id: string; username: string };
  profile: { coins: number };
  tokens: { accessToken: string; refreshToken: string };
}

let seq = 0;

async function register(tag: string): Promise<Session> {
  for (let attempt = 0; attempt < 10; attempt++) {
    seq += 1;
    const username = `${tag}${Date.now().toString().slice(-6)}${seq}`;
    const res = await call<Session>('POST', '/auth/register', {
      email: `${username}@example.test`,
      password: 'SubTestPassword123!',
      username,
    });
    if (res.ok) return res.data;
    if ((res.data as any)?.code !== 'rate_limited') {
      throw new Error(`register failed: ${JSON.stringify(res.data)}`);
    }
    await sleep(12_000);
  }
  throw new Error('register kept hitting the rate limit');
}

const db = new pg.Client({ connectionString: DB });

async function main(): Promise<void> {
  await db.connect();

  const member = await register('subm');
  const token = member.tokens.accessToken;

  const staff = await register('subadm');
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [staff.user.id]);
  const promoted = await call<{ tokens: { accessToken: string } }>('POST', '/auth/refresh', {
    refreshToken: staff.tokens.refreshToken,
  });
  const adminToken = promoted.data.tokens.accessToken;

  /* ---------------------------------- buy --------------------------------- */

  section('Buying a membership');

  const store = await call('GET', '/store', undefined, token);
  const plan = store.data.products.find((p: any) => p.kind === 'subscription');
  check('a subscription is on sale', Boolean(plan), store.data.products.map((p: any) => p.kind));
  if (!plan) throw new Error('no subscription product');

  const none = await call('GET', '/subscriptions', undefined, token);
  check('a new account has no membership', none.data.subscriptions.length === 0, none.data);

  const checkout = await call(
    'POST',
    '/store/checkout',
    { productId: plan.id, platform: 'web' },
    token,
  );
  const confirmed = await call(
    'POST',
    '/store/confirm',
    { purchaseId: checkout.data.purchaseId, receipt: `sandbox:${checkout.data.purchaseId}` },
    token,
  );
  check('the purchase is granted', confirmed.data.status === 'granted', confirmed.data);

  const mine = await call('GET', '/subscriptions', undefined, token);
  check('the membership appears', mine.data.subscriptions.length === 1, mine.data.subscriptions);

  const sub = mine.data.subscriptions[0];
  check('it is active', sub.active === true, sub);
  check('it is not set to cancel', sub.cancelAtEnd === false, sub);
  check('it runs for the product period', sub.periodDays === 30, sub.periodDays);

  const policy = await call('GET', '/ads/policy', undefined, token);
  check('a member sees no ads', policy.data.adFree === true, policy.data);

  // The provider id has to be recorded, or no renewal can ever find it.
  const stored = await db.query<{ provider: string; provider_sub: string | null }>(
    'SELECT provider, provider_sub FROM subscriptions WHERE user_id = $1',
    [member.user.id],
  );
  check(
    'the provider identifier was recorded',
    Boolean(stored.rows[0]?.provider_sub),
    stored.rows[0],
  );

  const providerSub = stored.rows[0]!.provider_sub!;
  const provider = stored.rows[0]!.provider;

  /* -------------------------------- renewal ------------------------------- */

  section('Renewal');

  const coinsBefore = (await call('GET', '/profile/me', undefined, token)).data.profile.coins;

  // A real renewal extends the period from where it currently ends, not from
  // now — the provider charged for another month on top of the one in progress.
  const currentEnd = new Date(sub.currentEnd).getTime();
  const nextEnd = new Date(currentEnd + 30 * 86_400_000).toISOString();

  const renewed = await call(
    'POST',
    '/admin/subscriptions/notice',
    { provider, providerSub, event: 'renewed', periodEnd: nextEnd },
    adminToken,
  );
  check('a renewal notice is accepted', renewed.ok, renewed.data);

  const coinsAfter = (await call('GET', '/profile/me', undefined, token)).data.profile.coins;
  check(
    'the renewal paid the period perks',
    coinsAfter > coinsBefore,
    { coinsBefore, coinsAfter },
  );

  // A provider that delivers the same webhook twice — which they all do — must
  // not pay twice.
  await call(
    'POST',
    '/admin/subscriptions/notice',
    { provider, providerSub, event: 'renewed', periodEnd: nextEnd },
    adminToken,
  );
  const coinsAfterReplay = (await call('GET', '/profile/me', undefined, token)).data.profile.coins;
  check(
    'a replayed renewal pays nothing extra',
    coinsAfterReplay === coinsAfter,
    { coinsAfter, coinsAfterReplay },
  );

  // And a notice that does not move the period forward is not a renewal.
  const stale = await call(
    'POST',
    '/admin/subscriptions/notice',
    { provider, providerSub, event: 'renewed', periodEnd: sub.currentEnd },
    adminToken,
  );
  const coinsAfterStale = (await call('GET', '/profile/me', undefined, token)).data.profile.coins;
  check('a backdated renewal pays nothing', stale.ok && coinsAfterStale === coinsAfter, {
    coinsAfter,
    coinsAfterStale,
  });

  const unknown = await call(
    'POST',
    '/admin/subscriptions/notice',
    { provider, providerSub: 'not-a-real-subscription', event: 'renewed' },
    adminToken,
  );
  check('a notice for an unknown subscription is refused', !unknown.ok, unknown.status);

  /* ------------------------------ cancellation ---------------------------- */

  section('Cancellation');

  const cancelled = await call('POST', `/subscriptions/${sub.id}/cancel`, {}, token);
  check('a member can cancel', cancelled.ok, cancelled.data);
  check('it is marked to cancel at the end', cancelled.data.subscription.cancelAtEnd === true, cancelled.data);
  check('but it is still active', cancelled.data.subscription.active === true, cancelled.data);

  const stillAdFree = await call('GET', '/ads/policy', undefined, token);
  check('cancelling does not take away paid time', stillAdFree.data.adFree === true, stillAdFree.data);

  const resumed = await call('POST', `/subscriptions/${sub.id}/resume`, {}, token);
  check('a cancellation can be undone', resumed.ok, resumed.data);
  check('renewal is back on', resumed.data.subscription.cancelAtEnd === false, resumed.data);

  const notMine = await call('POST', `/subscriptions/${sub.id}/cancel`, {}, adminToken);
  check("somebody else's membership cannot be cancelled", !notMine.ok, notMine.status);

  /* --------------------------------- expiry ------------------------------- */

  section('Expiry');

  // Cancel, then wind the period back so the sweep has something to retire.
  await call('POST', `/subscriptions/${sub.id}/cancel`, {}, token);
  await db.query(
    "UPDATE subscriptions SET current_end = now() - INTERVAL '1 hour' WHERE id = $1",
    [sub.id],
  );

  const swept = await call('POST', '/admin/subscriptions/expire-lapsed', {}, adminToken);
  check('the lapse sweep runs', swept.ok, swept.data);
  check('it retired the lapsed membership', swept.data.expired >= 1, swept.data);

  const afterExpiry = await call('GET', '/subscriptions', undefined, token);
  check(
    'the membership reads as expired',
    afterExpiry.data.subscriptions[0]?.status === 'expired',
    afterExpiry.data.subscriptions[0],
  );

  const adsBack = await call('GET', '/ads/policy', undefined, token);
  check('ads come back when it lapses', adsBack.data.adFree === false, adsBack.data);

  /* --------------------------- grace for late webhooks -------------------- */

  section('Grace for a late provider');

  const grace = await register('subgrace');
  const graceCheckout = await call(
    'POST',
    '/store/checkout',
    { productId: plan.id, platform: 'web' },
    grace.tokens.accessToken,
  );
  await call(
    'POST',
    '/store/confirm',
    { purchaseId: graceCheckout.data.purchaseId, receipt: `sandbox:${graceCheckout.data.purchaseId}` },
    grace.tokens.accessToken,
  );

  // Period just ended, no cancellation, no webhook yet. Providers are late all
  // the time; cutting somebody off at the exact second is a support ticket.
  await db.query(
    "UPDATE subscriptions SET current_end = now() - INTERVAL '1 hour' WHERE user_id = $1",
    [grace.user.id],
  );
  await call('POST', '/admin/subscriptions/expire-lapsed', {}, adminToken);

  const inGrace = await call('GET', '/ads/policy', undefined, grace.tokens.accessToken);
  check('a slightly late renewal keeps the member covered', inGrace.data.adFree === true, inGrace.data);

  // Four days late is not late any more.
  await db.query(
    "UPDATE subscriptions SET current_end = now() - INTERVAL '4 days' WHERE user_id = $1",
    [grace.user.id],
  );
  await call('POST', '/admin/subscriptions/expire-lapsed', {}, adminToken);

  const pastGrace = await call('GET', '/ads/policy', undefined, grace.tokens.accessToken);
  check('but a long-lapsed membership is retired', pastGrace.data.adFree === false, pastGrace.data);

  /* --------------------------------- admin -------------------------------- */

  section('Admin view');

  const listed = await call('GET', '/admin/subscriptions?limit=20', undefined, adminToken);
  check('admin can list subscriptions', listed.ok, listed.status);
  check('totals are reported', typeof listed.data.totals?.active === 'number', listed.data.totals);

  const asPlayer = await call('GET', '/admin/subscriptions', undefined, token);
  check('a player cannot list subscriptions', !asPlayer.ok, asPlayer.status);

  /* ------------------------------ ledger audit ---------------------------- */

  section('Ledger integrity');

  const audit = await call('GET', '/admin/economy/audit', undefined, adminToken);
  check('the coin ledger balances', audit.data.ok === true, audit.data.mismatches?.slice(0, 3));

  const gemAudit = await call('GET', '/admin/monetization/gem-audit', undefined, adminToken);
  check('the gem ledger balances', gemAudit.data.ok === true, gemAudit.data.mismatches?.slice(0, 3));

  await db.end();

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nrun failed:', err);
  await db.end().catch(() => undefined);
  process.exit(1);
});
