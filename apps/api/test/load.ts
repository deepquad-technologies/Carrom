/**
 * Concurrent-load check.
 *
 * Runs many matches at once — human-versus-human boards plus bot boards, since
 * the bot's shot search is the only genuinely CPU-hungry thing on the server —
 * and measures whether the game stays responsive while they all play.
 *
 * What it is actually asking: does a bot thinking on one table slow down
 * somebody's shot on another? The search yields between batches specifically so
 * that it does not, and this is the test of that claim.
 *
 *   npx tsx test/load.ts               # 12 human boards, 6 bot boards
 *   MATCHES=20 BOTS=10 npx tsx test/load.ts
 */
import pg from 'pg';
import { io, type Socket } from 'socket.io-client';
import type { GameState, ShotBroadcast } from '@carrom/types';

const API = process.env.API_URL ?? 'http://localhost:4000';
const DB = process.env.DATABASE_URL ?? 'postgres://carrom:carrom@localhost:5432/carrom';

const HUMAN_MATCHES = Number(process.env.MATCHES ?? 12);
const BOT_MATCHES = Number(process.env.BOTS ?? 6);
const RUN_MS = Number(process.env.RUN_MS ?? 60_000);

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
  user: { id: string };
  profile: { coins: number };
  tokens: { accessToken: string };
}

let seq = 0;

/**
 * Guests, respecting the auth rate limiter.
 *
 * Twelve accounts a minute per IP is the real production limit, so a large run
 * spends a couple of minutes here. That is the limiter working, not a problem
 * to route around.
 */
async function guest(): Promise<Session> {
  for (let attempt = 0; attempt < 12; attempt++) {
    seq += 1;
    const res = await call<Session>('POST', '/auth/guest', { displayName: `Load ${seq}` });
    if (res.ok) return res.data;
    if ((res.data as any)?.code !== 'rate_limited') {
      throw new Error(`guest failed: ${JSON.stringify(res.data)}`);
    }
    await sleep(11_000);
  }
  throw new Error('guest sign-in kept hitting the rate limit');
}

function connect(token: string): Promise<Socket> {
  const socket = io(API, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket did not connect')), 15_000);
  });
}

const db = new pg.Client({ connectionString: DB });

/* ----------------------------- one player ---------------------------------- */

interface Runner {
  socket: Socket;
  userId: string;
  live: GameState | null;
  /** Milliseconds from emitting a shot to seeing it come back. */
  latencies: number[];
  shots: number;
  errors: number;
  /** Why shots were refused, so an unconfirmed shot is explained not assumed. */
  errorCodes: Map<string, number>;
  finished: boolean;
}

function attach(runner: Runner): void {
  let pendingAt = 0;

  runner.socket.on('game:start', (payload: { state: GameState }) => {
    runner.live = payload.state;
  });
  runner.socket.on('game:shot', (payload: ShotBroadcast) => {
    runner.live = payload.state;
    if (pendingAt > 0) {
      runner.latencies.push(Date.now() - pendingAt);
      pendingAt = 0;
    }
  });
  runner.socket.on('game:timeout', (payload: { state: GameState }) => {
    runner.live = payload.state;
    pendingAt = 0;
  });
  runner.socket.on('game:over', () => {
    runner.live = null;
    runner.finished = true;
    pendingAt = 0;
  });
  runner.socket.on('game:error', (payload: { code?: string }) => {
    runner.errors += 1;
    const code = payload?.code ?? 'unknown';
    runner.errorCodes.set(code, (runner.errorCodes.get(code) ?? 0) + 1);
    pendingAt = 0;
  });

  runner.shoot = () => {
    pendingAt = Date.now();
  };
}

/** Extra field assigned by attach(); declared separately to keep the shape flat. */
interface Runner {
  shoot?: () => void;
}

function aimedShot(live: GameState, seatIndex: number) {
  const spot =
    seatIndex === 0
      ? { x: 400, y: 690 }
      : seatIndex === 1
        ? { x: 690, y: 400 }
        : seatIndex === 2
          ? { x: 400, y: 110 }
          : { x: 110, y: 400 };

  const target = live.bodies
    .filter((b) => b.kind !== 'striker' && !b.pocketed)
    .sort(
      (a, b) => Math.hypot(a.x - spot.x, a.y - spot.y) - Math.hypot(b.x - spot.x, b.y - spot.y),
    )[0];

  const angle = target
    ? Math.atan2(target.y - spot.y, target.x - spot.x) + (Math.random() - 0.5) * 0.25
    : Math.atan2(400 - spot.y, 400 - spot.x);

  return { pos: 0.5, angle, power: 0.6 + Math.random() * 0.3 };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

async function main(): Promise<void> {
  await db.connect();

  const totalPlayers = HUMAN_MATCHES * 2 + BOT_MATCHES;
  console.log(
    `Load check: ${HUMAN_MATCHES} human boards, ${BOT_MATCHES} bot boards, ` +
      `${totalPlayers} accounts, ${RUN_MS / 1000}s of play\n`,
  );

  console.log('Creating accounts (the auth limiter allows twelve a minute)…');
  const runners: Runner[] = [];
  for (let i = 0; i < totalPlayers; i++) {
    const session = await guest();
    const socket = await connect(session.tokens.accessToken);
    const runner: Runner = {
      socket,
      userId: session.user.id,
      live: null,
      latencies: [],
      shots: 0,
      errors: 0,
      errorCodes: new Map(),
      finished: false,
    };
    attach(runner);
    runners.push(runner);
    if ((i + 1) % 6 === 0) console.log(`  ${i + 1}/${totalPlayers}`);
  }

  console.log('\nStarting matches…');

  // Human boards: pair them up two at a time.
  const humans = runners.slice(0, HUMAN_MATCHES * 2);
  for (let i = 0; i < humans.length; i += 2) {
    humans[i]!.socket.emit('lobby:quickMatch', { modeId: 'quick', tierId: 'beginner' });
    await sleep(120);
    humans[i + 1]!.socket.emit('lobby:quickMatch', { modeId: 'quick', tierId: 'beginner' });
    await sleep(120);
  }

  // Bot boards: the CPU-hungry ones.
  const botPlayers = runners.slice(HUMAN_MATCHES * 2);
  for (const runner of botPlayers) {
    runner.socket.emit('lobby:playBot', { skill: 'hard' });
    await sleep(150);
  }

  await sleep(3_000);

  const seated = runners.filter((r) => r.live !== null).length;
  check('every player is seated at a board', seated === totalPlayers, {
    seated,
    expected: totalPlayers,
  });

  /* ------------------------------- play hard ------------------------------ */

  console.log('\nPlaying…');
  const startedAt = Date.now();
  let tick = 0;

  while (Date.now() - startedAt < RUN_MS) {
    for (const runner of runners) {
      const live = runner.live;
      if (!live || live.status !== 'playing') continue;

      const seat = live.players.find((p) => p.userId === runner.userId);
      if (!seat || live.turnSeat !== seat.seat) continue;

      runner.shoot?.();
      runner.socket.emit('game:shot', { shot: aimedShot(live, seat.seat) });
      runner.shots += 1;
    }

    // The anti-cheat rejects shots closer together than 250ms, so this cadence
    // is the fastest a legitimate client could ever play.
    await sleep(320);

    tick += 1;
    if (tick % 30 === 0) {
      const playing = runners.filter((r) => r.live?.status === 'playing').length;
      const done = runners.filter((r) => r.finished).length;
      console.log(`  ${Math.round((Date.now() - startedAt) / 1000)}s · playing ${playing} · finished ${done}`);
    }
  }

  /* ------------------------------- the numbers ---------------------------- */

  const latencies = runners.flatMap((r) => r.latencies);
  const shots = runners.reduce((sum, r) => sum + r.shots, 0);
  const errors = runners.reduce((sum, r) => sum + r.errors, 0);
  const finished = runners.filter((r) => r.finished).length;

  console.log('\nResults');
  console.log(`  shots sent        ${shots}`);
  console.log(`  shots confirmed   ${latencies.length}`);
  console.log(`  boards finished   ${finished}`);
  console.log(`  socket errors     ${errors}`);
  console.log(`  latency p50       ${percentile(latencies, 0.5)}ms`);
  console.log(`  latency p95       ${percentile(latencies, 0.95)}ms`);
  console.log(`  latency p99       ${percentile(latencies, 0.99)}ms`);
  console.log(`  latency max       ${Math.max(0, ...latencies)}ms`);

  const codes = new Map<string, number>();
  for (const runner of runners) {
    for (const [code, count] of runner.errorCodes) {
      codes.set(code, (codes.get(code) ?? 0) + count);
    }
  }
  if (codes.size > 0) {
    console.log('');
    console.log('  Refused shots, by reason:');
    for (const [code, count] of [...codes].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${code.padEnd(18)} ${count}`);
    }
  }

  console.log('');
  check('shots were confirmed, not swallowed', latencies.length > shots * 0.5, {
    sent: shots,
    confirmed: latencies.length,
  });

  // The bar that matters: a shot must feel immediate even with every board busy
  // and several bots searching at once.
  check('the median shot is confirmed inside 250ms', percentile(latencies, 0.5) < 250, {
    p50: percentile(latencies, 0.5),
  });
  check('95% of shots are confirmed inside 1s', percentile(latencies, 0.95) < 1_000, {
    p95: percentile(latencies, 0.95),
  });
  check('no shot took longer than 5s', Math.max(0, ...latencies) < 5_000, {
    max: Math.max(0, ...latencies),
  });

  const health = await call('GET', '/health');
  check('the server is still healthy', health.ok, health.status);

  // Every refusal must be one of the guards we expect. An unexplained refusal
  // under load is the thing worth catching here.
  const expected = new Set(['too_fast', 'invalid_shot', 'rate_limited', 'no_match', 'no_seat']);
  const unexpected = [...codes.keys()].filter((code) => !expected.has(code));
  check('every refused shot has a known reason', unexpected.length === 0, unexpected);

  /* ------------------------------ ledger audit ---------------------------- */

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

  const negative = await db.query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM profiles WHERE coins < 0',
  );
  check('no balance went negative under load', Number(negative.rows[0]?.n) === 0, negative.rows[0]);

  for (const runner of runners) {
    runner.socket.emit('room:leave');
    runner.socket.disconnect();
  }
  await db.end();

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nload run failed:', err);
  await db.end().catch(() => undefined);
  process.exit(1);
});
