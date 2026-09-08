/**
 * A four-player team match, played end to end.
 *
 * Two teams of two, partners sitting opposite, colours alternating round the
 * table. This is the seating arrangement nothing else exercises — every other
 * test plays two seats — so it is where a `% 2` that should be `% 4` would hide.
 *
 * Run with the API up:  npx tsx test/e2e-team.ts
 */
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import type { GameState, MatchResult, ShotBroadcast } from '@carrom/types';

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

async function call<T = any>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ ok: boolean; status: number; data: T }> {
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
    data = { raw: text.slice(0, 200) };
  }
  return { ok: res.ok, status: res.status, data: data as T };
}

interface Session {
  user: { id: string };
  profile: { coins: number; displayName: string; level: number };
  tokens: { accessToken: string; refreshToken: string };
}

let seq = 0;

async function guest(name: string): Promise<Session> {
  for (let attempt = 0; attempt < 10; attempt++) {
    seq += 1;
    const res = await call<Session>('POST', '/auth/guest', { displayName: `${name} ${seq}` });
    if (res.ok) return res.data;
    if ((res.data as any)?.code !== 'rate_limited') {
      throw new Error(`guest failed: ${JSON.stringify(res.data)}`);
    }
    await sleep(12_000);
  }
  throw new Error('guest sign-in kept hitting the rate limit');
}

function connect(token: string): Promise<Socket> {
  const socket = io(API, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket did not connect')), 10_000);
  });
}

const db = new pg.Client({ connectionString: DB });

async function main(): Promise<void> {
  await db.connect();

  section('Four players for a team match');

  const sessions: Session[] = [];
  for (const name of ['Team A', 'Team B', 'Team C', 'Team D']) {
    sessions.push(await guest(name));
  }

  // Team mode needs level 2, and guests start at level 1.
  await db.query('UPDATE profiles SET level = 5 WHERE user_id = ANY($1::uuid[])', [
    sessions.map((s) => s.user.id),
  ]);

  const sockets: Socket[] = [];
  for (const session of sessions) sockets.push(await connect(session.tokens.accessToken));
  check('four players connected', sockets.length === 4);

  const starts = sockets.map(
    (socket) =>
      new Promise<{ state: GameState } | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), 40_000);
        socket.once('game:start', (payload: { state: GameState }) => {
          clearTimeout(timer);
          resolve(payload);
        });
      }),
  );

  section('Matchmaking a 2v2');

  for (const socket of sockets) {
    socket.emit('lobby:quickMatch', { modeId: 'team', tierId: 'beginner' });
    await sleep(250);
  }

  const results = await Promise.all(starts);
  const started = results.filter(Boolean) as Array<{ state: GameState }>;
  check('all four are seated at one table', started.length === 4, started.length);

  if (started.length !== 4) {
    for (const socket of sockets) socket.disconnect();
    await db.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }

  const opening = started[0]!.state;

  check('the table has four seats', opening.players.length === 4, opening.players.length);
  check('the board is a four-player table', opening.size === '4p', opening.size);
  check('the pot holds four entry fees', opening.pot === 800, opening.pot);

  // Partners sit opposite: seats 0 and 2 are one colour, 1 and 3 the other.
  const bySeat = [...opening.players].sort((a, b) => a.seat - b.seat);
  check(
    'colours alternate round the table',
    bySeat[0]!.color === bySeat[2]!.color && bySeat[1]!.color === bySeat[3]!.color,
    bySeat.map((p) => `${p.seat}:${p.color}`),
  );
  check(
    'the two teams are different colours',
    bySeat[0]!.color !== bySeat[1]!.color,
    bySeat.map((p) => `${p.seat}:${p.color}`),
  );

  /* --------------------------------- play --------------------------------- */

  section('Playing it out');

  const byUser = new Map(sessions.map((s, i) => [s.user.id, sockets[i]!]));
  let live: GameState = opening;
  const seenTurns = new Set<number>();

  const result = new Promise<MatchResult | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 200_000);
    sockets[0]!.once('game:over', (payload: MatchResult) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });

  for (const socket of sockets) {
    socket.on('game:shot', (payload: ShotBroadcast) => {
      live = payload.state;
    });
    socket.on('game:timeout', (payload: { state: GameState }) => {
      live = payload.state;
    });
  }

  let shots = 0;
  const deadline = Date.now() + 190_000;

  while (live.status === 'playing' && Date.now() < deadline && shots < 500) {
    seenTurns.add(live.turnSeat);

    const seat = live.players.find((p) => p.seat === live.turnSeat);
    const socket = seat ? byUser.get(seat.userId) : undefined;
    if (!socket) break;

    // Each side of the table shoots inward, so aim from that seat's own base.
    const spot =
      live.turnSeat === 0
        ? { x: 400, y: 690 }
        : live.turnSeat === 1
          ? { x: 690, y: 400 }
          : live.turnSeat === 2
            ? { x: 400, y: 110 }
            : { x: 110, y: 400 };

    const target = live.bodies
      .filter((b) => b.kind !== 'striker' && !b.pocketed)
      .sort(
        (a, b) => Math.hypot(a.x - spot.x, a.y - spot.y) - Math.hypot(b.x - spot.x, b.y - spot.y),
      )[0];

    const angle = target
      ? Math.atan2(target.y - spot.y, target.x - spot.x) + (Math.random() - 0.5) * 0.2
      : Math.atan2(400 - spot.y, 400 - spot.x);

    const seq0 = live.seq;
    socket.emit('game:shot', { shot: { pos: 0.5, angle, power: 0.6 + Math.random() * 0.3 } });
    shots += 1;

    const until = Date.now() + 4_000;
    while (live.seq === seq0 && live.status === 'playing' && Date.now() < until) {
      await sleep(120);
    }
    await sleep(300);
  }

  check('every seat took a turn', seenTurns.size === 4, [...seenTurns].sort());

  const finished = await result;
  check('the team match reaches a conclusion', Boolean(finished), `${shots} shots`);

  if (finished) {
    check('all four players are rewarded', Object.keys(finished.rewards).length === 4, finished.rewards);

    const winners = Object.values(finished.rewards).filter((r: any) => r.won);
    const losers = Object.values(finished.rewards).filter((r: any) => !r.won);
    check('two players win', winners.length === 2, winners.length);
    check('two players lose', losers.length === 2, losers.length);

    check(
      'both winners are paid',
      winners.every((r: any) => r.coins > 0),
      winners.map((r: any) => r.coins),
    );
    check(
      'neither loser is paid',
      losers.every((r: any) => r.coins === 0),
      losers.map((r: any) => r.coins),
    );

    const paid = winners.reduce((sum, r: any) => sum + r.coins, 0);
    check('the pot is shared, not doubled', paid <= 800, { paid, pot: 800 });
  }

  /* ------------------------------ ledger audit ---------------------------- */

  section('Ledger integrity');

  const drift = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM (
       SELECT p.user_id
         FROM profiles p
         LEFT JOIN coin_ledger l ON l.user_id = p.user_id
        GROUP BY p.user_id, p.coins
       HAVING p.coins <> COALESCE(SUM(l.delta), 0)
     ) d`,
  );
  check('every balance still equals its ledger', Number(drift.rows[0]?.n) === 0, drift.rows[0]);

  for (const socket of sockets) socket.disconnect();
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
