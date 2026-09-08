/**
 * End-to-end checks for the bot opponent and friend gifting.
 *
 * Both features are about things that must not go wrong quietly: a bot that
 * silently stops taking its turn looks like a frozen game, and a gift that
 * pays twice mints coins. So these run against a live API and a live database,
 * not against mocks.
 *
 * Run with the API up:  npx tsx test/e2e-bots.ts
 */
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import type { GameState, ShotBroadcast } from '@carrom/types';

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
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data as T;
}

interface Session {
  user: { id: string; username: string };
  profile: { coins: number; displayName: string };
  tokens: { accessToken: string; refreshToken: string };
}

async function register(tag: string): Promise<Session> {
  const username = `${tag}${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 90 + 10)}`;
  return post<Session>('/auth/register', {
    email: `${username}@example.test`,
    password: 'BotTestPassword123!',
    username,
  });
}

function connect(token: string): Promise<Socket> {
  const socket = io(API, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket did not connect')), 8_000);
  });
}

function waitFor<T>(socket: Socket, event: string, ms: number): Promise<T | null> {
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

const db = new pg.Client({ connectionString: DB });

async function main(): Promise<void> {
  await db.connect();

  /* ------------------------------ bot roster ------------------------------ */

  section('Bot roster');
  const roster = await db.query<{ skill: string; n: string }>(
    'SELECT skill, COUNT(*)::text AS n FROM bot_accounts WHERE active GROUP BY skill ORDER BY skill',
  );
  const bySkill = Object.fromEntries(roster.rows.map((r) => [r.skill, Number(r.n)]));
  check('all three difficulties have bots',
    Number(bySkill.easy) > 0 && Number(bySkill.medium) > 0 && Number(bySkill.hard) > 0,
    bySkill);

  const float = await db.query<{ ok: boolean }>(
    `SELECT bool_and(p.coins = t.total) AS ok
       FROM profiles p
       JOIN bot_accounts b ON b.user_id = p.user_id
       JOIN (SELECT user_id, SUM(delta) AS total FROM coin_ledger GROUP BY user_id) t
         ON t.user_id = p.user_id`,
  );
  check('bot balances come entirely from the ledger', float.rows[0]?.ok === true, float.rows[0]);

  /* --------------------------- practice vs a bot -------------------------- */

  for (const skill of ['easy', 'medium', 'hard'] as const) {
    section(`Practice against a ${skill} bot`);

    const player = await register(`botp${skill[0]}`);
    const socket = await connect(player.tokens.accessToken);

    socket.emit('lobby:playBot', { skill });

    const start = await waitFor<{ state: GameState }>(socket, 'game:start', 12_000);
    check(`a ${skill} match starts`, Boolean(start), 'no game:start');

    if (!start) {
      socket.disconnect();
      continue;
    }

    const room = await new Promise<{ players: Array<{ isBot: boolean; botSkill: string | null; displayName: string }> } | null>(
      (resolve) => {
        socket.emit('room:state');
        setTimeout(() => resolve(null), 500);
      },
    ).catch(() => null);
    void room;

    const bot = start.state.players.find((p) => p.userId !== player.user.id);
    check(`the ${skill} bot is seated opposite`, Boolean(bot), start.state.players.length);

    // Whoever leads, a bot turn must produce a shot without any prompting.
    let botShots = 0;
    let humanTurns = 0;

    const onShot = (b: ShotBroadcast) => {
      const shooter = start.state.players.find((p) => p.seat === b.seat);
      if (shooter && shooter.userId !== player.user.id) botShots += 1;
    };
    socket.on('game:shot', onShot);

    // Play a handful of turns: whenever it is our turn, take a plain shot.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && botShots < 3) {
      await new Promise((r) => setTimeout(r, 600));

      const live = await get<{ room: { players: unknown[] } } | null>(
        `/profile/me`,
        player.tokens.accessToken,
      ).catch(() => null);
      void live;

      // Fire a legal shot; the server ignores it when it is not our turn.
      socket.emit('game:shot', { shot: { pos: 0.5, angle: -Math.PI / 2, power: 0.6 } });
      humanTurns += 1;
      if (humanTurns > 40) break;
    }

    socket.off('game:shot', onShot);
    check(`the ${skill} bot takes its own turns`, botShots >= 1, { botShots });

    socket.emit('room:leave');
    socket.disconnect();
  }

  /* ------------------------- matchmaking fallback ------------------------- */

  section('Matchmaking falls back to a bot');
  const waiter = await register('botq');
  const waiterSocket = await connect(waiter.tokens.accessToken);

  waiterSocket.emit('lobby:quickMatch', { modeId: 'quick', tierId: 'beginner' });
  const queued = await waitFor<{ waiting: number }>(waiterSocket, 'lobby:queued', 5_000);
  check('the player is queued when nobody is waiting', Boolean(queued), queued);

  // The fallback fires after ~12 seconds; allow generous slack for a slow tick.
  const fallback = await waitFor<{ state: GameState }>(waiterSocket, 'game:start', 30_000);
  check('a bot is seated after the wait', Boolean(fallback), 'no game:start within 30s');

  if (fallback) {
    const opponent = fallback.state.players.find((p) => p.userId !== waiter.user.id);
    check('the fallback opponent exists', Boolean(opponent), fallback.state.players.length);

    const isBot = opponent
      ? (
          await db.query('SELECT 1 FROM bot_accounts WHERE user_id = $1', [opponent.userId])
        ).rowCount === 1
      : false;
    check('the fallback opponent is a bot', isBot);

    // A staked bot match must move coins, never mint them.
    const pot = fallback.state.pot;
    check('the bot paid into the pot', pot > 0, { pot });
  }

  waiterSocket.emit('room:leave');
  waiterSocket.disconnect();

  /* -------------------------------- gifting ------------------------------- */

  section('Friend gifts');

  const giver = await register('gifta');
  const taker = await register('giftb');

  // Become friends, backdated so the anti-farming age gate is satisfied.
  await post('/social/requests', { userId: taker.user.id }, giver.tokens.accessToken);
  const incoming = await get<{ incoming: Array<{ id: string }> }>(
    '/social/requests',
    taker.tokens.accessToken,
  );
  await post(
    `/social/requests/${incoming.incoming[0]!.id}/accept`,
    {},
    taker.tokens.accessToken,
  );
  await db.query(
    "UPDATE friends SET created_at = now() - INTERVAL '3 days' WHERE user_id = $1 OR friend_id = $1",
    [giver.user.id],
  );

  const eligible = await get<{ canSendToday: boolean; friends: Array<{ eligible: boolean }> }>(
    '/gifts/eligible',
    giver.tokens.accessToken,
  );
  check('the friend shows as giftable', eligible.friends.some((f) => f.eligible), eligible.friends);
  check('a gift is available today', eligible.canSendToday === true, eligible.canSendToday);

  const beforeGiver = (await get<{ profile: { coins: number } }>('/profile/me', giver.tokens.accessToken)).profile.coins;
  const beforeTaker = (await get<{ profile: { coins: number } }>('/profile/me', taker.tokens.accessToken)).profile.coins;

  const AMOUNT = 500;
  const gift = await post<{ ok: boolean; balance: number }>(
    '/gifts',
    { userId: taker.user.id, amount: AMOUNT },
    giver.tokens.accessToken,
  );
  check('the gift is accepted', gift.ok === true, gift);

  const afterGiver = (await get<{ profile: { coins: number } }>('/profile/me', giver.tokens.accessToken)).profile.coins;
  const afterTaker = (await get<{ profile: { coins: number } }>('/profile/me', taker.tokens.accessToken)).profile.coins;

  check('the sender is debited', afterGiver === beforeGiver - AMOUNT, { beforeGiver, afterGiver });
  check('the recipient is credited', afterTaker === beforeTaker + AMOUNT, { beforeTaker, afterTaker });
  check(
    'no coins were created',
    afterGiver + afterTaker === beforeGiver + beforeTaker,
    { before: beforeGiver + beforeTaker, after: afterGiver + afterTaker },
  );

  try {
    await post('/gifts', { userId: taker.user.id, amount: AMOUNT }, giver.tokens.accessToken);
    check('a second gift the same day is refused', false, 'it went through');
  } catch {
    check('a second gift the same day is refused', true);
  }

  // A guest must not be able to gift at all — that is the alt-account defence.
  const guest = await post<Session>('/auth/guest', { displayName: 'Gift Guest' });
  try {
    await post('/gifts', { userId: taker.user.id, amount: AMOUNT }, guest.tokens.accessToken);
    check('a guest cannot gift', false, 'it went through');
  } catch {
    check('a guest cannot gift', true);
  }

  // And a stranger is not giftable.
  const stranger = await register('giftc');
  try {
    await post('/gifts', { userId: stranger.user.id, amount: AMOUNT }, taker.tokens.accessToken);
    check('a non-friend cannot be gifted', false, 'it went through');
  } catch {
    check('a non-friend cannot be gifted', true);
  }

  // Amount bounds.
  for (const [label, amount] of [['below the minimum', 1], ['above the maximum', 10_000_000]] as const) {
    try {
      await post('/gifts', { userId: giver.user.id, amount }, taker.tokens.accessToken);
      check(`an amount ${label} is refused`, false, amount);
    } catch {
      check(`an amount ${label} is refused`, true);
    }
  }

  /* ------------------------------ ledger audit ---------------------------- */

  section('Ledger integrity after gifts and bot matches');
  const drift = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT p.user_id
         FROM profiles p
         LEFT JOIN coin_ledger l ON l.user_id = p.user_id
        GROUP BY p.user_id, p.coins
       HAVING p.coins <> COALESCE(SUM(l.delta), 0)
     ) d`,
  );
  check('every balance still equals its ledger', Number(drift.rows[0]?.n ?? 1) === 0, drift.rows[0]);

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
