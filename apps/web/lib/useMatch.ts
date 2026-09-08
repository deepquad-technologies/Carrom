'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { POCKETS } from '@carrom/config';
import { anyMoving, cloneBodies, stepWorld } from '@carrom/physics';
import type {
  Body, GameState, MatchResult, Shot, ShotBroadcast, ShotSummary,
} from '@carrom/types';
import { API_URL, getAccessToken } from './api';

/**
 * The live match connection.
 *
 * The server is authoritative. It sends the shot the player took plus the
 * striker's exact launch vector, and every client replays that shot locally
 * with the same deterministic engine — so the animation is smooth and free of
 * network jitter — then snaps to the server's post-shot state. Nothing the
 * client computes is ever sent back as truth.
 */
export interface RoomView {
  code: string;
  matchId: string;
  modeId: string;
  modeName: string;
  tierId: string;
  tierName: string;
  boardId: string;
  size: '2p' | '4p';
  entry: number;
  pot: number;
  turnSeconds: number;
  isPrivate: boolean;
  solo: boolean;
  capacity: number;
  started: boolean;
  hostUserId: string;
  players: Array<{
    userId: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    seat: number;
    color: 'white' | 'black';
    connected: boolean;
    ready: boolean;
    level: number;
    trophies: number;
    strikerSkinId: string;
    coinSkinId: string;
    /** Disclosed by the server: a seat driven by the computer. */
    isBot: boolean;
    botSkill: 'easy' | 'medium' | 'hard' | null;
  }>;
}

export interface ChatLine {
  userId: string;
  from: string;
  messageId: string;
  text: string;
  emoji: string;
  at: number;
}

export type Phase = 'idle' | 'queued' | 'lobby' | 'playing' | 'animating' | 'over';

export interface PocketEvent {
  id: string;
  kind: Body['kind'];
  /** Which of the four pockets it dropped into. */
  pocketIndex: number;
  at: number;
}

/** The pocket a body is sitting over, for the drop flash. */
function nearestPocket(x: number, y: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < POCKETS.length; i++) {
    const d = Math.hypot(x - POCKETS[i].x, y - POCKETS[i].y);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

export interface MatchApi {
  connected: boolean;
  phase: Phase;
  room: RoomView | null;
  state: GameState | null;
  /** The board being animated; equals `state` when nothing is in flight. */
  displayState: GameState | null;
  mySeat: number | null;
  myTurn: boolean;
  deadline: number;
  secondsLeft: number;
  chat: ChatLine[];
  lastSummary: ShotSummary | null;
  result: MatchResult | null;
  message: string | null;
  error: string | null;
  queueInfo: { waiting: number; modeId: string; tierId: string } | null;
  pockets: PocketEvent[];
  strikerTrail: Array<{ x: number; y: number; age: number }>;

  quickMatch(modeId: string, tierId: string): void;
  cancelQueue(): void;
  createRoom(input: { modeId: string; tierId: string; boardId?: string; solo?: boolean }): void;
  /** Start a practice board against a computer opponent of a chosen level. */
  playBot(skill: 'easy' | 'medium' | 'hard', boardId?: string): void;
  joinRoom(code: string): void;
  setReady(ready: boolean): void;
  shoot(shot: Shot): void;
  sendQuick(messageId: string): void;
  sendReaction(emoji: string): void;
  leave(): void;
  dismissResult(): void;
}

const TRAIL_LENGTH = 18;

export function useMatch(onBalance?: (coins: number) => void): MatchApi {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [room, setRoom] = useState<RoomView | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [displayState, setDisplayState] = useState<GameState | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [lastSummary, setLastSummary] = useState<ShotSummary | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueInfo, setQueueInfo] = useState<MatchApi['queueInfo']>(null);
  const [pockets, setPockets] = useState<PocketEvent[]>([]);
  const [trail, setTrail] = useState<Array<{ x: number; y: number; age: number }>>([]);

  const myUserIdRef = useRef<string | null>(null);
  const replayRef = useRef<number | null>(null);

  /* ------------------------------- connection ------------------------------ */

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const socket = io(API_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 8,
      reconnectionDelay: 800,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => setError(err.message));

    socket.on('session', (payload: { userId: string; balance: number }) => {
      myUserIdRef.current = payload.userId;
      onBalance?.(payload.balance);
    });

    socket.on('wallet:update', (payload: { balance: number }) => onBalance?.(payload.balance));

    socket.on('lobby:queued', (payload: { waiting: number; modeId: string; tierId: string }) => {
      setPhase('queued');
      setQueueInfo(payload);
    });

    socket.on('lobby:cancelled', () => {
      setPhase('idle');
      setQueueInfo(null);
    });

    socket.on('lobby:error', (payload: { message: string }) => {
      setError(payload.message);
      setPhase('idle');
    });

    socket.on('lobby:roomCreated', () => setPhase('lobby'));

    socket.on('room:state', (view: RoomView) => {
      setRoom(view);
      setPhase((current) => (current === 'queued' || current === 'idle' ? 'lobby' : current));
    });

    socket.on('game:start', (payload: { state: GameState; deadline: number }) => {
      setState(payload.state);
      setDisplayState(payload.state);
      setDeadline(payload.deadline);
      setResult(null);
      setLastSummary(null);
      setPhase('playing');
      setMessage(null);
    });

    socket.on(
      'game:resume',
      (payload: { state: GameState; deadline: number; chat?: ChatLine[] }) => {
        setState(payload.state);
        setDisplayState(payload.state);
        setDeadline(payload.deadline);
        setChat(payload.chat ?? []);
        setPhase(payload.state.status === 'finished' ? 'over' : 'playing');
      },
    );

    socket.on('game:shot', (payload: ShotBroadcast) => {
      setDeadline(payload.deadline);
      setLastSummary(payload.summary);
      playShot(payload);
    });

    socket.on(
      'game:timeout',
      (payload: { summary: ShotSummary; state: GameState; deadline: number }) => {
        setLastSummary(payload.summary);
        setState(payload.state);
        setDisplayState(payload.state);
        setDeadline(payload.deadline);
        setMessage(payload.summary.message);
      },
    );

    socket.on('game:over', (payload: MatchResult & { note?: string; state: GameState | null }) => {
      if (payload.state) {
        setState(payload.state);
        setDisplayState(payload.state);
      }
      setResult(payload);
      setPhase('over');
      if (payload.note) setMessage(payload.note);
    });

    socket.on('game:error', (payload: { message: string }) => setError(payload.message));
    socket.on('game:message', (payload: { message: string }) => setMessage(payload.message));

    socket.on('player:disconnect', (payload: { displayName: string }) =>
      setMessage(`${payload.displayName} lost connection…`),
    );
    socket.on('player:reconnect', () => setMessage('Player reconnected'));

    socket.on('chat:message', (line: ChatLine) => {
      setChat((prev) => [...prev.slice(-40), line]);
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      if (replayRef.current !== null) cancelAnimationFrame(replayRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ----------------------------- shot animation ---------------------------- */

  /**
   * Replay a shot locally at a fixed timestep. Because the engine is
   * deterministic and the server sends the exact launch vector, the animation
   * lands on the same board the server already computed; the final snap is
   * belt and braces.
   */
  const playShot = useCallback((payload: ShotBroadcast) => {
    if (replayRef.current !== null) cancelAnimationFrame(replayRef.current);

    setState(payload.state);
    setPhase(payload.state.status === 'finished' ? 'animating' : 'animating');
    setPockets([]);
    setTrail([]);

    // Start from the board as it was before this shot, then launch the striker.
    const bodies = cloneBodies(payload.state.bodies);
    const striker = bodies.find((b) => b.kind === 'striker');
    if (!striker) {
      setDisplayState(payload.state);
      setPhase(payload.state.status === 'finished' ? 'over' : 'playing');
      return;
    }

    // The authoritative post-shot positions are the destination; rewind the
    // board to the pre-shot layout the client already had on screen.
    setDisplayState((previous) => {
      const source = previous?.bodies ?? bodies;
      const working = cloneBodies(source);
      const workingStriker = working.find((b) => b.kind === 'striker');
      if (workingStriker) {
        workingStriker.x = payload.striker.x;
        workingStriker.y = payload.striker.y;
        workingStriker.vx = payload.striker.vx;
        workingStriker.vy = payload.striker.vy;
        workingStriker.pocketed = false;
      }

      const scene: GameState = { ...payload.state, bodies: working };
      runReplay(scene, payload);
      return scene;
    });
  }, []);

  const runReplay = useCallback((scene: GameState, payload: ShotBroadcast) => {
    const STEPS_PER_FRAME = 2;
    const started = performance.now();
    const localTrail: Array<{ x: number; y: number; age: number }> = [];

    const frame = () => {
      let moving = false;
      for (let i = 0; i < STEPS_PER_FRAME; i++) {
        const fell = stepWorld(scene.bodies);
        if (fell.length) {
          const now = performance.now();
          const dropped = fell.map((f) => {
            const body = scene.bodies.find((b) => b.id === f.id);
            return {
              id: f.id,
              kind: f.kind,
              pocketIndex: body ? nearestPocket(body.x, body.y) : 0,
              at: now,
            };
          });
          setPockets((prev) => [...prev, ...dropped]);
        }
        moving = anyMoving(scene.bodies);
        if (!moving) break;
      }

      const striker = scene.bodies.find((b) => b.kind === 'striker');
      if (striker && !striker.pocketed) {
        localTrail.unshift({ x: striker.x, y: striker.y, age: 0 });
        if (localTrail.length > TRAIL_LENGTH) localTrail.pop();
        for (let i = 0; i < localTrail.length; i++) {
          localTrail[i].age = i / TRAIL_LENGTH;
        }
        setTrail([...localTrail]);
      }

      setDisplayState({ ...scene, bodies: scene.bodies.map((b) => ({ ...b })) });

      const tooLong = performance.now() - started > 12_000;
      if (moving && !tooLong) {
        replayRef.current = requestAnimationFrame(frame);
        return;
      }

      // Settle on the server's board, whatever the local replay produced.
      replayRef.current = null;
      setTrail([]);
      setDisplayState(payload.state);
      setPhase(payload.state.status === 'finished' ? 'over' : 'playing');
      setMessage(payload.summary.message);
    };

    replayRef.current = requestAnimationFrame(frame);
  }, []);

  /* -------------------------------- turn clock ------------------------------ */

  useEffect(() => {
    if (phase !== 'playing' || !deadline) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [phase, deadline]);

  // Fade pocket flashes out.
  useEffect(() => {
    if (pockets.length === 0) return;
    const id = window.setTimeout(() => setPockets((prev) => prev.slice(1)), 700);
    return () => window.clearTimeout(id);
  }, [pockets]);

  // Auto-dismiss transient messages.
  useEffect(() => {
    if (!message) return;
    const id = window.setTimeout(() => setMessage(null), 3500);
    return () => window.clearTimeout(id);
  }, [message]);

  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(id);
  }, [error]);

  /* --------------------------------- actions -------------------------------- */

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  const mySeat = useMemo(() => {
    if (!room || !myUserIdRef.current) return null;
    const seat = room.players.find((p) => p.userId === myUserIdRef.current);
    return seat ? seat.seat : null;
  }, [room]);

  const myTurn = useMemo(() => {
    if (!state || phase !== 'playing') return false;
    if (room?.solo) return true;
    return mySeat !== null && state.turnSeat === mySeat;
  }, [state, phase, mySeat, room]);

  return {
    connected,
    phase,
    room,
    state,
    displayState,
    mySeat,
    myTurn,
    deadline,
    secondsLeft,
    chat,
    lastSummary,
    result,
    message,
    error,
    queueInfo,
    pockets,
    strikerTrail: trail,

    quickMatch: (modeId, tierId) => {
      setError(null);
      emit('lobby:quickMatch', { modeId, tierId });
    },
    cancelQueue: () => emit('lobby:cancel'),

    playBot: (skill, boardId) => {
      emit('lobby:playBot', { skill, boardId });
    },
    createRoom: (input) => {
      setError(null);
      emit('lobby:createRoom', input);
    },
    joinRoom: (code) => {
      setError(null);
      emit('lobby:joinRoom', { code: code.trim().toUpperCase() });
    },
    setReady: (ready) => emit('lobby:ready', { ready }),
    shoot: (shot) => emit('game:shot', { shot }),
    sendQuick: (messageId) => emit('chat:quick', { messageId }),
    sendReaction: (emoji) => emit('chat:quick', { emoji }),
    leave: () => {
      emit('room:leave');
      setPhase('idle');
      setRoom(null);
      setState(null);
      setDisplayState(null);
      setResult(null);
    },
    dismissResult: () => {
      setResult(null);
      setPhase('idle');
      setRoom(null);
      setState(null);
      setDisplayState(null);
    },
  };
}
