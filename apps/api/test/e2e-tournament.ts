/**
 * A tournament, played end to end.
 *
 * Four players register, the bracket starts, the server seats each pairing on
 * its own, the matches are played out over real sockets, the bracket advances,
 * and one player is left holding the prize pool.
 *
 * This is the path that was written but never wired: the bracket existed and
 * `reportTournamentResult` existed, but nothing connected a finished board back
 * to the slot it was played for, so every tournament stalled after round one.
 *
 * Run with the API up:  npx tsx test/e2e-tournament.ts
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
  user: { id: string; username: string };
  profile: { coins: number; displayName: string };
  tokens: { accessToken: string; refreshToken: string };
}

let seq = 0;

/** Guests, spaced out enough not to trip the auth rate limiter. */
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

interface Player {
  session: Session;
  socket: Socket;
  /** The board this player is currently sitting at, if any. */
  live: GameState | null;
}

async function main(): Promise<void> {
  await db.connect();

  /* ------------------------------ four players ---------------------------- */

  section('Setting up four players');

  const players: Player[] = [];
  for (const name of ['Cup A', 'Cup B', 'Cup C', 'Cup D']) {
    const session = await guest(name);
    const socket = await connect(session.tokens.accessToken);
    players.push({ session, socket, live: null });
  }
  check('four players are connected', players.length === 4);

  // Every player needs enough for the entry fee.
  const ENTRY = 200;
  for (const player of players) {
    check(
      `${player.session.profile.displayName} can afford the entry`,
      player.session.profile.coins >= ENTRY,
      player.session.profile.coins,
    );
  }

  /* -------------------------------- the cup ------------------------------- */

  section('Creating the tournament');

  const organiser = await guest('Cup Organiser');
  await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [organiser.user.id]);
  const promoted = await call<{ tokens: { accessToken: string } }>('POST', '/auth/refresh', {
    refreshToken: organiser.tokens.refreshToken,
  });
  const adminToken = promoted.data.tokens.accessToken;

  const created = await call<{ tournamentId: string }>(
    'POST',
    '/tournaments',
    {
      name: `Bracket Test ${Date.now().toString().slice(-5)}`,
      entryCoins: ENTRY,
      maxPlayers: 4,
      tierId: 'beginner',
      timerPreset: 'quick',
      startsAt: new Date(Date.now() + 60_000).toISOString(),
    },
    adminToken,
  );
  check('the tournament is created', created.ok, created.data);
  const cupId = created.data.tournamentId;

  /* ------------------------------ registration ---------------------------- */

  section('Registration');

  const before: Record<string, number> = {};
  for (const player of players) {
    const me = await call('GET', '/profile/me', undefined, player.session.tokens.accessToken);
    before[player.session.user.id] = me.data.profile.coins;

    const reg = await call(
      'POST',
      `/tournaments/${cupId}/register`,
      {},
      player.session.tokens.accessToken,
    );
    check(`${player.session.profile.displayName} registers`, reg.ok, reg.data);
  }

  const afterRegister = await call('GET', `/tournaments/${cupId}`, undefined, adminToken);
  check('four players are entered', afterRegister.data.players?.length === 4, afterRegister.data.players?.length);
  check(
    'the prize pool holds every entry',
    Number(afterRegister.data.tournament?.prize_pool) === ENTRY * 4,
    afterRegister.data.tournament?.prize_pool,
  );

  for (const player of players) {
    const me = await call('GET', '/profile/me', undefined, player.session.tokens.accessToken);
    check(
      `${player.session.profile.displayName} paid the entry once`,
      me.data.profile.coins === before[player.session.user.id]! - ENTRY,
      { before: before[player.session.user.id], after: me.data.profile.coins },
    );
  }

  /* --------------------------------- start -------------------------------- */

  section('Starting the bracket');

  const started = await call('POST', `/tournaments/${cupId}/start`, {}, adminToken);
  check('the tournament starts', started.ok, started.data);

  const bracket = await call('GET', `/tournaments/${cupId}`, undefined, adminToken);
  check('a bracket exists', bracket.data.matches?.length > 0, bracket.data.matches?.length);
  check(
    'round one has two pairings',
    bracket.data.matches.filter((m: any) => m.round === 1).length === 2,
    bracket.data.matches.filter((m: any) => m.round === 1).length,
  );

  /* ------------------------- play the whole bracket ----------------------- */

  section('Playing the bracket out');

  // Track whatever board each player is sitting at, and play it.
  for (const player of players) {
    player.socket.on('game:start', (payload: { state: GameState }) => {
      player.live = payload.state;
    });
    player.socket.on('game:shot', (payload: ShotBroadcast) => {
      player.live = payload.state;
    });
    player.socket.on('game:timeout', (payload: { state: GameState }) => {
      player.live = payload.state;
    });
    player.socket.on('game:over', () => {
      player.live = null;
    });
  }

  let seatedMatches = 0;
  const deadline = Date.now() + 300_000;
  let champion: string | null = null;

  while (Date.now() < deadline) {
    // Anybody whose turn it is takes a shot, aimed at the nearest man.
    for (const player of players) {
      const live = player.live;
      if (!live || live.status !== 'playing') continue;

      const seat = live.players.find((p) => p.userId === player.session.user.id);
      if (!seat || live.turnSeat !== seat.seat) continue;

      const spot = { x: 400, y: seat.seat === 0 ? 690 : 110 };
      const target = live.bodies
        .filter((b) => b.kind !== 'striker' && !b.pocketed)
        .sort(
          (a, b) =>
            Math.hypot(a.x - spot.x, a.y - spot.y) - Math.hypot(b.x - spot.x, b.y - spot.y),
        )[0];

      const angle = target
        ? Math.atan2(target.y - spot.y, target.x - spot.x) + (Math.random() - 0.5) * 0.2
        : seat.seat === 0
          ? -Math.PI / 2
          : Math.PI / 2;

      player.socket.emit('game:shot', {
        shot: { pos: 0.5, angle, power: 0.6 + Math.random() * 0.3 },
      });
    }

    await sleep(320);

    const state = await db.query<{ status: string; winner_user_id: string | null; running: string; finished: string }>(
      `SELECT t.status, t.winner_user_id,
              (SELECT COUNT(*)::text FROM tournament_matches m
                WHERE m.tournament_id = t.id AND m.status = 'running')  AS running,
              (SELECT COUNT(*)::text FROM tournament_matches m
                WHERE m.tournament_id = t.id AND m.status = 'finished') AS finished
         FROM tournaments t WHERE t.id = $1`,
      [cupId],
    );
    const row = state.rows[0]!;
    seatedMatches = Math.max(seatedMatches, Number(row.finished));

    if (row.status === 'finished') {
      champion = row.winner_user_id;
      break;
    }
  }

  check('the bracket advanced past round one', seatedMatches >= 2, { finished: seatedMatches });
  check('the tournament finished', champion !== null, { champion, finished: seatedMatches });

  /* -------------------------------- the prize ----------------------------- */

  if (champion) {
    section('The champion');

    const winner = players.find((p) => p.session.user.id === champion);
    check('the champion is one of the entrants', Boolean(winner), champion);

    const finalState = await call('GET', `/tournaments/${cupId}`, undefined, adminToken);
    check(
      'the bracket is fully played',
      finalState.data.matches.every((m: any) => m.status === 'finished' || m.status === 'bye'),
      finalState.data.matches.map((m: any) => `${m.round}.${m.slot}:${m.status}`),
    );

    const first = finalState.data.players.find((p: any) => p.final_position === 1);
    check('a first place is recorded', Boolean(first), finalState.data.players);

    if (winner) {
      const me = await call('GET', '/profile/me', undefined, winner.session.tokens.accessToken);
      const paidOut = me.data.profile.coins - (before[winner.session.user.id]! - ENTRY);
      check('the champion is paid the prize pool', paidOut > 0, {
        paidOut,
        pool: ENTRY * 4,
      });
    }

    // Nobody should have been charged a second entry for playing a bracket match.
    const doubleCharged = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM coin_ledger
        WHERE reason = 'entry' AND user_id = ANY($1::uuid[])`,
      [players.map((p) => p.session.user.id)],
    );
    check(
      'no bracket match charged a second entry',
      Number(doubleCharged.rows[0]?.n) === 0,
      doubleCharged.rows[0],
    );
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

  for (const player of players) player.socket.disconnect();
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
