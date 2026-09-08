import {
  DEFAULT_TIER_ID, MAX_SHOT_SPEED, MAX_TURNS_PER_BOARD, MIN_SHOT_SPEED, PIECES_PER_SIDE,
  QUEEN_POINTS, SHOT_LIMITS, TIMERS, tierById,
} from '@carrom/config';
import { createBodies, findFreeSpot, simulate } from '@carrom/physics';
import type {
  Body, Color, FoulReason, GamePlayer, GameState, Shot, ShotSummary, TableSize,
} from '@carrom/types';
import {
  clampAimAngle, colorOfSeat, normalOfSide, otherColor, seatCount, sideOfSeat, strikerSpot,
} from './seating';

export interface CreateGameOptions {
  matchId: string;
  modeId: string;
  tierId?: string;
  boardId?: string;
  size: TableSize;
  players: GamePlayer[];
  turnSeconds?: number;
  /** Practice and daily-challenge boards are played for no stake. */
  staked?: boolean;
}

export function createGame(opts: CreateGameOptions): GameState {
  const tier = tierById(opts.tierId) ?? tierById(DEFAULT_TIER_ID)!;
  const entry = opts.staked === false ? 0 : tier.entry;
  return {
    matchId: opts.matchId,
    modeId: opts.modeId,
    tierId: tier.id,
    boardId: opts.boardId ?? tier.boardId,
    size: opts.size,
    bodies: createBodies(),
    players: opts.players,
    turnSeat: 0,
    seq: 0,
    serverTime: Date.now(),
    queenPending: null,
    queenOwner: null,
    due: { white: 0, black: 0 },
    status: 'playing',
    winner: null,
    points: 0,
    turnCount: 0,
    entry,
    pot: entry * opts.players.length,
    turnSeconds: opts.turnSeconds ?? TIMERS.classic.turnSeconds,
  };
}

export function remaining(state: GameState, color: Color): number {
  return state.bodies.filter((b) => b.kind === color && !b.pocketed).length;
}

export function pocketedCount(state: GameState, color: Color): number {
  return PIECES_PER_SIDE - remaining(state, color);
}

export interface ShotValidation {
  ok: boolean;
  reason?: string;
}

/**
 * Reject anything a legitimate client could not have sent. The server calls
 * this before touching the board, so a tampered client gets nowhere.
 */
export function validateShot(state: GameState, seat: number, shot: unknown): ShotValidation {
  if (state.status !== 'playing') return { ok: false, reason: 'The match is not in play' };
  if (state.turnSeat !== seat) return { ok: false, reason: 'It is not your turn' };
  if (typeof shot !== 'object' || shot === null) return { ok: false, reason: 'Malformed shot' };

  const { pos, angle, power } = shot as Partial<Shot>;
  for (const [name, value] of Object.entries({ pos, angle, power })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false, reason: `Shot ${name} is not a number` };
    }
  }
  const p = pos as number;
  const a = angle as number;
  const w = power as number;

  if (p < SHOT_LIMITS.posMin || p > SHOT_LIMITS.posMax) {
    return { ok: false, reason: 'Striker is off the base line' };
  }
  if (w < SHOT_LIMITS.powerMin || w > SHOT_LIMITS.powerMax) {
    return { ok: false, reason: 'Shot power is out of range' };
  }
  if (a < SHOT_LIMITS.angleMin || a > SHOT_LIMITS.angleMax) {
    return { ok: false, reason: 'Aim angle is out of range' };
  }
  return { ok: true };
}

/** Turn a validated shot into striker placement plus launch velocity. */
export function resolveShot(state: GameState, shot: Shot): {
  x: number; y: number; vx: number; vy: number;
} {
  const side = sideOfSeat(state.turnSeat, state.size);
  const spot = strikerSpot(side, shot.pos);
  const power = Math.min(1, Math.max(0, shot.power));
  const speed = MIN_SHOT_SPEED + power * (MAX_SHOT_SPEED - MIN_SHOT_SPEED);

  // A shot must travel into the board, never backwards off your own base line.
  // Clamping to the nearest legal direction keeps a near-parallel cut playable
  // instead of throwing it straight up the table.
  const n = normalOfSide(side);
  const angle = clampAimAngle(shot.angle, n.nx, n.ny);

  return {
    x: spot.x,
    y: spot.y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  };
}

function returnPiece(state: GameState, kind: 'white' | 'black' | 'queen'): boolean {
  const piece = state.bodies.find((b) => b.kind === kind && b.pocketed);
  if (!piece) return false;
  const spot = findFreeSpot(state.bodies, piece.r);
  piece.x = spot.x;
  piece.y = spot.y;
  piece.vx = 0;
  piece.vy = 0;
  piece.pocketed = false;
  return true;
}

/**
 * Park the striker on the current shooter's base line.
 *
 * Between turns the striker belongs to whoever is about to play, not wherever
 * it happened to stop. Without this the board shows a striker stranded mid-table
 * while the aim guide points at an empty base line, which reads as two strikers.
 */
function parkStriker(state: GameState): void {
  const striker = state.bodies.find((b) => b.kind === 'striker');
  if (!striker) return;

  const spot = strikerSpot(sideOfSeat(state.turnSeat, state.size), 0.5);
  striker.x = spot.x;
  striker.y = spot.y;
  striker.vx = 0;
  striker.vy = 0;
  striker.pocketed = false;
}

function syncPlayerCounts(state: GameState): void {
  for (const player of state.players) {
    player.pocketed = pocketedCount(state, player.color);
  }
}

/**
 * Play one shot: simulate to rest, then apply the carrom rule set — fouls, the
 * queen cover requirement, penalties, repeat turns and the win condition.
 * Mutates `state` and returns what happened.
 */
export function applyShot(state: GameState, shot: Shot): ShotSummary {
  const seat = state.turnSeat;
  const color = colorOfSeat(seat);
  const opponent = otherColor(color);

  const striker = state.bodies.find((b) => b.kind === 'striker') as Body;
  const launch = resolveShot(state, shot);
  striker.x = launch.x;
  striker.y = launch.y;
  striker.vx = launch.vx;
  striker.vy = launch.vy;
  striker.pocketed = false;

  const sim = simulate(state.bodies);

  const pocketed = sim.pocketed.map((p) => p.kind);
  const ownPocketed = pocketed.filter((k) => k === color).length;
  const oppPocketed = pocketed.filter((k) => k === opponent).length;
  const queenPocketed = pocketed.includes('queen');

  const fouls: FoulReason[] = [];
  const reasons: string[] = [];
  if (sim.strikerPocketed) {
    fouls.push('striker_pocketed');
    reasons.push('Striker pocketed');
  }
  if (!sim.firstContact) {
    fouls.push('no_contact');
    reasons.push('No carrom man touched');
  }
  const foul = fouls.length > 0;

  let queenEvent: ShotSummary['queenEvent'] = null;

  if (queenPocketed) {
    if (!foul && ownPocketed > 0) {
      state.queenOwner = color;
      state.queenPending = null;
      queenEvent = 'covered';
    } else {
      state.queenPending = color;
      queenEvent = 'taken';
    }
  } else if (state.queenPending === color) {
    if (!foul && ownPocketed > 0) {
      state.queenOwner = color;
      state.queenPending = null;
      queenEvent = 'covered';
    } else {
      state.queenPending = null;
      returnPiece(state, 'queen');
      queenEvent = 'returned';
    }
  }

  // A foul on the same turn the queen went down sends the queen straight back.
  if (foul && state.queenPending === color) {
    state.queenPending = null;
    returnPiece(state, 'queen');
    queenEvent = 'returned';
  }

  if (foul) state.due[color] += 1;
  while (state.due[color] > 0 && returnPiece(state, color)) {
    state.due[color] -= 1;
  }

  const repeatTurn = !foul && (ownPocketed > 0 || queenPocketed);

  // The striker comes off the board between turns.
  striker.pocketed = false;
  striker.vx = 0;
  striker.vy = 0;

  state.turnCount += 1;
  state.seq += 1;
  state.serverTime = Date.now();
  if (!repeatTurn) {
    state.turnSeat = (seat + 1) % seatCount(state.size);
  }

  parkStriker(state);
  syncPlayerCounts(state);
  checkWin(state);

  const parts: string[] = [];
  if (ownPocketed > 0) parts.push(`${ownPocketed} of your own`);
  if (oppPocketed > 0) parts.push(`${oppPocketed} for the opponent`);
  if (queenEvent === 'covered') parts.push('queen covered');
  else if (queenEvent === 'taken') parts.push('queen taken, cover it next shot');
  else if (queenEvent === 'returned') parts.push('queen returned to centre');

  let message: string;
  if (foul) message = `Foul: ${reasons.join(', ')}. A piece goes back.`;
  else if (parts.length) message = `Pocketed ${parts.join(', ')}.`;
  else message = 'No pocket.';

  return { seat, color, pocketed, foul, fouls, reasons, repeatTurn, queenEvent, message };
}

/** Running the clock out passes the turn and counts as a foul. */
export function applyTimeout(state: GameState): ShotSummary | null {
  if (state.status !== 'playing') return null;
  const seat = state.turnSeat;
  const color = colorOfSeat(seat);

  state.due[color] += 1;
  while (state.due[color] > 0 && returnPiece(state, color)) {
    state.due[color] -= 1;
  }

  state.turnCount += 1;
  state.seq += 1;
  state.serverTime = Date.now();
  state.turnSeat = (seat + 1) % seatCount(state.size);
  parkStriker(state);
  syncPlayerCounts(state);

  return {
    seat,
    color,
    pocketed: [],
    foul: true,
    fouls: ['timeout'],
    reasons: ['Ran out of time'],
    repeatTurn: false,
    queenEvent: null,
    message: 'Time ran out. A piece goes back and the turn passes.',
  };
}

function checkWin(state: GameState): void {
  if (state.status === 'finished') return;

  for (const color of ['white', 'black'] as Color[]) {
    if (remaining(state, color) > 0) continue;
    if (state.due[color] > 0) continue;

    // Finishing with the queen still in play, or uncovered, hands it over.
    if (state.queenOwner === null) {
      state.queenOwner = otherColor(color);
      state.queenPending = null;
      const queen = state.bodies.find((b) => b.kind === 'queen');
      if (queen) queen.pocketed = true;
    }

    state.status = 'finished';
    state.winner = color;
    state.points =
      remaining(state, otherColor(color)) + (state.queenOwner === color ? QUEEN_POINTS : 0);
    return;
  }

  if (state.turnCount >= MAX_TURNS_PER_BOARD) decideOnPoints(state);
}

/**
 * At the turn cap the board goes to whoever has fewer men left, with the queen
 * breaking a tie. A dead-level board is a draw and every stake is refunded.
 */
function decideOnPoints(state: GameState): void {
  const white = remaining(state, 'white');
  const black = remaining(state, 'black');

  let winner: Color | null = null;
  if (white < black) winner = 'white';
  else if (black < white) winner = 'black';
  else if (state.queenOwner) winner = state.queenOwner;

  state.status = 'finished';
  state.winner = winner;
  state.points = winner
    ? remaining(state, otherColor(winner)) + (state.queenOwner === winner ? QUEEN_POINTS : 0)
    : 0;
}

/** A perfect game: won without conceding a single foul or losing a turn. */
export function isPerfectGame(state: GameState, color: Color): boolean {
  return state.winner === color && remaining(state, otherColor(color)) === PIECES_PER_SIDE;
}

export function isSeatsTurn(state: GameState, seat: number): boolean {
  return state.status === 'playing' && state.turnSeat === seat;
}

export function seatOfUser(state: GameState, userId: string): number | null {
  const player = state.players.find((p) => p.userId === userId);
  return player ? player.seat : null;
}

export function colorOfUser(state: GameState, userId: string): Color | null {
  const player = state.players.find((p) => p.userId === userId);
  return player ? player.color : null;
}
