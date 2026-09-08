'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { POCKETS } from '@carrom/config';
import { anyMoving, cloneBodies, stepWorld } from '@carrom/physics';
import type { GameState, ShotSummary } from '@carrom/types';
import { API_URL, getAccessToken } from './api';

/**
 * Watching a live match.
 *
 * A spectator connection is strictly read-only: it listens on `watch:*` events
 * and can emit only `watch:join`, `watch:leave` and `watch:react`. The board it
 * receives has velocities stripped by the server, so this client physically
 * cannot be used as an aim assist for a player on another device — the local
 * replay below re-derives motion from the launch vector the server publishes,
 * exactly as a player's client does.
 */
export interface LiveMatch {
  matchId: string;
  code: string;
  modeName: string;
  tierName: string;
  boardId: string;
  spectators: number;
  turnCount: number;
  players: Array<{
    userId: string;
    displayName: string;
    avatarUrl: string | null;
    level: number;
    trophies: number;
    color: string;
    pocketed: number;
  }>;
}

export interface SpectatePlayer {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  seat: number;
  color: 'white' | 'black';
  level: number;
  trophies: number;
  connected: boolean;
}

export interface Reaction {
  from: string;
  emoji: string;
  at: number;
}

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

export function useSpectate() {
  const socketRef = useRef<Socket | null>(null);
  const replayRef = useRef<number | null>(null);

  const [connected, setConnected] = useState(false);
  const [matches, setMatches] = useState<LiveMatch[]>([]);
  const [watchingId, setWatchingId] = useState<string | null>(null);
  const [state, setState] = useState<GameState | null>(null);
  const [displayState, setDisplayState] = useState<GameState | null>(null);
  const [players, setPlayers] = useState<SpectatePlayer[]>([]);
  const [spectators, setSpectators] = useState(0);
  const [deadline, setDeadline] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [summary, setSummary] = useState<ShotSummary | null>(null);
  const [reactions, setReactions] = useState<Reaction[]>([]);
  const [pockets, setPockets] = useState<
    Array<{ id: string; kind: string; pocketIndex: number; at: number }>
  >([]);
  const [ended, setEnded] = useState<{ winner: string | null; note?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stopReplay = useCallback(() => {
    if (replayRef.current !== null) {
      cancelAnimationFrame(replayRef.current);
      replayRef.current = null;
    }
  }, []);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const socket = io(API_URL, { auth: { token }, transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('watch:list');
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', (err) => setError(err.message));

    socket.on('watch:list', (payload: { matches: LiveMatch[] }) => setMatches(payload.matches));

    socket.on(
      'watch:start',
      (payload: {
        matchId: string;
        state: GameState | null;
        players: SpectatePlayer[];
        spectators: number;
        deadline: number;
      }) => {
        setWatchingId(payload.matchId);
        setState(payload.state);
        setDisplayState(payload.state);
        setPlayers(payload.players ?? []);
        setSpectators(payload.spectators);
        setDeadline(payload.deadline);
        setEnded(null);
      },
    );

    socket.on(
      'watch:shot',
      (payload: {
        striker: { x: number; y: number; vx: number; vy: number };
        summary: ShotSummary;
        state: GameState;
        deadline: number;
        spectators: number;
      }) => {
        setSummary(payload.summary);
        setDeadline(payload.deadline);
        setSpectators(payload.spectators);
        setState(payload.state);
        replay(payload.state, payload.striker);
      },
    );

    socket.on(
      'watch:timeout',
      (payload: { summary: ShotSummary; state: GameState; deadline: number }) => {
        setSummary(payload.summary);
        setState(payload.state);
        setDisplayState(payload.state);
        setDeadline(payload.deadline);
      },
    );

    socket.on('watch:count', (payload: { spectators: number }) => setSpectators(payload.spectators));

    socket.on(
      'watch:over',
      (payload: { winner: string | null; note?: string; state: GameState | null }) => {
        if (payload.state) {
          setState(payload.state);
          setDisplayState(payload.state);
        }
        setEnded({ winner: payload.winner, note: payload.note });
      },
    );

    socket.on('watch:reaction', (reaction: Reaction) => {
      setReactions((prev) => [...prev.slice(-8), reaction]);
    });

    socket.on('watch:left', () => {
      setWatchingId(null);
      setState(null);
      setDisplayState(null);
      socket.emit('watch:list');
    });

    socket.on('game:error', (payload: { message: string }) => setError(payload.message));

    const refresh = window.setInterval(() => socket.emit('watch:list'), 15_000);

    return () => {
      window.clearInterval(refresh);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      stopReplay();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Re-derive the shot locally, the same way a player's client does. */
  const replay = useCallback(
    (target: GameState, striker: { x: number; y: number; vx: number; vy: number }) => {
      stopReplay();
      setPockets([]);

      setDisplayState((previous) => {
        const working = cloneBodies(previous?.bodies ?? target.bodies);
        const body = working.find((b) => b.kind === 'striker');
        if (body) {
          body.x = striker.x;
          body.y = striker.y;
          body.vx = striker.vx;
          body.vy = striker.vy;
          body.pocketed = false;
        }

        const scene: GameState = { ...target, bodies: working };
        const started = performance.now();

        const frame = () => {
          let moving = false;
          for (let i = 0; i < 2; i++) {
            const fell = stepWorld(scene.bodies);
            if (fell.length) {
              const now = performance.now();
              setPockets((prev) => [
                ...prev,
                ...fell.map((f) => {
                  const b = scene.bodies.find((x) => x.id === f.id);
                  return {
                    id: f.id,
                    kind: f.kind,
                    pocketIndex: b ? nearestPocket(b.x, b.y) : 0,
                    at: now,
                  };
                }),
              ]);
            }
            moving = anyMoving(scene.bodies);
            if (!moving) break;
          }

          setDisplayState({ ...scene, bodies: scene.bodies.map((b) => ({ ...b })) });

          if (moving && performance.now() - started < 12_000) {
            replayRef.current = requestAnimationFrame(frame);
            return;
          }
          replayRef.current = null;
          setDisplayState(target);
        };

        replayRef.current = requestAnimationFrame(frame);
        return scene;
      });
    },
    [stopReplay],
  );

  useEffect(() => {
    if (!watchingId || !deadline) {
      setSecondsLeft(0);
      return;
    }
    const tick = () => setSecondsLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [watchingId, deadline]);

  useEffect(() => {
    if (pockets.length === 0) return;
    const id = window.setTimeout(() => setPockets((prev) => prev.slice(1)), 700);
    return () => window.clearTimeout(id);
  }, [pockets]);

  useEffect(() => {
    if (reactions.length === 0) return;
    const id = window.setTimeout(() => setReactions((prev) => prev.slice(1)), 2600);
    return () => window.clearTimeout(id);
  }, [reactions]);

  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), 4000);
    return () => window.clearTimeout(id);
  }, [error]);

  return {
    connected,
    matches,
    watchingId,
    state,
    displayState,
    players,
    spectators,
    secondsLeft,
    summary,
    reactions,
    pockets,
    ended,
    error,

    refresh: () => socketRef.current?.emit('watch:list'),
    watch: (matchId: string) => socketRef.current?.emit('watch:join', { matchId }),
    stop: () => socketRef.current?.emit('watch:leave'),
    react: (emoji: string) => socketRef.current?.emit('watch:react', { emoji }),
  };
}
