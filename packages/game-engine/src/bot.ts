import { PIECE_RADIUS, POCKETS, POCKET_RADIUS } from '@carrom/config';
import type { Body, Color, GameState, Shot } from '@carrom/types';
import { applyShot } from './rules';
import { clampAimAngle, colorOfSeat, normalOfSide, otherColor, sideOfSeat, strikerSpot } from './seating';

/**
 * A computer opponent.
 *
 * The bot picks a shot by **playing it**: it clones the board, runs the real
 * engine on a candidate, and scores what actually happened. That means it is
 * bound by exactly the rules a human is — it cannot see through pieces, cannot
 * place the striker illegally, and cannot escape a foul it caused. There is no
 * separate "bot physics" to drift out of step with the game.
 *
 * The search is aimed rather than exhaustive: candidates are generated from
 * striker positions that actually line up with a target man, so a small budget
 * still finds sensible shots. Difficulty is then applied by *degrading* the
 * result — less search, worse aim, and an occasional deliberate blunder — so a
 * beginner-level bot misses the way a beginner does rather than by cheating in
 * reverse.
 */
export type BotSkill = 'easy' | 'medium' | 'hard';

export interface BotProfile {
  skill: BotSkill;
  /** Striker positions tried per target. More is better and slower. */
  positions: number;
  /** Aim offsets tried around the direct line to each target. */
  spread: number;
  /** Radians of error applied to the chosen shot. */
  aimNoise: number;
  /** Power error as a fraction, applied to the chosen shot. */
  powerNoise: number;
  /** Chance of taking a deliberately worse candidate. */
  blunderChance: number;
  /** How long the bot appears to think, in milliseconds. */
  thinkMs: [number, number];
}

export const BOT_PROFILES: Record<BotSkill, BotProfile> = {
  easy: {
    skill: 'easy',
    positions: 3,
    spread: 1,
    aimNoise: 0.075,
    powerNoise: 0.22,
    blunderChance: 0.35,
    thinkMs: [1_600, 3_400],
  },
  medium: {
    skill: 'medium',
    positions: 5,
    spread: 2,
    aimNoise: 0.032,
    powerNoise: 0.1,
    blunderChance: 0.15,
    thinkMs: [1_300, 2_800],
  },
  hard: {
    skill: 'hard',
    positions: 7,
    spread: 3,
    aimNoise: 0.012,
    powerNoise: 0.045,
    blunderChance: 0.04,
    thinkMs: [900, 2_200],
  },
};

export function profileFor(skill: BotSkill): BotProfile {
  return BOT_PROFILES[skill] ?? BOT_PROFILES.medium;
}

/**
 * Pick a bot difficulty to suit the opponent.
 *
 * A brand new player should not meet the hardest bot on their second match,
 * and someone at level 20 should not be handed a bot that misses everything.
 */
export function skillForLevel(level: number, trophies = 0): BotSkill {
  if (level <= 4 && trophies < 150) return 'easy';
  if (level <= 14 || trophies < 700) return 'medium';
  return 'hard';
}

/* -------------------------------- scoring --------------------------------- */

const SCORE = {
  ownPocketed: 120,
  queenTaken: 260,
  queenCovered: 200,
  queenLost: -150,
  opponentPocketed: -70,
  strikerPocketed: -230,
  noContact: -160,
  repeatTurn: 45,
  win: 1_400,
  /** Weight on leaving your own men close to a pocket for next turn. */
  position: 26,
};

function distanceToNearestPocket(body: Body): number {
  let best = Number.POSITIVE_INFINITY;
  for (const pocket of POCKETS) {
    const d = Math.hypot(body.x - pocket.x, body.y - pocket.y);
    if (d < best) best = d;
  }
  return best;
}

/**
 * How well placed a colour's remaining men are.
 *
 * Men sitting near a pocket are worth something next turn, so a shot that
 * nudges one to the edge scores above one that achieves nothing. The reward
 * falls off with distance rather than being a cliff, which stops the bot
 * fixating on a single piece.
 */
function positionalValue(state: GameState, color: Color): number {
  let total = 0;
  for (const body of state.bodies) {
    if (body.pocketed || body.kind !== color) continue;
    const d = Math.max(POCKET_RADIUS, distanceToNearestPocket(body));
    total += Math.min(1, (PIECE_RADIUS * 8) / d);
  }
  return total;
}

/** Deep enough for the engine: bodies and players are the only mutated parts. */
function cloneState(state: GameState): GameState {
  return {
    ...state,
    bodies: state.bodies.map((b) => ({ ...b })),
    players: state.players.map((p) => ({ ...p })),
    due: { ...state.due },
  };
}

function scoreOutcome(before: GameState, after: GameState, shot: Shot): number {
  const color = colorOfSeat(before.turnSeat);
  const enemy = otherColor(color);

  // Re-derive from the boards rather than trusting a summary, so the score is
  // about the position that resulted, not the labels we gave the events.
  const countOf = (state: GameState, kind: string) =>
    state.bodies.filter((b) => b.kind === kind && !b.pocketed).length;

  const ownGained = countOf(before, color) - countOf(after, color);
  const enemyGained = countOf(before, enemy) - countOf(after, enemy);
  const queenGone = countOf(before, 'queen') - countOf(after, 'queen');

  let score = 0;
  score += ownGained * SCORE.ownPocketed;
  score += enemyGained * SCORE.opponentPocketed;

  if (queenGone > 0) {
    if (after.queenOwner === color) score += SCORE.queenCovered;
    else if (after.queenPending === color) score += SCORE.queenTaken;
    else score += SCORE.queenLost;
  }

  const striker = after.bodies.find((b) => b.kind === 'striker');
  if (striker?.pocketed) score += SCORE.strikerPocketed;

  // Keeping the turn is worth real value: it is another shot.
  if (after.turnSeat === before.turnSeat && after.status === 'playing') {
    score += SCORE.repeatTurn;
  }

  if (after.status === 'finished') {
    score += after.winner === color ? SCORE.win : -SCORE.win;
  }

  score += (positionalValue(after, color) - positionalValue(before, color)) * SCORE.position;
  // Leaving the opponent well placed is a cost.
  score -= (positionalValue(after, enemy) - positionalValue(before, enemy)) * SCORE.position;

  // Among equally good shots, prefer the gentler one — it scatters less and
  // leaves a more readable table.
  score -= shot.power * 4;

  return score;
}

/* ------------------------------- candidates ------------------------------- */

/** Men this seat is allowed to be aiming at, queen included when legal. */
function targetsFor(state: GameState): Body[] {
  const color = colorOfSeat(state.turnSeat);
  const own = state.bodies.filter((b) => b.kind === color && !b.pocketed);

  const queen = state.bodies.find((b) => b.kind === 'queen' && !b.pocketed);
  // The queen is only worth chasing once you have a man left to cover her with.
  if (queen && own.length > 0 && !state.queenOwner) own.push(queen);

  return own;
}

function* candidateShots(state: GameState, profile: BotProfile): Generator<Shot> {
  const side = sideOfSeat(state.turnSeat, state.size);
  const normal = normalOfSide(side);
  const targets = targetsFor(state);

  for (const target of targets) {
    for (let p = 0; p < profile.positions; p++) {
      // Spread positions across the base line, avoiding the exact ends.
      const pos = profile.positions === 1 ? 0.5 : 0.12 + (p / (profile.positions - 1)) * 0.76;
      const spot = strikerSpot(side, pos);

      const direct = Math.atan2(target.y - spot.y, target.x - spot.x);
      const distance = Math.hypot(target.x - spot.x, target.y - spot.y);

      for (let s = -profile.spread; s <= profile.spread; s++) {
        // Fan out around the direct line; a wider fan finds cut shots.
        const angle = clampAimAngle(direct + s * 0.035, normal.nx, normal.ny);

        // Enough power to reach, plus options for a firmer strike.
        const reach = Math.min(1, 0.24 + distance / 900);
        for (const power of [reach, Math.min(1, reach + 0.2), Math.min(1, reach + 0.45)]) {
          yield { pos, angle, power };
        }
      }
    }
  }
}

/* --------------------------------- search --------------------------------- */

export interface BotDecision {
  shot: Shot;
  score: number;
  /** Candidates actually simulated, for logging and tuning. */
  evaluated: number;
}

/**
 * Choose a shot.
 *
 * `budgetMs` caps how long the search may run. The caller yields to the event
 * loop between batches, so a busy server never stalls other matches while a bot
 * thinks — the bot simply searches less and plays a little worse.
 */
export async function chooseShot(
  state: GameState,
  profile: BotProfile,
  budgetMs = 250,
  yieldToLoop: () => Promise<void> = () => new Promise((r) => setImmediate(r)),
): Promise<BotDecision> {
  const started = Date.now();
  const scored: Array<{ shot: Shot; score: number }> = [];
  let evaluated = 0;

  for (const shot of candidateShots(state, profile)) {
    const trial = cloneState(state);
    applyShot(trial, shot);
    scored.push({ shot, score: scoreOutcome(state, trial, shot) });
    evaluated += 1;

    // Yield often enough that a bot's turn never blocks another match's shot.
    if (evaluated % 8 === 0) {
      if (Date.now() - started > budgetMs) break;
      await yieldToLoop();
    }
  }

  if (scored.length === 0) {
    // No legal target found — play a safe nudge rather than forfeiting the turn.
    return { shot: safeShot(state), score: 0, evaluated };
  }

  scored.sort((a, b) => b.score - a.score);

  // A blunder is picking from further down the ranking, not aiming at nothing.
  const index =
    Math.random() < profile.blunderChance
      ? Math.min(scored.length - 1, 1 + Math.floor(Math.random() * 4))
      : 0;
  const chosen = scored[index]!;

  return {
    shot: addHumanError(state, chosen.shot, profile),
    score: chosen.score,
    evaluated,
  };
}

/**
 * Apply the bot's imprecision.
 *
 * This is what separates difficulties: the bot knows the good shot and then
 * fails to execute it perfectly, which is how a real player misses. The result
 * is re-clamped, so noise can never produce an illegal direction.
 */
function addHumanError(state: GameState, shot: Shot, profile: BotProfile): Shot {
  const normal = normalOfSide(sideOfSeat(state.turnSeat, state.size));
  const jitter = (spread: number) => (Math.random() * 2 - 1) * spread;

  return {
    pos: Math.min(1, Math.max(0, shot.pos + jitter(profile.powerNoise * 0.15))),
    angle: clampAimAngle(shot.angle + jitter(profile.aimNoise), normal.nx, normal.ny),
    power: Math.min(1, Math.max(0.08, shot.power * (1 + jitter(profile.powerNoise)))),
  };
}

/** Straight into the board at moderate power. Always legal, rarely a foul. */
function safeShot(state: GameState): Shot {
  const normal = normalOfSide(sideOfSeat(state.turnSeat, state.size));
  return {
    pos: 0.5,
    angle: Math.atan2(normal.ny, normal.nx),
    power: 0.45,
  };
}

/** How long this bot should appear to consider the shot. */
export function thinkTimeFor(profile: BotProfile): number {
  const [min, max] = profile.thinkMs;
  return min + Math.random() * (max - min);
}
