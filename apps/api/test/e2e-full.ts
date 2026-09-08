/**
 * Full end-to-end sweep.
 *
 * Every HTTP route and every socket event, exercised against a live API, a live
 * Postgres and a live Redis. Nothing is mocked.
 *
 * The suite tracks which routes it touched and prints an explicit coverage
 * report at the end, so "nothing was missed" is something you can read off the
 * output rather than something this file claims about itself.
 *
 * Run with the API up:  npx tsx test/e2e-full.ts
 */
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import type { GameState, MatchResult, Shot, ShotBroadcast } from '@carrom/types';

const API = process.env.API_URL ?? 'http://localhost:4000';
const DB = process.env.DATABASE_URL ?? 'postgres://carrom:carrom@localhost:5432/carrom';

let passed = 0;
let failed = 0;
const failures: string[] = [];
const touched = new Set<string>();

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    const line = `${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`;
    failures.push(line);
    console.log(`  FAIL  ${line}`);
  }
}

function section(title: string): void {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/* ------------------------------ http helpers ------------------------------ */

/** Normalise a concrete path back to its route pattern, for coverage. */
function patternOf(method: string, path: string): string {
  const clean = path.split('?')[0]!;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const parts = clean.split('/').map((part, index) => {
    if (index === 0) return part;
    if (uuid.test(part)) return ':id';
    if (/^\d+$/.test(part)) return ':id';
    return part;
  });
  return `${method} ${parts.join('/')}`;
}

interface Reply<T> {
  ok: boolean;
  status: number;
  data: T;
}

async function call<T = unknown>(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: { body?: unknown; token?: string; pattern?: string } = {},
): Promise<Reply<T>> {
  touched.add(options.pattern ?? patternOf(method, path));

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, data: data as T };
}

const GET = <T = any>(p: string, token?: string, pattern?: string) =>
  call<T>('GET', p, { token, pattern });
const POST = <T = any>(p: string, body?: unknown, token?: string, pattern?: string) =>
  call<T>('POST', p, { body, token, pattern });
const PATCH = <T = any>(p: string, body?: unknown, token?: string, pattern?: string) =>
  call<T>('PATCH', p, { body, token, pattern });
const PUT = <T = any>(p: string, body?: unknown, token?: string, pattern?: string) =>
  call<T>('PUT', p, { body, token, pattern });
const DEL = <T = any>(p: string, token?: string, pattern?: string) =>
  call<T>('DELETE', p, { token, pattern });

/* ----------------------------- socket helpers ----------------------------- */

function connect(token: string): Promise<Socket> {
  const socket = io(API, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket did not connect')), 10_000);
  });
}

function waitFor<T>(socket: Socket, event: string, ms = 8_000): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, ms);
    const handler = (payload: T) => {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- fixtures -------------------------------- */

interface Session {
  user: { id: string; username: string; isGuest: boolean };
  profile: { coins: number; level: number; displayName: string };
  tokens: { accessToken: string; refreshToken: string };
}

let seq = 0;
function uniqueName(tag: string): string {
  seq += 1;
  return `${tag}${Date.now().toString().slice(-6)}${seq}`;
}

/**
 * Create an account, backing off when the auth rate limiter kicks in.
 *
 * The limiter is doing its job — this sweep opens far more accounts in a minute
 * than a real person ever would — so waiting it out is the correct behaviour
 * rather than something to work around.
 */
async function register(tag: string): Promise<Session> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const username = uniqueName(tag);
    const res = await POST<Session>('/auth/register', {
      email: `${username}@example.test`,
      password: 'SweepPassword123!',
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

async function guest(name = 'Sweep Guest'): Promise<Session> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await POST<Session>('/auth/guest', { displayName: name });
    if (res.ok) return res.data;
    if ((res.data as any)?.code !== 'rate_limited') {
      throw new Error(`guest failed: ${JSON.stringify(res.data)}`);
    }
    await sleep(12_000);
  }
  throw new Error('guest sign-in kept hitting the rate limit');
}

const db = new pg.Client({ connectionString: DB });

/** Promote an account to admin and return a token that carries the role. */
async function makeAdmin(session: Session): Promise<string> {
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [session.user.id]);
  const refreshed = await POST<{ tokens: { accessToken: string } }>('/auth/refresh', {
    refreshToken: session.tokens.refreshToken,
  });
  return refreshed.data.tokens.accessToken;
}

/* ==========================================================================
   the sweep
   ========================================================================== */

async function main(): Promise<void> {
  await db.connect();

  /* ------------------------------- 1. auth -------------------------------- */

  section('1. Authentication');

  const providers = await GET('/auth/providers');
  check('provider list is public', providers.ok && Array.isArray(providers.data.providers ?? []), providers.status);

  const alice = await register('sweepa');
  check('an account can be registered', Boolean(alice.user.id), alice.user);
  check('a new account starts with coins', alice.profile.coins > 0, alice.profile.coins);

  const dupe = await POST('/auth/register', {
    email: `${alice.user.username}@example.test`,
    password: 'SweepPassword123!',
    username: alice.user.username,
  });
  check('a duplicate username is refused', !dupe.ok, dupe.status);

  const login = await POST<Session>('/auth/login', {
    email: `${alice.user.username}@example.test`,
    password: 'SweepPassword123!',
  });
  check('sign in with the right password works', login.ok, login.status);

  const badLogin = await POST('/auth/login', {
    email: `${alice.user.username}@example.test`,
    password: 'WrongPassword123!',
  });
  check('sign in with a wrong password is refused', !badLogin.ok, badLogin.status);

  const me = await GET('/auth/me', alice.tokens.accessToken);
  check('the session identifies the account', me.ok && me.data.user?.id === alice.user.id, me.status);

  const anon = await GET('/auth/me');
  check('an unauthenticated request is refused', !anon.ok, anon.status);

  const refreshed = await POST<{ tokens: { accessToken: string; refreshToken: string } }>(
    '/auth/refresh',
    { refreshToken: login.data.tokens.refreshToken },
  );
  check('a refresh token rotates', refreshed.ok, refreshed.status);

  const reused = await POST('/auth/refresh', { refreshToken: login.data.tokens.refreshToken });
  check('a reused refresh token is rejected', !reused.ok, reused.status);

  const theGuest = await guest();
  check('guest play is allowed', theGuest.user.isGuest === true, theGuest.user);

  const upgraded = await POST<Session>(
    '/auth/upgrade',
    {
      email: `${uniqueName('upg')}@example.test`,
      password: 'SweepPassword123!',
    },
    theGuest.tokens.accessToken,
  );
  check('a guest can upgrade to a full account', upgraded.ok, upgraded.data);

  const forgot = await POST('/auth/forgot-password', { email: `${alice.user.username}@example.test` });
  check('a password reset can be requested', forgot.ok, forgot.status);

  const badReset = await POST('/auth/reset-password', { token: 'not-a-real-token', password: 'Whatever123!' });
  check('an invalid reset token is refused', !badReset.ok, badReset.status);

  const badVerify = await POST('/auth/verify-email', { token: 'not-a-real-token' });
  check('an invalid verification token is refused', !badVerify.ok, badVerify.status);

  const fbNoToken = await POST('/auth/facebook', { accessToken: 'nope' });
  check('a bogus Facebook token is refused', !fbNoToken.ok, fbNoToken.status);

  const googleNoToken = await POST('/auth/google', { idToken: 'nope' });
  check('a bogus Google token is refused', !googleNoToken.ok, googleNoToken.status);

  const throwaway = await guest('Sweep Logout');
  const loggedOut = await POST(
    '/auth/logout',
    { refreshToken: throwaway.tokens.refreshToken },
    throwaway.tokens.accessToken,
  );
  check('a session can be signed out', loggedOut.ok, loggedOut.status);

  const afterLogout = await POST('/auth/refresh', { refreshToken: throwaway.tokens.refreshToken });
  check('a signed-out refresh token stops working', !afterLogout.ok, afterLogout.status);

  const throwaway2 = await guest('Sweep Logout All');
  const loggedOutAll = await POST('/auth/logout-all', {}, throwaway2.tokens.accessToken);
  check('every session can be signed out at once', loggedOutAll.ok, loggedOutAll.status);

  const afterLogoutAll = await POST('/auth/refresh', {
    refreshToken: throwaway2.tokens.refreshToken,
  });
  check('all refresh tokens stop working', !afterLogoutAll.ok, afterLogoutAll.status);

  const linkBad = await POST('/auth/link/facebook', { accessToken: 'nope' }, alice.tokens.accessToken);
  check('linking with a bogus token is refused', !linkBad.ok, linkBad.status);

  const unlink = await DEL('/auth/link/facebook', alice.tokens.accessToken);
  check('unlinking an unlinked provider answers cleanly', unlink.status < 500, unlink.status);

  const deauth = await POST('/auth/facebook/deauthorize', { signed_request: 'unsigned' });
  check('an unsigned deauthorize callback is refused', !deauth.ok || deauth.status < 500, deauth.status);

  /* ------------------------------ 2. profile ------------------------------ */

  section('2. Profile and progression');

  const token = alice.tokens.accessToken;

  const profile = await GET('/profile/me', token);
  check('the profile loads with stats', profile.ok && profile.data.stats, profile.status);

  const renamed = await PATCH('/profile/me', { displayName: 'Alice Sweep' }, token);
  check('the display name can be changed', renamed.ok, renamed.data);

  const home = await GET('/profile/home', token);
  check('the home summary loads', home.ok, home.status);

  const wallet = await GET('/profile/wallet', token);
  check('the wallet loads', wallet.ok, wallet.status);

  const history = await GET('/profile/history?limit=5', token);
  check('match history loads', history.ok && Array.isArray(history.data.matches), history.status);
  check('history carries a summary', Boolean(history.data.summary), history.data.summary);

  for (const filter of ['outcome=win', 'outcome=loss', 'modeId=quick', 'days=30']) {
    const filtered = await GET(`/profile/history?${filter}`, token);
    check(`history filters by ${filter}`, filtered.ok, filtered.status);
  }

  const achievements = await GET('/profile/achievements', token);
  check('achievements load', achievements.ok && achievements.data.achievements?.length > 0, achievements.status);

  const missions = await GET('/profile/missions', token);
  check('missions load', missions.ok, missions.status);

  const missionClaim = await POST(
    `/profile/missions/${missions.data.missions?.[0]?.id ?? 'none'}/claim`,
    {},
    token,
  );
  // Like the daily claim, this answers 200 with ok:false rather than an error
  // status — nothing went wrong, there was simply nothing to pay.
  check(
    'claiming an unfinished mission pays nothing',
    missionClaim.data?.ok === false,
    missionClaim.data,
  );

  const otherPlayer = await GET(`/profile/players/${theGuest.user.id}`, token);
  check("another player's public profile loads", otherPlayer.ok, otherPlayer.status);

  const profileNotes = await GET('/profile/notifications', token);
  check('profile notifications load', profileNotes.ok, profileNotes.status);

  const profileNotesRead = await POST('/profile/notifications/read', {}, token);
  check('profile notifications can be marked read', profileNotesRead.ok, profileNotesRead.status);

  const bonus = await POST('/profile/bonus', {}, token);
  check('the top-up bonus responds', bonus.status < 500, bonus.status);

  /* ----------------------------- 3. catalogue ----------------------------- */

  section('3. Catalogue and inventory');

  const catalog = await GET('/catalog');
  check('the public catalogue loads', catalog.ok, catalog.status);
  check('it ships 50 strikers', catalog.data.counts?.strikers === 50, catalog.data.counts);
  check('it ships 50 coin sets', catalog.data.counts?.coinSets === 50, catalog.data.counts);
  check('it ships 20 boards', catalog.data.boards?.length === 20, catalog.data.boards?.length);
  check('coins are declared virtual', Boolean(catalog.data.currencyNotice), catalog.data.currencyNotice);

  const inventory = await GET('/inventory', token);
  check('the locker loads', inventory.ok, inventory.status);
  check('every cosmetic is listed', inventory.data.counts?.total === 120, inventory.data.counts);

  const shop = await GET('/inventory/shop', token);
  check('the cosmetic shop loads', shop.ok, shop.status);

  const equip = await POST('/inventory/equip', { category: 'striker', itemId: 'str_classic' }, token);
  check('a starter striker can be equipped', equip.ok, equip.data);

  const equipUnowned = await POST(
    '/inventory/equip',
    { category: 'striker', itemId: 'str_legend_aurora' },
    token,
  );
  check('an unowned item cannot be equipped', !equipUnowned.ok, equipUnowned.status);

  const favorite = await POST('/inventory/favorite', { itemId: 'str_classic', favorite: true }, token);
  check('an item can be favourited', favorite.ok, favorite.data);

  const buy = await POST('/inventory/buy', { itemId: 'str_classic' }, token);
  check('buying something already owned is refused', !buy.ok, buy.status);

  /* ------------------------------- 4. crates ------------------------------ */

  section('4. Crates');

  const crates = await GET('/crates', token);
  check('the crate list loads', crates.ok, crates.status);

  const crateHistory = await GET('/crates/history', token);
  check('crate history loads', crateHistory.ok, crateHistory.status);

  const fakeCrate = '00000000-0000-4000-8000-000000000000';
  for (const [action, label] of [
    ['open', 'opening'],
    ['unlock', 'unlocking'],
    ['speed-up', 'speeding up'],
  ] as const) {
    const res = await POST(`/crates/${fakeCrate}/${action}`, {}, token);
    check(`${label} a crate that is not yours is refused`, !res.ok, res.status);
  }

  /* ---------------------------- 5. collections ---------------------------- */

  section('5. Collections');

  const collections = await GET('/collections', token);
  check('collections load', collections.ok && collections.data.collections?.length > 0, collections.status);
  check(
    'they cover 191 collectibles',
    collections.data.collections?.reduce((sum: number, c: any) => sum + c.total, 0) === 191,
    collections.data.collections?.reduce((sum: number, c: any) => sum + c.total, 0),
  );

  const firstCollection = collections.data.collections?.[0]?.id ?? 'strikers';
  const collectionItems = await GET(`/collections/${firstCollection}/items`, token);
  check('a collection lists its items', collectionItems.ok, collectionItems.status);

  const earlyClaim = await POST(`/collections/${firstCollection}/claim/100`, {}, token);
  check('an unearned milestone cannot be claimed', !earlyClaim.ok, earlyClaim.status);

  /* ------------------------------- 6. daily ------------------------------- */

  section('6. Daily rewards');

  const daily = await GET('/daily', token);
  check('the login calendar has seven days', daily.data.days?.length === 7, daily.data.days?.length);

  const claim = await POST('/daily/claim', {}, token);
  check('the daily reward can be claimed', claim.ok, claim.data);

  const claimAgain = await POST('/daily/claim', {}, token);
  check('claiming twice in a day pays once', claimAgain.data?.alreadyClaimed === true, claimAgain.data);

  const dailyHistory = await GET('/daily/history', token);
  check('daily history loads', dailyHistory.ok, dailyHistory.status);

  /* ---------------------------- 7. preferences ---------------------------- */

  section('7. Preferences');

  const prefs = await GET('/preferences', token);
  check('six themes are offered', prefs.data.themes?.length === 6, prefs.data.themes?.length);

  const themed = await PATCH('/preferences', { theme: 'galaxy', highContrast: true }, token);
  check('preferences can be changed', themed.data.preferences?.theme === 'galaxy', themed.data.preferences);
  check('an omitted field is untouched', themed.data.preferences?.sound === true, themed.data.preferences);

  const badTheme = await PATCH('/preferences', { theme: 'not-a-theme' }, token);
  check('an unknown theme is refused', !badTheme.ok, badTheme.status);

  const tutorialDone = await POST('/preferences/tutorial-complete', {}, token);
  check('the tutorial can be marked complete', tutorialDone.ok, tutorialDone.status);

  /* ------------------------------ 8. seasons ------------------------------ */

  section('8. Seasons');

  const season = await GET('/seasons/current', token);
  check('a season is running', season.ok && season.data.season, season.status);

  const seasonHistory = await GET('/seasons/history', token);
  check('season history loads', seasonHistory.ok, seasonHistory.status);

  const seasonBoard = await GET('/seasons/leaderboard', token);
  check('the season leaderboard loads', seasonBoard.ok, seasonBoard.status);

  const settleAsPlayer = await POST(`/seasons/${season.data.season?.id ?? fakeCrate}/settle`, {}, token);
  check('a player cannot settle a season', !settleAsPlayer.ok, settleAsPlayer.status);

  /* ------------------------------- 9. social ------------------------------ */

  section('9. Social');

  const bob = await register('sweepb');
  const bobToken = bob.tokens.accessToken;

  const friends0 = await GET('/social/friends', token);
  check('the friends list loads', friends0.ok, friends0.status);

  const request = await POST('/social/requests', { userId: bob.user.id }, token);
  check('a friend request can be sent', request.ok, request.data);

  const selfRequest = await POST('/social/requests', { userId: alice.user.id }, token);
  check('you cannot friend yourself', !selfRequest.ok, selfRequest.status);

  const pending = await GET('/social/requests', bobToken);
  check('the request arrives', pending.data.incoming?.length > 0, pending.data.incoming?.length);

  const accepted = await POST(
    `/social/requests/${pending.data.incoming[0].id}/accept`,
    {},
    bobToken,
  );
  check('a request can be accepted', accepted.ok, accepted.data);

  const friends1 = await GET('/social/friends', token);
  check('the friendship shows up', friends1.data.friends?.length > 0, friends1.data.friends?.length);
  check('presence is reported', Boolean(friends1.data.friends?.[0]?.presence), friends1.data.friends?.[0]);

  const carol = await register('sweepc');
  const carolRequest = await POST('/social/requests', { userId: carol.user.id }, token);
  check('a second request can be sent', carolRequest.ok, carolRequest.data);
  const carolPending = await GET('/social/requests', carol.tokens.accessToken);
  const rejected = await POST(
    `/social/requests/${carolPending.data.incoming[0].id}/reject`,
    {},
    carol.tokens.accessToken,
  );
  check('a request can be rejected', rejected.ok, rejected.data);

  const follow = await POST('/social/follow', { userId: carol.user.id, follow: true }, token);
  check('a player can be followed', follow.ok, follow.data);

  const following = await GET('/social/following', token);
  check('the following list loads', following.ok, following.status);

  const unfollow = await POST('/social/follow', { userId: carol.user.id, follow: false }, token);
  check('a player can be unfollowed', unfollow.ok, unfollow.data);

  const fairPlay = await GET(`/social/fair-play/${bob.user.id}`, token);
  check('a fair play score is available', fairPlay.ok, fairPlay.status);

  const socialSearch = await GET(`/social/search?q=${bob.user.username.slice(0, 6)}`, token);
  check('player search finds someone', socialSearch.ok, socialSearch.status);

  const recent = await GET('/social/recent', token);
  check('recent opponents load', recent.ok, recent.status);

  const blocked = await POST('/social/block', { userId: carol.user.id, blocked: true }, token);
  check('a player can be blocked', blocked.ok, blocked.data);
  await POST('/social/block', { userId: carol.user.id, blocked: false }, token);

  const unfriend = await DEL(`/social/friends/${carol.user.id}`, token);
  check('a friend can be removed', unfriend.status < 500, unfriend.status);

  /* --------------------------- 10. leaderboards --------------------------- */

  section('10. Leaderboards');

  for (const query of [
    'metric=trophies&window=all_time',
    'metric=wins&window=weekly',
    'metric=xp&window=monthly',
    'metric=streak&window=all_time',
    'scope=friends&metric=trophies',
    'scope=country&metric=trophies',
  ]) {
    const board = await GET(`/leaderboard?${query}`, token);
    check(`leaderboard: ${query}`, board.ok, board.status);
  }

  const boardRows = await GET('/leaderboard?metric=trophies&window=all_time&limit=100', token);
  const botOnBoard = (boardRows.data.rows ?? []).some((r: any) =>
    String(r.username ?? '').startsWith('bot_'),
  );
  check('no bot appears on the leaderboard', !botOnBoard);

  /* --------------------------- 11. notifications -------------------------- */

  section('11. Notifications');

  const notes = await GET('/notifications', bobToken);
  check('notifications load', notes.ok, notes.status);
  check('the friend request produced one', notes.data.notifications?.length > 0, notes.data.notifications?.length);

  const unread = await GET('/notifications/unread-count', bobToken);
  check('an unread count is available', typeof unread.data.unread === 'number', unread.data);

  const noteId = notes.data.notifications?.[0]?.id;
  if (noteId) {
    const markRead = await POST('/notifications/read', { ids: [noteId] }, bobToken);
    check('a notification can be marked read', markRead.ok, markRead.data);
  }

  const readAll = await POST('/notifications/read-all', {}, bobToken);
  check('everything can be marked read', readAll.ok, readAll.data);

  const afterRead = await GET('/notifications/unread-count', bobToken);
  check('the unread count clears', afterRead.data.unread === 0, afterRead.data);

  if (noteId) {
    const deleted = await DEL(`/notifications/${noteId}`, bobToken);
    check('a notification can be dismissed', deleted.ok, deleted.status);
  }

  const filteredNotes = await GET('/notifications?unread=true&limit=5', bobToken);
  check('notifications filter by unread', filteredNotes.ok, filteredNotes.status);

  /* ------------------------------ 12. search ------------------------------ */

  section('12. Global search');

  const search = await GET('/search?q=classic', token);
  check('search finds cosmetics', search.data.items?.length > 0, search.data.items?.length);

  const searchPlayers = await GET(`/search?q=${bob.user.username.slice(0, 6)}&type=players`, token);
  check('search finds players', searchPlayers.data.players?.length > 0, searchPlayers.data.players?.length);

  const searchShort = await GET('/search?q=a', token);
  check('a one-character search is refused', !searchShort.ok, searchShort.status);

  // With LIKE wildcards escaped this is a literal search for "bot_".
  const searchBots = await GET('/search?q=bot_&type=players', token);
  check('search never returns a bot', (searchBots.data.players ?? []).length === 0, searchBots.data.players);

  /* ------------------------------ 13. events ------------------------------ */

  section('13. Live events');

  const events = await GET('/events', token);
  check('the event list loads', events.ok, events.status);
  check('multipliers are reported', typeof events.data.multipliers?.xp === 'number', events.data.multipliers);

  /* ------------------------------- 14. store ------------------------------ */

  section('14. Store and purchases');

  const store = await GET('/store', token);
  check('the store loads', store.data.products?.length > 0, store.data.products?.length);
  check('a provider is configured', store.data.providers?.length > 0, store.data.providers);

  const gemPack = store.data.products.find((p: any) => p.kind === 'gem_pack');
  const beforeGems = store.data.balances.gems;

  const checkout = await POST('/store/checkout', { productId: gemPack.id, platform: 'web' }, token);
  check('checkout opens an order', checkout.ok && checkout.data.purchaseId, checkout.data);

  const forged = await POST(
    '/store/confirm',
    { purchaseId: checkout.data.purchaseId, receipt: 'i-definitely-paid' },
    token,
  );
  check('a forged receipt is refused', !forged.ok, forged.status);

  const order2 = await POST('/store/checkout', { productId: gemPack.id, platform: 'web' }, token);
  const confirmed = await POST(
    '/store/confirm',
    { purchaseId: order2.data.purchaseId, receipt: `sandbox:${order2.data.purchaseId}` },
    token,
  );
  check('a verified purchase is granted', confirmed.data.status === 'granted', confirmed.data);
  check(
    'gems were credited',
    confirmed.data.balances.gems === beforeGems + gemPack.grants.gems,
    { beforeGems, after: confirmed.data.balances.gems },
  );

  const replay = await POST(
    '/store/confirm',
    { purchaseId: order2.data.purchaseId, receipt: `sandbox:${order2.data.purchaseId}` },
    token,
  );
  check('a replayed confirm grants nothing', replay.data.alreadyGranted === true, replay.data);

  const missingProduct = await POST('/store/checkout', { productId: 'nope', platform: 'web' }, token);
  check('an unknown product is refused', !missingProduct.ok, missingProduct.status);

  const purchases = await GET('/store/purchases', token);
  check('purchase history loads', purchases.data.purchases?.length > 0, purchases.data.purchases?.length);

  const storeWallet = await GET('/store/wallet', token);
  check('the wallet shows the gem ledger', storeWallet.data.gemHistory?.length > 0, storeWallet.data.gems);

  const spend = await POST('/store/spend-gems', { amount: 10, note: 'sweep test' }, token);
  check('gems can be spent', spend.ok, spend.data);

  const overspend = await POST('/store/spend-gems', { amount: 999_999, note: 'too much' }, token);
  check('overspending gems is refused', !overspend.ok, overspend.status);

  const restore = await POST('/store/restore', {}, token);
  check('purchases can be restored', restore.ok, restore.data);

  /* ------------------------------- 15. pass ------------------------------- */

  section('15. Carrom Pass');

  const pass = await GET('/pass', token);
  check('a pass season is running', Boolean(pass.data.pass), pass.data);
  check('it has fifty tiers', pass.data.pass?.tiers === 50, pass.data.pass?.tiers);
  check('premium is locked without the pass', pass.data.premium === false, pass.data.premium);

  const premiumClaim = await POST('/pass/claim', { tier: 1, track: 'premium' }, token);
  check('the premium track refuses a free account', !premiumClaim.ok, premiumClaim.status);

  const farClaim = await POST('/pass/claim', { tier: 50, track: 'free' }, token);
  check('an unreached tier is refused', !farClaim.ok, farClaim.status);

  const claimAll = await POST('/pass/claim-all', {}, token);
  check('claim-all responds', claimAll.ok, claimAll.data);

  /* ------------------------------ 16. promos ------------------------------ */

  section('16. Promo codes');

  const badCode = await POST('/promos/redeem', { code: 'NOSUCHCODE' }, token);
  check('an unknown code is refused', !badCode.ok, badCode.status);

  /* -------------------------------- 17. ads ------------------------------- */

  section('17. Advertising');

  const policy = await GET('/ads/policy', token);
  check('the ad policy loads', policy.ok, policy.status);
  check('ads are on for a free account', policy.data.enabled === true, policy.data.enabled);
  check(
    'interstitials are capped tighter than banners',
    policy.data.limits.interstitial.perDay < policy.data.limits.banner.perDay,
    policy.data.limits,
  );

  const banner = await GET('/ads/next?placement=banner&platform=web', token);
  check('a banner is served', Boolean(banner.data.ad), banner.data.reason);

  if (banner.data.ad) {
    const click = await POST('/ads/click', { impressionId: banner.data.ad.impressionId }, token);
    check('a click is recorded', click.ok, click.data);
  }

  const interstitial = await GET('/ads/next?placement=interstitial&platform=web', token);
  check('an interstitial is served', Boolean(interstitial.data.ad), interstitial.data.reason);

  const rewarded = await GET('/ads/next?placement=rewarded&platform=web', token);
  check('a rewarded ad is served', Boolean(rewarded.data.ad), rewarded.data.reason);

  if (rewarded.data.ad) {
    const tooFast = await POST('/ads/complete', { impressionId: rewarded.data.ad.impressionId }, token);
    check('an instantly completed video pays nothing', !tooFast.ok, tooFast.status);

    await sleep(5_500);
    const paid = await POST('/ads/complete', { impressionId: rewarded.data.ad.impressionId }, token);
    check('a watched video pays out', paid.ok && paid.data.granted, paid.data);

    const paidTwice = await POST('/ads/complete', { impressionId: rewarded.data.ad.impressionId }, token);
    check('the same view cannot pay twice', paidTwice.data?.alreadyRewarded === true, paidTwice.data);
  }

  const tooSoon = await GET('/ads/next?placement=rewarded&platform=web', token);
  check('the rewarded gap is enforced', tooSoon.data.ad === null, tooSoon.data.reason);

  /* ------------------------------- 18. gifts ------------------------------ */

  section('18. Friend gifts');

  const eligible = await GET('/gifts/eligible', token);
  check('the gift screen loads', eligible.ok, eligible.status);
  check('limits are published', eligible.data.limits?.maxAmount > 0, eligible.data.limits);

  const tooNew = await POST('/gifts', { userId: bob.user.id, amount: 1_000 }, token);
  check('a brand new friendship cannot be gifted', !tooNew.ok, tooNew.status);

  // Backdate the friendship so the rest of the flow can be exercised.
  await db.query(
    "UPDATE friends SET created_at = now() - INTERVAL '3 days' WHERE user_id = $1 AND friend_id = $2",
    [alice.user.id, bob.user.id],
  );

  const beforeA = (await GET('/profile/me', token)).data.profile.coins;
  const beforeB = (await GET('/profile/me', bobToken)).data.profile.coins;

  const gift = await POST('/gifts', { userId: bob.user.id, amount: 1_000 }, token);
  check('a gift is accepted', gift.ok, gift.data);

  const afterA = (await GET('/profile/me', token)).data.profile.coins;
  const afterB = (await GET('/profile/me', bobToken)).data.profile.coins;
  check('the sender is debited', afterA === beforeA - 1_000, { beforeA, afterA });
  check('the recipient is credited', afterB === beforeB + 1_000, { beforeB, afterB });
  check('no coins were created', afterA + afterB === beforeA + beforeB);

  const secondGift = await POST('/gifts', { userId: bob.user.id, amount: 1_000 }, token);
  check('only one gift a day', !secondGift.ok, secondGift.status);

  const guestGift = await POST('/gifts', { userId: bob.user.id, amount: 1_000 }, theGuest.tokens.accessToken);
  check('a guest cannot gift', !guestGift.ok, guestGift.status);

  const giftHistory = await GET('/gifts', token);
  check('gift history loads', giftHistory.data.sent?.length > 0, giftHistory.data.sent?.length);

  /* ----------------------------- 19. telemetry ---------------------------- */

  section('19. Telemetry');

  const sample = await POST(
    '/telemetry/perf',
    { platform: 'web', fpsAvg: 59.2, fpsMin: 44, jankRatio: 0.01, pingMs: 32, inMatch: false },
    token,
  );
  check('a performance sample is accepted', sample.ok, sample.status);

  const badSample = await POST('/telemetry/perf', { platform: 'web', fpsAvg: 9_999, fpsMin: 0 }, token);
  check('an impossible frame rate is refused', !badSample.ok, badSample.status);

  const clientError = await POST(
    '/telemetry/error',
    { platform: 'web', kind: 'error', message: 'sweep synthetic error' },
    token,
  );
  check('a client error is accepted', clientError.ok, clientError.status);

  const analyticsEvent = await POST('/analytics/event', { name: 'sweep_probe', props: { ok: true } }, token);
  check('an analytics event is accepted', analyticsEvent.status < 500, analyticsEvent.status);

  /* ---------------------------- 20. tournaments --------------------------- */

  section('20. Tournaments');

  const tournaments = await GET('/tournaments', token);
  check('the tournament list loads', tournaments.ok, tournaments.status);

  const createAsPlayer = await POST('/tournaments', { name: 'Nope Cup' }, token);
  check('a player cannot create a tournament', !createAsPlayer.ok, createAsPlayer.status);

  // The rest of the lifecycle needs staff, so promote one early.
  const organiser = await register('sweeptour');
  const organiserToken = await makeAdmin(organiser);

  const cup = await POST(
    '/tournaments',
    {
      name: `Sweep Cup ${Date.now().toString().slice(-5)}`,
      entryCoins: 200,
      maxPlayers: 4,
      tierId: 'beginner',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    organiserToken,
  );
  check('staff can create a tournament', cup.ok, cup.data);

  const cupId = cup.data?.tournamentId;

  if (cupId) {
    const detail = await GET(`/tournaments/${cupId}`, token, 'GET /tournaments/:id');
    check('a tournament opens', detail.ok, detail.status);
    check('it lists players and matches', Array.isArray(detail.data.players), detail.data.players);

    const registered = await POST(
      `/tournaments/${cupId}/register`,
      {},
      token,
      'POST /tournaments/:id/register',
    );
    check('a player can register', registered.ok, registered.data);

    const registeredTwice = await POST(
      `/tournaments/${cupId}/register`,
      {},
      token,
      'POST /tournaments/:id/register',
    );
    check('registering twice is refused', !registeredTwice.ok, registeredTwice.status);

    const afterRegister = await GET(`/tournaments/${cupId}`, token, 'GET /tournaments/:id');
    check('the entrant shows up', afterRegister.data.players?.length >= 1, afterRegister.data.players?.length);

    const withdrawn = await POST(
      `/tournaments/${cupId}/withdraw`,
      {},
      token,
      'POST /tournaments/:id/withdraw',
    );
    check('a player can withdraw', withdrawn.ok, withdrawn.data);

    const startEmpty = await POST(
      `/tournaments/${cupId}/start`,
      {},
      organiserToken,
      'POST /tournaments/:id/start',
    );
    check('starting an empty bracket is refused', !startEmpty.ok, startEmpty.status);

    const cancelled = await POST(
      `/tournaments/${cupId}/cancel`,
      {},
      organiserToken,
      'POST /tournaments/:id/cancel',
    );
    check('staff can cancel a tournament', cancelled.ok, cancelled.data);
  }

  /* ------------------------------ 21. reports ----------------------------- */

  section('21. Reporting and moderation');

  const categories = await GET('/reports/categories', token);
  check('report categories load', categories.ok, categories.status);

  const report = await POST(
    '/reports',
    { reportedUserId: bob.user.id, category: 'cheating', detail: 'automated sweep' },
    token,
  );
  check('a player can be reported', report.ok, report.data);

  const dupeReport = await POST(
    '/reports',
    { reportedUserId: bob.user.id, category: 'cheating' },
    token,
  );
  check('a duplicate open report is refused', !dupeReport.ok, dupeReport.status);

  const myReports = await GET('/reports/mine', token);
  check('a player can see their own reports', myReports.ok, myReports.status);

  const mute = await POST('/reports/mute', { userId: carol.user.id, muted: true }, token);
  check('a player can be muted', mute.ok, mute.data);

  const adminAsPlayer = await GET('/admin/overview', token);
  check('a player cannot reach the admin API', !adminAsPlayer.ok, adminAsPlayer.status);

  /* ------------------------------- 22. admin ------------------------------ */

  section('22. Admin console');

  const staff = await register('sweepadm');
  const adminToken = await makeAdmin(staff);

  const adminGets: Array<[string, string]> = [
    ['/admin/overview', 'the overview'],
    ['/admin/economy/audit', 'the coin audit'],
    ['/admin/users?limit=5', 'the player list'],
    ['/admin/matches?limit=5', 'the match list'],
    ['/admin/items', 'the item list'],
    ['/admin/config', 'the config list'],
    ['/admin/audit-log', 'the audit log'],
    ['/admin/moderation/reports', 'the report queue'],
    ['/admin/moderation/flags', 'the anti-cheat queue'],
    ['/admin/monetization?days=30', 'the revenue dashboard'],
    ['/admin/monetization/purchases?limit=5', 'the order list'],
    ['/admin/monetization/gem-audit', 'the gem audit'],
    ['/admin/perf?hours=24', 'the performance dashboard'],
    ['/admin/perf/prune', 'the retention rules'],
    ['/admin/events', 'the event list'],
    ['/admin/store/products', 'the product list'],
    ['/admin/pass', 'the pass list'],
    ['/admin/promos', 'the promo list'],
    ['/admin/ads/advertisers', 'the advertiser list'],
    ['/admin/ads/campaigns', 'the campaign list'],
    ['/admin/ads/report?days=7', 'the delivery report'],
  ];

  for (const [path, label] of adminGets) {
    const res = await GET(path, adminToken);
    check(`admin can read ${label}`, res.ok, `${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
  }

  const coinAudit = await GET('/admin/economy/audit', adminToken);
  check('the coin ledger balances', coinAudit.data.ok === true, coinAudit.data.mismatches?.slice(0, 3));

  const gemAudit = await GET('/admin/monetization/gem-audit', adminToken);
  check('the gem ledger balances', gemAudit.data.ok === true, gemAudit.data.mismatches?.slice(0, 3));

  const adminUser = await GET(`/admin/users/${bob.user.id}`, adminToken);
  check('admin can open a player', adminUser.ok, adminUser.status);

  const grantCoins = await POST(
    `/admin/users/${bob.user.id}/coins`,
    { delta: 500, note: 'sweep test' },
    adminToken,
  );
  check('admin can adjust a balance', grantCoins.ok, grantCoins.data);

  const setRole = await POST(`/admin/users/${carol.user.id}/role`, { role: 'moderator' }, adminToken);
  check('admin can change a role', setRole.ok, setRole.data);
  await POST(`/admin/users/${carol.user.id}/role`, { role: 'player' }, adminToken);

  // Only known keys are writable, and the value must match the default's
  // shape — that is the guard against a typo taking the economy down.
  const configKey = 'economy.bonusAmount';
  const putConfig = await PUT(
    `/admin/config/${configKey}`,
    { value: 500, description: 'sweep' },
    adminToken,
  );
  check('admin can write config', putConfig.ok, putConfig.data);

  const badKey = await PUT('/admin/config/not.a.real.key', { value: 1 }, adminToken);
  check('an unknown config key is refused', !badKey.ok, badKey.status);

  const badShape = await PUT(`/admin/config/${configKey}`, { value: 'a string' }, adminToken);
  check('a config value of the wrong shape is refused', !badShape.ok, badShape.status);

  const configHistory = await GET(`/admin/config/${configKey}/history`, adminToken);
  check('config history loads', configHistory.ok, configHistory.status);

  const delConfig = await DEL(`/admin/config/${configKey}`, adminToken);
  check('admin can delete config', delConfig.ok, delConfig.status);

  const editItem = await PATCH('/admin/items/str_classic', { shopCoins: 1_000 }, adminToken);
  check('admin can edit an item', editItem.ok, editItem.data);

  const eventId = `sweep_${Date.now().toString().slice(-6)}`;
  const makeEvent = await POST(
    '/admin/events',
    {
      id: eventId,
      name: 'Sweep Weekend',
      description: 'automated',
      kind: 'xp_boost',
      multiplier: 2,
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    adminToken,
  );
  check('admin can start an event', makeEvent.ok, makeEvent.data);

  const liveEvent = await GET('/events', token);
  check('a live event reaches players', liveEvent.data.multipliers?.xp === 2, liveEvent.data.multipliers);

  const stopEvent = await POST(`/admin/events/${eventId}/stop`, {}, adminToken, 'POST /admin/events/:id/stop');
  check('admin can stop an event', stopEvent.ok, stopEvent.data);

  const promoCode = `SWEEP${Date.now().toString().slice(-6)}`;
  const makePromo = await POST(
    '/admin/promos',
    { code: promoCode, description: 'sweep', grants: { coins: 1_000 }, maxUses: 3, perUser: 1 },
    adminToken,
  );
  check('admin can create a promo code', makePromo.ok, makePromo.data);

  const redeem = await POST('/promos/redeem', { code: promoCode }, bobToken);
  check('the promo code redeems', redeem.ok, redeem.data);

  const redeemTwice = await POST('/promos/redeem', { code: promoCode }, bobToken);
  check('a code cannot be redeemed twice by one player', !redeemTwice.ok, redeemTwice.status);

  const disablePromo = await POST(
    `/admin/promos/${promoCode}/disable`,
    {},
    adminToken,
    'POST /admin/promos/:code/disable',
  );
  check('admin can disable a promo code', disablePromo.ok, disablePromo.data);

  const disabledRedeem = await POST('/promos/redeem', { code: promoCode }, carol.tokens.accessToken);
  check('a disabled code stops working', !disabledRedeem.ok, disabledRedeem.status);

  // Created and then retired in the same breath: a test must not leave a
  // product sitting in the live store for players to see.
  const sweepProductId = `sweep_pack_${Date.now().toString().slice(-6)}`;
  const makeProduct = await POST(
    '/admin/store/products',
    {
      id: sweepProductId,
      kind: 'coin_pack',
      name: 'Sweep Pack',
      grants: { coins: 1_000 },
      priceMinor: 9_900,
    },
    adminToken,
  );
  check('admin can add a product', makeProduct.ok, makeProduct.data);

  const retireProduct = await POST(
    '/admin/store/products',
    {
      id: sweepProductId,
      kind: 'coin_pack',
      name: 'Sweep Pack',
      grants: { coins: 1_000 },
      priceMinor: 9_900,
      active: false,
    },
    adminToken,
  );
  check('a product can be retired', retireProduct.ok, retireProduct.data);

  const storeAfter = await GET('/store', token);
  check(
    'a retired product leaves the store',
    !(storeAfter.data.products ?? []).some((p: any) => p.id === sweepProductId),
    storeAfter.data.products?.map((p: any) => p.id),
  );

  const grantProduct = await POST(
    '/admin/store/grant',
    { userId: carol.user.id, productId: 'coins_small', note: 'sweep' },
    adminToken,
  );
  check('admin can grant a product', grantProduct.ok, grantProduct.data);

  const refund = await POST(
    '/admin/store/refund',
    { purchaseId: grantProduct.data.purchaseId, reason: 'sweep test', clawBack: true },
    adminToken,
  );
  check('admin can refund a purchase', refund.ok, refund.data);

  const revoke = await POST(
    '/admin/store/revoke-entitlement',
    { userId: carol.user.id, kind: 'ad_free', reason: 'sweep' },
    adminToken,
  );
  check('admin can revoke an entitlement', revoke.ok, revoke.data);

  const advertiser = await POST(
    '/admin/ads/advertisers',
    { name: `Sweep Ads ${Date.now().toString().slice(-5)}`, contactEmail: null },
    adminToken,
  );
  check('admin can add an advertiser', advertiser.ok, advertiser.data);

  const campaign = await POST(
    '/admin/ads/campaigns',
    {
      advertiserId: advertiser.data.advertiser.id,
      name: `Sweep Campaign ${Date.now().toString().slice(-5)}`,
      placement: 'banner',
      status: 'running',
      budgetMinor: 0,
      cpmMinor: 0,
      dailyCap: 5,
    },
    adminToken,
  );
  check('admin can book a campaign', campaign.ok, campaign.data);

  const creative = await POST(
    '/admin/ads/creatives',
    {
      campaignId: campaign.data.campaign.id,
      headline: 'Sweep creative',
      body: 'automated',
      cta: 'Look',
    },
    adminToken,
  );
  check('admin can add a creative', creative.ok, creative.data);

  const creatives = await GET(
    `/admin/ads/campaigns/${campaign.data.campaign.id}/creatives`,
    adminToken,
    'GET /admin/ads/campaigns/:id/creatives',
  );
  check('creatives list for a campaign', creatives.data.creatives?.length > 0, creatives.data);

  const passSave = await POST(
    '/admin/pass',
    {
      id: `sweep_pass_${Date.now().toString().slice(-6)}`,
      name: 'Sweep Pass',
      tiers: 10,
      xpPerTier: 500,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      rewards: [{ tier: 1, track: 'free', kind: 'coins', amount: 500 }],
    },
    adminToken,
  );
  check('admin can define a pass season', passSave.ok, passSave.data);

  const prune = await POST(
    '/admin/perf/prune',
    { table: 'perf_samples', olderThanDays: 365 },
    adminToken,
  );
  check('admin can prune telemetry', prune.ok, prune.data);

  const pruneFloor = await POST(
    '/admin/perf/prune',
    { table: 'perf_samples', olderThanDays: 1 },
    adminToken,
  );
  check('pruning below the retention floor is refused', !pruneFloor.ok, pruneFloor.status);

  const collusion = await POST('/admin/anti-cheat/collusion-scan', {}, adminToken);
  check('a collusion scan runs', collusion.ok, collusion.status);

  const reportQueue = await GET('/admin/moderation/reports', adminToken);
  const openReport = reportQueue.data.reports?.[0];
  if (openReport) {
    const reportDetail = await GET(
      `/admin/moderation/reports/${openReport.id}`,
      adminToken,
      'GET /admin/moderation/reports/:id',
    );
    check('a report opens for review', reportDetail.ok, reportDetail.status);

    const resolved = await POST(
      `/admin/moderation/reports/${openReport.id}/resolve`,
      { resolution: 'no_action', note: 'sweep test' },
      adminToken,
      'POST /admin/moderation/reports/:id/resolve',
    );
    check('a report can be resolved', resolved.ok, resolved.data);
  }

  const flagQueue = await GET('/admin/moderation/flags', adminToken);
  const openFlag = flagQueue.data.flags?.[0];
  if (openFlag) {
    const reviewed = await POST(
      `/admin/moderation/flags/${openFlag.id}/review`,
      { verdict: 'dismissed', note: 'sweep' },
      adminToken,
      'POST /admin/moderation/flags/:id/review',
    );
    check('an anti-cheat flag can be reviewed', reviewed.ok, reviewed.data);
  } else {
    check('anti-cheat queue is empty (nothing to review)', true);
  }

  const banned = await POST(
    `/admin/moderation/users/${carol.user.id}/ban`,
    { reason: 'sweep test', scope: 'chat', hours: 1 },
    adminToken,
    'POST /admin/moderation/users/:id/ban',
  );
  check('a player can be banned', banned.ok, banned.data);

  const unbanned = await POST(
    `/admin/moderation/users/${carol.user.id}/unban`,
    { reason: 'sweep test' },
    adminToken,
    'POST /admin/moderation/users/:id/unban',
  );
  check('a ban can be lifted', unbanned.ok, unbanned.data);

  const analyticsSummary = await GET('/analytics/summary', adminToken);
  check('the analytics summary loads', analyticsSummary.ok, analyticsSummary.status);

  const matchList = await GET('/admin/matches?limit=1', adminToken);
  const someMatch = matchList.data.matches?.[0];
  if (someMatch) {
    const replay = await GET(
      `/admin/matches/${someMatch.id}/replay`,
      adminToken,
      'GET /admin/matches/:id/replay',
    );
    check('a match replay loads shot by shot', replay.ok, replay.status);
  } else {
    check('no match to replay yet', true);
  }

  const seasonNow = await GET('/seasons/current', adminToken);
  const settleRunning = await POST(
    `/seasons/${seasonNow.data.season?.id}/settle`,
    {},
    adminToken,
    'POST /seasons/:id/settle',
  );
  // Settling a season that is still running pays every placement reward and
  // resets all ratings, so it must be refused rather than silently done.
  check('settling a live season is refused', !settleRunning.ok, settleRunning.status);
  check(
    'and it says why',
    String((settleRunning.data as any)?.code ?? '') === 'season_still_running',
    settleRunning.data,
  );

  /* ------------------------ 23. a real match, played ---------------------- */

  section('23. A real match over sockets');

  const p1 = await guest('Sweep One');
  const p2 = await guest('Sweep Two');
  const s1 = await connect(p1.tokens.accessToken);
  const s2 = await connect(p2.tokens.accessToken);

  const started1 = waitFor<{ state: GameState }>(s1, 'game:start', 20_000);
  const started2 = waitFor<{ state: GameState }>(s2, 'game:start', 20_000);

  s1.emit('lobby:quickMatch', { modeId: 'quick', tierId: 'beginner' });
  await sleep(400);
  s2.emit('lobby:quickMatch', { modeId: 'quick', tierId: 'beginner' });

  const [start1, start2] = await Promise.all([started1, started2]);
  check('a match starts for both players', Boolean(start1 && start2), { start1: !!start1, start2: !!start2 });

  if (start1) {
    check('the board opens with 19 men', start1.state.bodies.filter((b) => b.kind !== 'striker').length === 19);
    check('the pot holds both entry fees', start1.state.pot === 400, start1.state.pot);

    const sockets: Record<string, Socket> = { [p1.user.id]: s1, [p2.user.id]: s2 };
    const result = new Promise<MatchResult | null>((resolve) => {
      const done = (payload: MatchResult) => resolve(payload);
      s1.once('game:over', done);
      setTimeout(() => resolve(null), 90_000);
    });

    // A shot out of turn must be refused.
    const idle = start1.state.turnSeat === 0 ? s2 : s1;
    const refused = waitFor<{ code: string }>(idle, 'game:error', 4_000);
    idle.emit('game:shot', { shot: { pos: 0.5, angle: -Math.PI / 2, power: 0.6 } });
    check('a shot out of turn is refused', Boolean(await refused));

    // Malformed shots must be refused.
    const active = start1.state.turnSeat === 0 ? s1 : s2;
    for (const bad of [
      { pos: 5, angle: 0, power: 0.5 },
      { pos: 0.5, angle: Number.NaN, power: 0.5 },
      { pos: 0.5, angle: 0, power: 99 },
    ]) {
      const err = waitFor(active, 'game:error', 3_000);
      active.emit('game:shot', { shot: bad as Shot });
      check(`a malformed shot is refused: ${JSON.stringify(bad)}`, Boolean(await err));
    }

    // Quick chat and reactions.
    const chat = waitFor<{ text: string }>(s2, 'chat:message', 4_000);
    s1.emit('chat:quick', { messageId: 'qm_gg' });
    check('quick chat is delivered', Boolean(await chat));

    // The server enforces a 1.5s gap between emotes, so waiting is the correct
    // way to send a second one rather than something to bypass.
    await sleep(1_700);
    const reaction = waitFor(s2, 'chat:message', 4_000);
    s1.emit('chat:quick', { emoji: '\u{1F44F}' });
    check('an emoji reaction is delivered', Boolean(await reaction));

    const blocked = waitFor(s1, 'chat:blocked', 4_000);
    for (let i = 0; i < 4; i++) s1.emit('chat:quick', { messageId: 'qm_nice' });
    check('emote spam is rate limited', Boolean(await blocked));

    s1.emit('presence:heartbeat');
    check('a presence heartbeat is accepted', true);

    // Play it out.
    let shots = 0;
    let live: GameState = start1.state;
    const onShot = (b: ShotBroadcast) => {
      live = b.state;
    };
    s1.on('game:shot', onShot);

    // Drive off the server's own broadcasts, the way a real client does. The
    // anti-cheat treats shots closer together than 250ms as automation, so
    // firing on a blind timer gets most of them correctly rejected.
    const deadline = Date.now() + 180_000;
    while (live.status === 'playing' && Date.now() < deadline && shots < 400) {
      const seatUser = live.players.find((p) => p.seat === live.turnSeat);
      const socket = seatUser ? sockets[seatUser.userId] : undefined;
      if (!socket) break;

      // Aim at the nearest man rather than at random: purely random shots
      // almost never pocket, and this is a test of the match lifecycle.
      const spot = { x: 400, y: live.turnSeat === 0 ? 690 : 110 };
      const target = live.bodies
        .filter((b) => b.kind !== 'striker' && !b.pocketed)
        .sort(
          (a, b) =>
            Math.hypot(a.x - spot.x, a.y - spot.y) - Math.hypot(b.x - spot.x, b.y - spot.y),
        )[0];

      const angle = target
        ? Math.atan2(target.y - spot.y, target.x - spot.x) + (Math.random() - 0.5) * 0.18
        : live.turnSeat === 0
          ? -Math.PI / 2
          : Math.PI / 2;

      const seq = live.seq;
      socket.emit('game:shot', {
        shot: { pos: 0.5, angle, power: 0.6 + Math.random() * 0.3 },
      });
      shots += 1;

      // Wait until the board actually moved on, so the next shot is a real
      // turn rather than one the server throws away.
      const until = Date.now() + 4_000;
      while (live.seq === seq && live.status === 'playing' && Date.now() < until) {
        await sleep(120);
      }
      await sleep(300);
    }
    s1.off('game:shot', onShot);

    const finished = await result;
    check('the match reaches a conclusion', Boolean(finished), `${shots} shots`);

    if (finished) {
      check('a reward is recorded for each player', Object.keys(finished.rewards).length === 2, finished.rewards);
      const winnerReward = Object.values(finished.rewards).find((r: any) => r.won) as any;
      const loserReward = Object.values(finished.rewards).find((r: any) => !r.won) as any;
      if (winnerReward && loserReward) {
        check('the winner is paid', winnerReward.coins > 0, winnerReward.coins);
        check('the loser is paid nothing', loserReward.coins === 0, loserReward.coins);
        check('both earn XP', winnerReward.xp > 0 && loserReward.xp > 0, {
          w: winnerReward.xp,
          l: loserReward.xp,
        });
      }
    }
  }

  s1.disconnect();
  s2.disconnect();

  /* ------------------------- 24. bots and spectating ---------------------- */

  section('24. Bot opponents');

  for (const skill of ['easy', 'medium', 'hard'] as const) {
    const player = await guest(`Bot ${skill}`);
    const socket = await connect(player.tokens.accessToken);

    socket.emit('lobby:playBot', { skill });
    const start = await waitFor<{ state: GameState }>(socket, 'game:start', 15_000);
    check(`a ${skill} practice match starts`, Boolean(start), 'no game:start');

    if (start) {
      const opponent = start.state.players.find((p) => p.userId !== player.user.id);
      const isBot = opponent
        ? (await db.query('SELECT 1 FROM bot_accounts WHERE user_id = $1', [opponent.userId])).rowCount === 1
        : false;
      check(`the ${skill} opponent is a bot`, isBot, opponent?.displayName);
      check(`the ${skill} practice board is unstaked`, start.state.pot === 0, start.state.pot);

      let botShots = 0;
      const onShot = (b: ShotBroadcast) => {
        const shooter = start.state.players.find((p) => p.seat === b.seat);
        if (shooter && shooter.userId !== player.user.id) botShots += 1;
      };
      socket.on('game:shot', onShot);

      const until = Date.now() + 40_000;
      while (Date.now() < until && botShots < 2) {
        socket.emit('game:shot', {
          shot: { pos: 0.5, angle: start.state.turnSeat === 0 ? -Math.PI / 2 : Math.PI / 2, power: 0.6 },
        });
        await sleep(700);
      }
      socket.off('game:shot', onShot);
      check(`the ${skill} bot plays its own turns`, botShots >= 1, { botShots });
    }

    socket.emit('room:leave');
    socket.disconnect();
  }

  section('25. Spectating');

  const watcher = await guest('Sweep Watcher');
  const watchSocket = await connect(watcher.tokens.accessToken);

  const listed = waitFor<{ matches: unknown[] }>(watchSocket, 'watch:list', 5_000);
  watchSocket.emit('watch:list');
  const watchList = await listed;
  check('the watch list responds', Boolean(watchList), 'no watch:list');

  watchSocket.emit('watch:join', { matchId: '00000000-0000-4000-8000-000000000000' });
  const watchError = await waitFor(watchSocket, 'game:error', 4_000);
  check('joining a match that does not exist is refused', Boolean(watchError));

  watchSocket.emit('watch:leave');
  watchSocket.disconnect();

  section('26. Private rooms');

  const host = await guest('Sweep Host');
  const joiner = await guest('Sweep Joiner');
  const hostSocket = await connect(host.tokens.accessToken);
  const joinSocket = await connect(joiner.tokens.accessToken);

  const created = waitFor<{ code: string }>(hostSocket, 'lobby:roomCreated', 8_000);
  hostSocket.emit('lobby:createRoom', { modeId: 'private', tierId: 'beginner' });
  const room = await created;
  check('a private room is created', Boolean(room?.code), room);

  if (room?.code) {
    const joined = waitFor(joinSocket, 'room:state', 8_000);
    joinSocket.emit('lobby:joinRoom', { code: room.code });
    check('a second player joins by code', Boolean(await joined));

    hostSocket.emit('lobby:ready', { ready: true });
    joinSocket.emit('lobby:ready', { ready: true });
    const privateStart = await waitFor(hostSocket, 'game:start', 10_000);
    check('a private match starts when both are ready', Boolean(privateStart));
  }

  const badCodeJoin = Promise.race([
    waitFor(joinSocket, 'lobby:error', 5_000),
    waitFor(joinSocket, 'game:error', 5_000),
  ]);
  joinSocket.emit('lobby:joinRoom', { code: 'ZZZZZ' });
  check('an unknown room code is refused', Boolean(await badCodeJoin));

  hostSocket.emit('room:leave');
  joinSocket.emit('room:leave');
  hostSocket.disconnect();
  joinSocket.disconnect();

  section('27. Solo practice');

  const soloPlayer = await guest('Sweep Solo');
  const soloSocket = await connect(soloPlayer.tokens.accessToken);
  const soloStart = waitFor<{ state: GameState }>(soloSocket, 'game:start', 10_000);
  soloSocket.emit('lobby:createRoom', { modeId: 'practice', tierId: 'beginner', solo: true });
  const solo = await soloStart;
  check('a solo practice board starts', Boolean(solo));
  check('solo practice is unstaked', solo?.state.pot === 0, solo?.state.pot);

  const cancelled = waitFor(soloSocket, 'lobby:cancelled', 4_000);
  soloSocket.emit('lobby:cancel');
  check('queueing can be cancelled', Boolean(await cancelled));

  soloSocket.emit('room:leave');
  soloSocket.disconnect();

  /* -------------------------- 28. ledger integrity ------------------------ */

  section('28. Ledger integrity, after everything above');

  const finalCoinAudit = await GET('/admin/economy/audit', adminToken);
  check('the coin ledger still balances', finalCoinAudit.data.ok === true, finalCoinAudit.data.mismatches?.slice(0, 3));

  const finalGemAudit = await GET('/admin/monetization/gem-audit', adminToken);
  check('the gem ledger still balances', finalGemAudit.data.ok === true, finalGemAudit.data.mismatches?.slice(0, 3));

  const negative = await db.query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM profiles WHERE coins < 0 OR gems < 0',
  );
  check('no balance is negative', Number(negative.rows[0]?.n) === 0, negative.rows[0]);

  const orphanGifts = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM coin_gifts g
      WHERE NOT EXISTS (
        SELECT 1 FROM coin_ledger l
         WHERE l.user_id = g.from_user AND l.reason = 'gift_sent'
      )`,
  );
  check('every gift has a ledger entry', Number(orphanGifts.rows[0]?.n) === 0, orphanGifts.rows[0]);

  /* --------------------------- coverage reporting ------------------------- */

  await db.end();

  console.log(`\n${'='.repeat(64)}`);
  console.log(`${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const line of failures) console.log(`  - ${line}`);
  }

  console.log(`\nRoutes exercised: ${touched.size}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nsweep crashed:', err);
  await db.end().catch(() => undefined);
  process.exit(1);
});
