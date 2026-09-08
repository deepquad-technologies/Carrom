'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyShot, createGame, remaining } from '@carrom/game-engine';
import type { GamePlayer, GameState, Shot } from '@carrom/types';
import GameBoard from '@/components/GameBoard';
import { api } from '@/lib/api';

/**
 * First-run tutorial.
 *
 * Played on the real board with the real engine — every step is a shot the
 * player actually takes, not a diagram of one. Each step sets the board up so
 * the lesson is the obvious thing to do, and advances when the player does it
 * rather than after a timer, so nobody is dragged past something they have not
 * understood.
 *
 * It runs entirely client-side: no match is created, no coins move, and nothing
 * is staked. Skipping is always one click away.
 */
interface TutorialProps {
  onDone(): void;
}

interface Step {
  id: string;
  title: string;
  body: string;
  /** Arrange the board for this lesson. */
  setup(state: GameState): void;
  /** Whether the shot just played completed the lesson. */
  passed(before: GameState, after: GameState): boolean;
  /** Shown when a shot did not achieve the goal. */
  retry: string;
}

const TUTORIAL_PLAYERS: GamePlayer[] = [
  {
    userId: 'you', username: 'you', displayName: 'You', seat: 0, color: 'white',
    connected: true, provider: 'guest', level: 1, trophies: 0, balance: 0,
    strikerSkinId: 'str_classic', coinSkinId: 'set_classic', pocketed: 0,
  },
  {
    userId: 'coach', username: 'coach', displayName: 'Coach', seat: 1, color: 'black',
    connected: true, provider: 'guest', level: 1, trophies: 0, balance: 0,
    strikerSkinId: 'str_classic', coinSkinId: 'set_classic', pocketed: 0,
  },
];

function freshBoard(): GameState {
  return createGame({
    matchId: 'tutorial',
    modeId: 'practice',
    tierId: 'beginner',
    size: '2p',
    players: TUTORIAL_PLAYERS.map((p) => ({ ...p })),
    staked: false,
  });
}

/** Clear the table, then place specific men where a lesson needs them. */
function clearBoard(state: GameState): void {
  for (const body of state.bodies) {
    if (body.kind !== 'striker') body.pocketed = true;
  }
}

function place(state: GameState, kind: 'white' | 'black' | 'queen', x: number, y: number): void {
  const body = state.bodies.find((b) => b.kind === kind && b.pocketed);
  if (!body) return;
  body.pocketed = false;
  body.x = x;
  body.y = y;
  body.vx = 0;
  body.vy = 0;
}

const STEPS: Step[] = [
  {
    id: 'aim',
    title: 'Aim and shoot',
    body:
      'Drag anywhere on the board to aim — the line follows your finger. Set the power below, then release to shoot. Try hitting the white man in the middle.',
    setup(state) {
      clearBoard(state);
      place(state, 'white', 400, 420);
    },
    passed: (_before, after) => after.bodies.some((b) => b.kind === 'white' && !b.pocketed && b.y !== 420),
    retry: 'Aim at the white man and give it enough power to reach.',
  },
  {
    id: 'move',
    title: 'Move the striker',
    body:
      'Drag the striker itself to slide it along your base line. That never fires a shot. Line it up with the man on the left, then pocket it.',
    setup(state) {
      clearBoard(state);
      place(state, 'white', 180, 250);
    },
    passed: (before, after) => remaining(after, 'white') < remaining(before, 'white'),
    retry: 'Move the striker across, aim at the man, and pocket it in the corner.',
  },
  {
    id: 'pocket',
    title: 'Pocketing keeps your turn',
    body:
      'Pocket one of your own men and you shoot again. There are two here — take them both.',
    setup(state) {
      clearBoard(state);
      place(state, 'white', 250, 210);
      place(state, 'white', 550, 210);
    },
    passed: (_before, after) => remaining(after, 'white') === 0,
    retry: 'Pocket both white men. Corner pockets are the easiest line.',
  },
  {
    id: 'queen',
    title: 'The queen must be covered',
    body:
      'The red queen is worth five points, but you must pocket one of your own men on the same or the next turn to keep her. Otherwise she goes back to the centre.',
    setup(state) {
      clearBoard(state);
      place(state, 'queen', 400, 300);
      place(state, 'white', 300, 240);
    },
    passed: (_before, after) => after.queenOwner === 'white' || after.queenPending === 'white',
    retry: 'Pocket the red queen. You will then need to cover her with a white man.',
  },
  {
    id: 'foul',
    title: 'Watch the striker',
    body:
      'Pocketing the striker is a foul: a man of yours goes back on the table and your turn ends. Missing everything is a foul too. Take a careful shot at the man on the right.',
    setup(state) {
      clearBoard(state);
      place(state, 'white', 600, 300);
    },
    passed: (before, after) =>
      remaining(after, 'white') < remaining(before, 'white') ||
      after.bodies.some((b) => b.kind === 'white' && !b.pocketed && b.x !== 600),
    retry: 'Aim at the man on the right and try not to follow it into the pocket.',
  },
];

export default function Tutorial({ onDone }: TutorialProps) {
  const [index, setIndex] = useState(0);
  const [state, setState] = useState<GameState>(() => {
    const board = freshBoard();
    STEPS[0].setup(board);
    return board;
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const [complete, setComplete] = useState(false);

  const step = STEPS[index];
  const isLast = index === STEPS.length - 1;

  const advance = useCallback(() => {
    if (isLast) {
      setComplete(true);
      return;
    }
    const next = index + 1;
    const board = freshBoard();
    STEPS[next].setup(board);
    setState(board);
    setIndex(next);
    setFeedback(null);
  }, [index, isLast]);

  const onShoot = useCallback(
    (shot: Shot) => {
      const before: GameState = { ...state, bodies: state.bodies.map((b) => ({ ...b })) };
      const working: GameState = { ...state, bodies: state.bodies.map((b) => ({ ...b })) };

      applyShot(working, shot);
      // The tutorial is never someone else's turn.
      working.turnSeat = 0;
      working.status = 'playing';
      setState(working);

      if (step.passed(before, working)) {
        setFeedback('Nicely done.');
        window.setTimeout(advance, 1100);
      } else {
        setFeedback(step.retry);
      }
    },
    [state, step, advance],
  );

  const finish = useCallback(async () => {
    await api('/preferences/tutorial-complete', { method: 'POST' }).catch(() => undefined);
    onDone();
  }, [onDone]);

  // Escape skips, like any other overlay.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void finish();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [finish]);

  const progress = useMemo(() => ((index + (complete ? 1 : 0)) / STEPS.length) * 100, [index, complete]);

  if (complete) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 backdrop-blur-sm">
        <div className="panel w-full max-w-md animate-pop-in p-8 text-center">
          <div className="mb-3 text-5xl">{'\u{1F3AF}'}</div>
          <h2 className="font-display text-2xl font-bold">You have the basics</h2>
          <p className="mt-2 text-sm text-white/55">
            Aim, power, the queen and fouls. Everything else you will pick up playing.
          </p>
          <button type="button" className="btn-primary mt-6 w-full" onClick={() => void finish()}>
            Play a match
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-ink-950/96 p-4 backdrop-blur">
      <div className="mx-auto max-w-3xl py-4">
        <div className="mb-4 flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-brass-400 transition-[width] duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-white/40">
            {index + 1} / {STEPS.length}
          </span>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => void finish()}>
            Skip
          </button>
        </div>

        <div className="panel mb-4 p-5">
          <h2 className="font-display text-xl font-bold">{step.title}</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-white/60">{step.body}</p>

          {feedback && (
            <p
              className={`mt-3 animate-fade-up rounded-lg px-3 py-2 text-sm ${
                feedback === 'Nicely done.'
                  ? 'border border-felt-500/40 bg-felt-500/10 text-felt-400'
                  : 'border border-white/10 bg-white/[0.04] text-white/65'
              }`}
            >
              {feedback}
            </p>
          )}
        </div>

        <div className="mx-auto w-full max-w-[min(70vh,620px)]">
          <GameBoard
            state={state}
            viewSeat={0}
            interactive
            pockets={[]}
            trail={[]}
            onShoot={onShoot}
            ambience={false}
          />
        </div>

        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => {
              const board = freshBoard();
              step.setup(board);
              setState(board);
              setFeedback(null);
            }}
          >
            Reset this step
          </button>
          <button type="button" className="btn-ghost text-xs" onClick={advance}>
            {isLast ? 'Finish' : 'Next step'}
          </button>
        </div>
      </div>
    </div>
  );
}
