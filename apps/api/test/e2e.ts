/**
 * End-to-end smoke test against a running API.
 *
 * Signs two guests in, matchmakes them into a real board, plays it to a
 * conclusion over the socket, and checks that the money moved the way the rules
 * say it should. This is the test that exercises everything the unit tests
 * cannot: HTTP auth, the socket gateway, matchmaking, the coin ledger, reward
 * settlement and the database.
 *
 * Run with the API already up:  npx tsx test/e2e.ts
 */
import { io, type Socket } from 'socket.io-client';
import type { GameState, MatchResult, Shot, ShotBroadcast } from '@carrom/types';

const API = process.env.API_URL ?? 'http://localhost:4000';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
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

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

/** Anonymous GET, for the public endpoints. */
async function open<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  return (await res.json()) as T;
}

async function patch<T>(path: string, body: unknown, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

interface Session {
  user: { id: string; username: string; isGuest: boolean };
  profile: { coins: number; level: number; displayName: string };
  tokens: { accessToken: string; refreshToken: string };
}

interface Player {
  name: string;
  session: Session;
  socket: Socket;
  seat: number | null;
  color: 'white' | 'black' | null;
  state: GameState | null;
  balance: number;
  result: MatchResult | null;
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(API, { auth: { token }, transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error('socket connect timed out')), 10_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log(`Carrom end-to-end test against ${API}\n${'='.repeat(52)}`);

  /* ------------------------------ health & auth ----------------------------- */

  section('Health and configuration');
  const health = await open<{ ok: boolean; database: boolean }>('/health');
  check('API reports healthy', health.ok === true, health);
  check('database is connected', health.database === true);

  const providers = await open<{ guest: boolean; facebook: boolean }>('/auth/providers');
  check('sign-in providers are advertised', typeof providers.guest === 'boolean', providers);

  const catalog = await open<{
    counts: { strikers: number; coinSets: number; boards: number };
    currencyNotice: string;
  }>('/catalog');
  check('catalogue ships 50 strikers', catalog.counts.strikers === 50, catalog.counts);
  check('catalogue ships 50 coin sets', catalog.counts.coinSets === 50);
  check('catalogue ships 20 boards', catalog.counts.boards === 20);
  check('coins are declared as virtual', /no cash value/i.test(catalog.currencyNotice ?? ''));

  section('Accounts');
  const players: Player[] = [];
  for (const name of ['Alpha', 'Bravo']) {
    const session = await post<Session>('/auth/guest', { displayName: name });
    check(`${name}: guest account created`, Boolean(session.user.id), session.user.username);
    check(`${name}: starts with coins`, session.profile.coins > 0, session.profile.coins);
    players.push({
      name,
      session,
      socket: await connect(session.tokens.accessToken),
      seat: null,
      color: null,
      state: null,
      balance: session.profile.coins,
      result: null,
    });
  }
  check('both players connected a socket', players.every((p) => p.socket.connected));

  const startingBalance = players[0].session.profile.coins;

  /* ------------------------------- token refresh ---------------------------- */

  section('Session handling');
  const refreshed = await post<{ tokens: { accessToken: string; refreshToken: string } }>(
    '/auth/refresh',
    { refreshToken: players[0].session.tokens.refreshToken },
  );
  check('refresh token rotates', Boolean(refreshed.tokens.accessToken));

  try {
    await post('/auth/refresh', { refreshToken: players[0].session.tokens.refreshToken });
    check('reused refresh token is rejected', false, 'it was accepted');
  } catch {
    check('reused refresh token is rejected', true);
  }
  players[0].session.tokens = refreshed.tokens;

  /* --------------------------------- wiring --------------------------------- */

  for (const player of players) {
    player.socket.on('game:start', (payload: { state: GameState }) => {
      player.state = payload.state;
      const seat = payload.state.players.find((p) => p.userId === player.session.user.id);
      player.seat = seat?.seat ?? null;
      player.color = seat?.color ?? null;
    });
    player.socket.on('game:shot', (payload: ShotBroadcast) => {
      player.state = payload.state;
    });
    player.socket.on('game:timeout', (payload: { state: GameState }) => {
      player.state = payload.state;
    });
    player.socket.on('game:over', (payload: MatchResult) => {
      player.result = payload;
    });
    player.socket.on('wallet:update', (payload: { balance: number }) => {
      player.balance = payload.balance;
    });
  }

  /* ------------------------------- matchmaking ------------------------------ */

  section('Matchmaking');
  for (const player of players) {
    player.socket.emit('lobby:quickMatch', { modeId: 'quick', tierId: 'beginner' });
    await wait(250);
  }

  for (let i = 0; i < 40 && !players.every((p) => p.state); i++) await wait(250);

  check('a match started for both players', players.every((p) => p.state !== null));
  if (!players[0].state) {
    console.log('\nNo match started; aborting.');
    process.exit(1);
  }

  check('players were seated opposite colours', players[0].color !== players[1].color, {
    a: players[0].color,
    b: players[1].color,
  });
  check('the board opens with 19 men', players[0].state!.bodies.filter((b) => b.kind !== 'striker').length === 19);
  check('the pot is the two entry fees', players[0].state!.pot === players[0].state!.entry * 2, {
    pot: players[0].state!.pot,
    entry: players[0].state!.entry,
  });

  await wait(500);
  const entry = players[0].state!.entry;
  check('the entry fee was taken from both players', players.every((p) => p.balance === startingBalance - entry), {
    before: startingBalance,
    entry,
    balances: players.map((p) => p.balance),
  });

  /* --------------------------------- anti-cheat ----------------------------- */

  section('Shot validation');
  const errors: string[] = [];
  players[0].socket.on('game:error', (payload: { message: string }) => errors.push(payload.message));

  const notTurn = players.find((p) => p.seat !== p.state!.turnSeat)!;
  const offTurnErrors: string[] = [];
  notTurn.socket.on('game:error', (payload: { message: string }) => offTurnErrors.push(payload.message));
  notTurn.socket.emit('game:shot', { shot: { pos: 0.5, angle: -Math.PI / 2, power: 0.5 } });
  await wait(600);
  check('a shot out of turn is refused', offTurnErrors.length > 0, offTurnErrors);

  const onTurn = players.find((p) => p.seat === p.state!.turnSeat)!;
  const badShots: Array<[string, unknown]> = [
    ['power above 1', { pos: 0.5, angle: 0, power: 9 }],
    ['striker off the base line', { pos: 7, angle: 0, power: 0.5 }],
    ['non-numeric angle', { pos: 0.5, angle: 'left', power: 0.5 }],
  ];
  const rejections: string[] = [];
  onTurn.socket.on('game:error', (payload: { message: string }) => rejections.push(payload.message));
  for (const [, shot] of badShots) {
    onTurn.socket.emit('game:shot', { shot });
    await wait(400);
  }
  check('malformed shots are all refused', rejections.length >= badShots.length, rejections);

  /* ---------------------------------- play ---------------------------------- */

  section('Playing a full match');
  let turns = 0;
  const started = Date.now();

  while (!players[0].result && turns < 400 && Date.now() - started < 180_000) {
    const state = players[0].state ?? players[1].state;
    if (!state || state.status !== 'playing') {
      await wait(150);
      continue;
    }

    const shooter = players.find((p) => p.seat === state.turnSeat);
    if (!shooter) {
      await wait(150);
      continue;
    }

    const shot: Shot = {
      pos: Math.random(),
      angle: -Math.PI / 2 + (Math.random() - 0.5) * 1.6,
      power: 0.45 + Math.random() * 0.5,
    };
    shooter.socket.emit('game:shot', { shot });
    turns++;

    // The server needs a moment to simulate and broadcast.
    await wait(320);
  }

  check('the match reached a conclusion', players[0].result !== null, { turns });

  const result = players[0].result;
  if (result) {
    console.log(`        played ${turns} shots, winner: ${result.winner ?? 'draw'}`);
    check('both players received the result', players.every((p) => p.result !== null));
    check('the result names a winner or a draw', result.winner === null || ['white', 'black'].includes(result.winner));

    const rewards = Object.values(result.rewards);
    check('a reward was recorded for each player', rewards.length === 2, rewards.length);

    if (result.winner) {
      const winner = players.find((p) => p.color === result.winner)!;
      const loser = players.find((p) => p.color !== result.winner)!;
      const winReward = result.rewards[winner.session.user.id];
      const loseReward = result.rewards[loser.session.user.id];

      check('the winner is paid the pot less the rake', winReward.coins === Math.floor(entry * 2 * 0.9), {
        paid: winReward.coins,
        expected: Math.floor(entry * 2 * 0.9),
      });
      check('the loser is paid nothing', loseReward.coins === 0, loseReward.coins);
      check('both players earn XP', winReward.xp > 0 && loseReward.xp > 0);
      check('the winner earns more XP than the loser', winReward.xp > loseReward.xp);
      check('the winner receives a crate', winReward.crateKind !== null, winReward.crateKind);
    }
  }

  await wait(1_000);

  /* --------------------------------- the books ------------------------------ */

  section('Economy integrity');
  for (const player of players) {
    const wallet = await get<{ balance: number; ledger: Array<{ delta: number }> }>(
      '/profile/wallet',
      player.session.tokens.accessToken,
    );
    const ledgerTotal = wallet.ledger.reduce((sum, entry) => sum + Number(entry.delta), 0);
    check(
      `${player.name}: balance equals the sum of the ledger`,
      Number(wallet.balance) === ledgerTotal,
      { balance: wallet.balance, ledgerTotal },
    );
    check(`${player.name}: balance is never negative`, Number(wallet.balance) >= 0);
  }

  section('Progression');
  const home = await get<{
    profile: { gamesPlayed: number; level: number };
    crates: { held: number };
    missions: unknown[];
  }>('/profile/home', players[0].session.tokens.accessToken);
  check('the match was recorded on the profile', home.profile.gamesPlayed === 1, home.profile.gamesPlayed);
  check('daily missions were issued', home.missions.length > 0, home.missions.length);

  const history = await get<{ matches: unknown[] }>(
    '/profile/history',
    players[0].session.tokens.accessToken,
  );
  check('the match appears in history', history.matches.length === 1, history.matches.length);

  const season = await get<{ season: { number: number }; me: { division: { id: string } } }>(
    '/seasons/current',
    players[0].session.tokens.accessToken,
  );
  check('a season is running', season.season.number >= 1, season.season);

  const daily = await get<{ days: unknown[]; cycleDay: number }>(
    '/daily',
    players[0].session.tokens.accessToken,
  );
  check('the login calendar has seven days', daily.days.length === 7, daily.days.length);

  const claim = await post<{ ok: boolean; alreadyClaimed: boolean; coins: number }>(
    '/daily/claim',
    {},
    players[0].session.tokens.accessToken,
  );
  check('the daily reward can be claimed', claim.ok === true, claim);

  const replay = await post<{ alreadyClaimed: boolean }>(
    '/daily/claim',
    {},
    players[0].session.tokens.accessToken,
  );
  check('claiming twice in a day pays only once', replay.alreadyClaimed === true, replay);

  section('Inventory');
  const inventory = await get<{
    strikers: Array<{ owned: boolean }>;
    counts: { owned: number; total: number };
  }>('/inventory', players[0].session.tokens.accessToken);
  check('the locker lists every cosmetic', inventory.counts.total === 120, inventory.counts);
  check('starter items are owned', inventory.counts.owned > 0, inventory.counts.owned);

  section('Moderation');
  const reported = await post<{ ok: boolean; reportId: string }>(
    '/reports',
    { reportedUserId: players[1].session.user.id, category: 'cheating', detail: 'automated test' },
    players[0].session.tokens.accessToken,
  );
  check('a player can be reported', reported.ok === true, reported);

  try {
    await post(
      '/reports',
      { reportedUserId: players[1].session.user.id, category: 'cheating' },
      players[0].session.tokens.accessToken,
    );
    check('a duplicate open report is refused', false, 'it was accepted');
  } catch {
    check('a duplicate open report is refused', true);
  }

  try {
    await get('/admin/overview', players[0].session.tokens.accessToken);
    check('a player cannot reach the admin API', false, 'access was granted');
  } catch {
    check('a player cannot reach the admin API', true);
  }

  /* ------------------------- preferences and themes ------------------------- */

  section('Preferences');
  const prefs = await get<{
    preferences: { theme: string; tutorialDone: boolean };
    themes: unknown[];
  }>('/preferences', players[0].session.tokens.accessToken);
  check('six interface themes are offered', prefs.themes.length === 6, prefs.themes.length);
  check(
    'a new account has not done the tutorial',
    prefs.preferences.tutorialDone === false,
    prefs.preferences,
  );

  const themed = await patch<{ preferences: { theme: string; sound: boolean } }>(
    '/preferences',
    { theme: 'neon' },
    players[0].session.tokens.accessToken,
  );
  check('a theme can be chosen', themed.preferences.theme === 'neon', themed.preferences);
  check('an omitted preference is left alone', themed.preferences.sound === true, themed.preferences);

  await post('/preferences/tutorial-complete', {}, players[0].session.tokens.accessToken);
  const afterTutorial = await get<{ preferences: { tutorialDone: boolean } }>(
    '/preferences',
    players[0].session.tokens.accessToken,
  );
  check(
    'finishing the tutorial is remembered',
    afterTutorial.preferences.tutorialDone === true,
    afterTutorial.preferences,
  );

  /* ------------------------------ notifications ----------------------------- */

  section('Notifications');
  const notifications = await get<{ notifications: Array<{ id: string }>; unread: number }>(
    '/notifications',
    players[0].session.tokens.accessToken,
  );
  check(
    'the match produced notifications',
    notifications.notifications.length > 0,
    notifications.notifications.length,
  );

  const readAll = await post<{ updated: number }>(
    '/notifications/read-all',
    {},
    players[0].session.tokens.accessToken,
  );
  check('everything can be marked read', readAll.updated >= 0, readAll);

  const afterRead = await get<{ unread: number }>(
    '/notifications/unread-count',
    players[0].session.tokens.accessToken,
  );
  check('the unread count clears', afterRead.unread === 0, afterRead);

  /* --------------------------------- search --------------------------------- */

  section('Search');
  const found = await get<{ players: unknown[]; items: unknown[]; total: number }>(
    `/search?q=${encodeURIComponent('classic')}`,
    players[0].session.tokens.accessToken,
  );
  check('search finds cosmetics by name', found.items.length > 0, found.items.length);

  const byName = await get<{ players: Array<{ id: string }> }>(
    `/search?q=${encodeURIComponent(players[1].session.user.username.slice(0, 6))}`,
    players[0].session.tokens.accessToken,
  );
  check('search finds the opponent', byName.players.length > 0, byName.players.length);

  /* -------------------------------- telemetry ------------------------------- */

  section('Telemetry');
  const sample = await post<{ ok: boolean }>(
    '/telemetry/perf',
    { platform: 'web', fpsAvg: 58.4, fpsMin: 41.2, jankRatio: 0.02, pingMs: 38, inMatch: true },
    players[0].session.tokens.accessToken,
  );
  check('a performance sample is accepted', sample.ok === true, sample);

  try {
    await post(
      '/telemetry/perf',
      { platform: 'web', fpsAvg: 9999, fpsMin: 1 },
      players[0].session.tokens.accessToken,
    );
    check('an impossible frame rate is rejected', false, 'it was accepted');
  } catch {
    check('an impossible frame rate is rejected', true);
  }

  /* --------------------------------- events --------------------------------- */

  section('Events');
  const events = await get<{ active: unknown[]; multipliers: { xp: number; coins: number } }>(
    '/events',
    players[0].session.tokens.accessToken,
  );
  check('event multipliers default to 1', events.multipliers.xp === 1, events.multipliers);

  /* ---------------------------------- store --------------------------------- */

  section('Store');
  const store = await get<{
    products: Array<{
      id: string;
      kind: string;
      priceMinor: number;
      grants: { coins?: number; gems?: number };
    }>;
    balances: { coins: number; gems: number };
    providers: string[];
  }>('/store', players[0].session.tokens.accessToken);

  check('the store has products', store.products.length > 0, store.products.length);
  check('a payment provider is available', store.providers.length > 0, store.providers);

  const gemPack = store.products.find((p) => p.kind === 'gem_pack');
  check('a gem pack is on sale', Boolean(gemPack), store.products.map((p) => p.id));

  if (gemPack) {
    const beforeGems = store.balances.gems;

    const checkout = await post<{ purchaseId: string; provider: string }>(
      '/store/checkout',
      { productId: gemPack.id, platform: 'web' },
      players[0].session.tokens.accessToken,
    );
    check('checkout opens an order', Boolean(checkout.purchaseId), checkout);

    // A receipt the server has not verified must never grant anything.
    try {
      await post(
        '/store/confirm',
        { purchaseId: checkout.purchaseId, receipt: 'i-promise-i-paid' },
        players[0].session.tokens.accessToken,
      );
      check('an unverifiable receipt is refused', false, 'it was accepted');
    } catch {
      check('an unverifiable receipt is refused', true);
    }

    // That failed attempt closes the order, so a fresh one is needed, which is
    // itself the behaviour we want.
    const second = await post<{ purchaseId: string }>(
      '/store/checkout',
      { productId: gemPack.id, platform: 'web' },
      players[0].session.tokens.accessToken,
    );

    const confirmed = await post<{ status: string; balances: { gems: number } }>(
      '/store/confirm',
      { purchaseId: second.purchaseId, receipt: `sandbox:${second.purchaseId}` },
      players[0].session.tokens.accessToken,
    );
    check('a verified purchase is granted', confirmed.status === 'granted', confirmed.status);
    check(
      'gems were credited',
      confirmed.balances.gems === beforeGems + (gemPack.grants.gems ?? 0),
      { before: beforeGems, after: confirmed.balances.gems, expected: gemPack.grants.gems },
    );

    const replayed = await post<{ status: string; alreadyGranted?: boolean }>(
      '/store/confirm',
      { purchaseId: second.purchaseId, receipt: `sandbox:${second.purchaseId}` },
      players[0].session.tokens.accessToken,
    );
    check('confirming twice grants only once', replayed.alreadyGranted === true, replayed);

    const wallet = await get<{ gems: number; gemHistory: unknown[] }>(
      '/store/wallet',
      players[0].session.tokens.accessToken,
    );
    check(
      'the gem ledger recorded the purchase',
      wallet.gemHistory.length > 0 && wallet.gems === confirmed.balances.gems,
      { gems: wallet.gems, entries: wallet.gemHistory.length },
    );
  }

  const adFree = store.products.find((p) => p.kind === 'ad_free');
  if (adFree) {
    const order = await post<{ purchaseId: string }>(
      '/store/checkout',
      { productId: adFree.id, platform: 'web' },
      players[1].session.tokens.accessToken,
    );
    await post(
      '/store/confirm',
      { purchaseId: order.purchaseId, receipt: `sandbox:${order.purchaseId}` },
      players[1].session.tokens.accessToken,
    );

    const bought = await get<{ enabled: boolean; adFree: boolean }>(
      '/ads/policy',
      players[1].session.tokens.accessToken,
    );
    check(
      'buying ad-free stops the ads',
      bought.adFree === true && bought.enabled === false,
      bought,
    );

    try {
      await post(
        '/store/checkout',
        { productId: adFree.id, platform: 'web' },
        players[1].session.tokens.accessToken,
      );
      check('a one-per-account product cannot be bought twice', false, 'it was allowed');
    } catch {
      check('a one-per-account product cannot be bought twice', true);
    }
  }

  /* ----------------------------------- ads ---------------------------------- */

  section('Advertising');
  const policy = await get<{ enabled: boolean; limits: Record<string, { perDay: number }> }>(
    '/ads/policy',
    players[0].session.tokens.accessToken,
  );
  check('ads are enabled for a free account', policy.enabled === true, policy.enabled);
  check(
    'interstitials are capped tighter than banners',
    policy.limits.interstitial.perDay < policy.limits.banner.perDay,
    policy.limits,
  );

  const rewarded = await get<{ ad: { impressionId: number } | null; reason?: string }>(
    '/ads/next?placement=rewarded&platform=web',
    players[0].session.tokens.accessToken,
  );
  check('a rewarded ad is served', Boolean(rewarded.ad), rewarded.reason);

  if (rewarded.ad) {
    // Completing straight away means the video did not play.
    try {
      await post(
        '/ads/complete',
        { impressionId: rewarded.ad.impressionId },
        players[0].session.tokens.accessToken,
      );
      check('an instantly-completed video pays nothing', false, 'it paid out');
    } catch {
      check('an instantly-completed video pays nothing', true);
    }
  }

  const secondRewarded = await get<{ ad: { impressionId: number } | null; reason?: string }>(
    '/ads/next?placement=rewarded&platform=web',
    players[0].session.tokens.accessToken,
  );
  check(
    'the minimum gap between rewarded ads is enforced',
    secondRewarded.ad === null && secondRewarded.reason === 'too_soon',
    secondRewarded.reason,
  );

  /* ---------------------------------- pass ---------------------------------- */

  section('Carrom Pass');
  const pass = await get<{
    pass: { tiers: number } | null;
    premium: boolean;
    tier: number;
    rewards: Array<{ tier: number; track: string; unlocked: boolean; claimed: boolean }>;
  }>('/pass', players[0].session.tokens.accessToken);

  check('a pass season is running', Boolean(pass.pass), pass);

  if (pass.pass) {
    check('the pass has fifty tiers', pass.pass.tiers === 50, pass.pass.tiers);
    check('a new account has not bought the pass', pass.premium === false, pass.premium);

    const premiumRewards = pass.rewards.filter((r) => r.track === 'premium');
    check(
      'premium rewards stay locked without the pass',
      premiumRewards.every((r) => !r.unlocked),
      premiumRewards.filter((r) => r.unlocked).length,
    );

    try {
      await post('/pass/claim', { tier: 1, track: 'premium' }, players[0].session.tokens.accessToken);
      check('the premium track refuses a free account', false, 'it paid out');
    } catch {
      check('the premium track refuses a free account', true);
    }

    try {
      await post('/pass/claim', { tier: 50, track: 'free' }, players[0].session.tokens.accessToken);
      check('an unreached tier cannot be claimed', false, 'it paid out');
    } catch {
      check('an unreached tier cannot be claimed', true);
    }
  }

  /* ------------------------------- promo codes ------------------------------ */

  section('Promo codes');
  try {
    await post(
      '/promos/redeem',
      { code: 'NOTAREALCODE' },
      players[0].session.tokens.accessToken,
    );
    check('an unknown promo code is refused', false, 'it was accepted');
  } catch {
    check('an unknown promo code is refused', true);
  }

  /* --------------------------------- teardown ------------------------------- */

  for (const player of players) player.socket.disconnect();

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nend-to-end run failed:', err);
  process.exit(1);
});
