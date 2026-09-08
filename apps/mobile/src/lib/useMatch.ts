import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { POCKETS } from '@carrom/config';
import { anyMoving, cloneBodies, stepWorld } from '@carrom/physics';
import type { Body, GameState, MatchResult, Shot, ShotBroadcast, ShotSummary } from '@carrom/types';
import { API_URL, getAccessToken } from './api';

/**
 * Live match connection for mobile.
 *
 * Same contract as the web client: the server is authoritative, sends the shot
 * plus the striker's launch vector, and the device replays it with the shared
 * deterministic engine before snapping to the server's board.
 */
export interface RoomPlayer {
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
}

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
  solo: boolean;
  capacity: number;
  started: boolean;
  players: RoomPlayer[];
}

export interface PocketEvent {
  id: string;
  kind: Body['kind'];
  pocketIndex: number;
  at: number;
}

export type Phase = 'idle' | 'queued' | 'lobby' | 'playing' | 'animating' | 'over';

const TRAIL_LENGTH = 14;
const STEP_MS = 1000 / 45;

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

export function useMatch(onBalance?: (coins: number) => void) {
  const socketRef = useRef<Socket | null>(null);
  const replayRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const myUserId = useRef<string | null>(null);

  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [room, setRoom] = useState<RoomView | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [displayState, setDisplayState] = useState<GameState | null>(null);
  const [deadline, setDeadline] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [lastSummary, setLastSummary] = useState<ShotSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queueWaiting, setQueueWaiting] = useState(0);
  const [pockets, setPockets] = useState<PocketEvent[]>([]);
  const [trail, setTrail] = useState<Array<{ x: number; y: number; age: number }>>([]);

  const stopReplay = useCallback(() => {
    if (replayRef.current) {
      clearInterval(replayRef.current);
      replayRef.current = null;
    }
  }, []);

  const runReplay = useCallback(
    (scene: GameState, payload: ShotBroadcast) => {
      stopReplay();
      const started = Date.now();
      const localTrail: Array<{ x: number; y: number; age: number }> = [];

      replayRef.current = setInterval(() => {
        let moving = false;
        for (let i = 0; i < 3; i++) {
          const fell = stepWorld(scene.bodies);
          if (fell.length) {
            const now = Date.now();
            setPockets((prev) => [
              ...prev,
              ...fell.map((f) => {
                const body = scene.bodies.find((b) => b.id === f.id);
                return {
                  id: f.id,
                  kind: f.kind,
                  pocketIndex: body ? nearestPocket(body.x, body.y) : 0,
                  at: now,
                };
              }),
            ]);
          }
          moving = anyMoving(scene.bodies);
          if (!moving) break;
        }

        const striker = scene.bodies.find((b) => b.kind === 'striker');
        if (striker && !striker.pocketed) {
          localTrail.unshift({ x: striker.x, y: striker.y, age: 0 });
          if (localTrail.length > TRAIL_LENGTH) localTrail.pop();
          localTrail.forEach((point, index) => {
            point.age = index / TRAIL_LENGTH;
          });
          setTrail([...localTrail]);
        }

        setDisplayState({ ...scene, bodies: scene.bodies.map((b) => ({ ...b })) });

        if (!moving || Date.now() - started > 12_000) {
          stopReplay();
          setTrail([]);
          setDisplayState(payload.state);
          setPhase(payload.state.status === 'finished' ? 'over' : 'playing');
          setMessage(payload.summary.message);
        }
      }, STEP_MS);
    },
    [stopReplay],
  );

  const playShot = useCallback(
    (payload: ShotBroadcast) => {
      setState(payload.state);
      setPhase('animating');
      setPockets([]);

      setDisplayState((previous) => {
        const working = cloneBodies(previous?.bodies ?? payload.state.bodies);
        const striker = working.find((b) => b.kind === 'striker');
        if (striker) {
          striker.x = payload.striker.x;
          striker.y = payload.striker.y;
          striker.vx = payload.striker.vx;
          striker.vy = payload.striker.vy;
          striker.pocketed = false;
        }
        const scene: GameState = { ...payload.state, bodies: working };
        runReplay(scene, payload);
        return scene;
      });
    },
    [runReplay],
  );

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const socket = io(API_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnectionAttempts: 10,
    });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => setError(err.message));

    socket.on('session', (payload: { userId: string; balance: number }) => {
      myUserId.current = payload.userId;
      onBalance?.(payload.balance);
    });
    socket.on('wallet:update', (payload: { balance: number }) => onBalance?.(payload.balance));

    socket.on('lobby:queued', (payload: { waiting: number }) => {
      setPhase('queued');
      setQueueWaiting(payload.waiting);
    });
    socket.on('lobby:cancelled', () => setPhase('idle'));
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
      setPhase('playing');
    });

    socket.on('game:resume', (payload: { state: GameState; deadline: number }) => {
      setState(payload.state);
      setDisplayState(payload.state);
      setDeadline(payload.deadline);
      setPhase(payload.state.status === 'finished' ? 'over' : 'playing');
    });

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
    });

    socket.on('game:error', (payload: { message: string }) => setError(payload.message));
    socket.on('game:message', (payload: { message: string }) => setMessage(payload.message));

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      stopReplay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== 'playing' || !deadline) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [phase, deadline]);

  useEffect(() => {
    if (pockets.length === 0) return;
    const id = setTimeout(() => setPockets((prev) => prev.slice(1)), 700);
    return () => clearTimeout(id);
  }, [pockets]);

  useEffect(() => {
    if (!message && !error) return;
    const id = setTimeout(() => {
      setMessage(null);
      setError(null);
    }, 3500);
    return () => clearTimeout(id);
  }, [message, error]);

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  const mySeat = useMemo(() => {
    if (!room || !myUserId.current) return null;
    return room.players.find((p) => p.userId === myUserId.current)?.seat ?? null;
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
    secondsLeft,
    result,
    lastSummary,
    message,
    error,
    queueWaiting,
    pockets,
    trail,

    quickMatch: (modeId: string, tierId: string) => emit('lobby:quickMatch', { modeId, tierId }),
    cancelQueue: () => emit('lobby:cancel'),
    /** Start a practice board against a computer opponent of a chosen level. */
    playBot: (skill: 'easy' | 'medium' | 'hard') => emit('lobby:playBot', { skill }),
    createRoom: (input: { modeId: string; tierId: string; boardId?: string; solo?: boolean }) =>
      emit('lobby:createRoom', input),
    joinRoom: (code: string) => emit('lobby:joinRoom', { code: code.trim().toUpperCase() }),
    setReady: (ready: boolean) => emit('lobby:ready', { ready }),
    shoot: (shot: Shot) => emit('game:shot', { shot }),
    sendQuick: (messageId: string) => emit('chat:quick', { messageId }),
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

export type MatchApi = ReturnType<typeof useMatch>;
