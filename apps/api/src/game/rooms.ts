import { randomUUID } from 'node:crypto';
import {
  GAME_MODES, MATCH_TIERS, PRESENCE, TIMERS, modeById, tierById,
  type GameModeConfig, type MatchTier,
} from '@carrom/config';
import { boardById } from '@carrom/content';
import { colorOfSeat, createGame, seatCount } from '@carrom/game-engine';
import type { Color, GamePlayer, GameState, TableSize } from '@carrom/types';

/**
 * Live match state. One entry per table currently being played, held in memory
 * on the node that owns it. Everything durable is written to Postgres as it
 * happens, so losing a node loses only the in-flight board, never a balance.
 */
export interface Seat {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  seat: number;
  color: Color;
  socketId: string | null;
  connected: boolean;
  disconnectedAt: number | null;
  strikerSkinId: string;
  coinSkinId: string;
  level: number;
  trophies: number;
  balanceBefore: number;
  ready: boolean;
  /** Consecutive turns lost to the clock; drives AFK handling. */
  skippedTurns: number;
  fouls: number;
  /**
   * A computer opponent. Bots have no socket, are never AFK, and are always
   * disclosed to the client — a player should be able to tell whether the
   * person across the table is a person.
   */
  isBot: boolean;
  botSkill: 'easy' | 'medium' | 'hard' | null;
  /** When the bot should play its shot; set each time its turn begins. */
  botPlaysAt: number | null;
}

export interface ChatLine {
  userId: string;
  from: string;
  messageId: string;
  text: string;
  emoji: string;
  at: number;
}

export interface Room {
  code: string;
  matchId: string;
  mode: GameModeConfig;
  tier: MatchTier;
  boardId: string;
  size: TableSize;
  isPrivate: boolean;
  /** One player driving every seat, for practice. */
  solo: boolean;
  hostUserId: string;
  seats: Seat[];
  state: GameState | null;
  turnDeadline: number;
  turnStartedAt: number;
  chat: ChatLine[];
  settled: boolean;
  createdAt: number;
  startedAt: number | null;
  /** Private rooms and practice boards are not open to viewers. */
  isSpectatable: boolean;
  /**
   * The bracket slot this board is playing out, when it is a tournament match.
   * The entry fee was taken at registration, so the board itself is unstaked —
   * charging again here would take a second entry from both players.
   */
  tournamentMatchId: string | null;
  tournamentId: string | null;
  /** Highest concurrent viewer count seen, recorded when the match ends. */
  spectatorPeak: number;
}

const rooms = new Map<string, Room>();
const roomByMatch = new Map<string, Room>();

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  let code: string;
  do {
    code = Array.from(
      { length: 5 },
      () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)],
    ).join('');
  } while (rooms.has(code));
  return code;
}

export interface SeatInput {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  strikerSkinId: string;
  coinSkinId: string;
  level: number;
  trophies: number;
  balance: number;
  /** Null for a bot, which has no connection of its own. */
  socketId: string | null;
  isBot?: boolean;
  botSkill?: 'easy' | 'medium' | 'hard' | null;
}

export interface CreateRoomInput {
  modeId: string;
  tierId: string;
  boardId?: string;
  isPrivate?: boolean;
  solo?: boolean;
  hostUserId: string;
  /** Overrides the mode default when a host picks a clock. */
  timerPreset?: keyof typeof TIMERS;
}

export function createRoom(input: CreateRoomInput): Room {
  const mode = modeById(input.modeId) ?? GAME_MODES.classic;
  const tier = tierById(input.tierId) ?? MATCH_TIERS[0];
  const solo = Boolean(input.solo) || mode.matchmaking === 'solo';

  const room: Room = {
    code: newCode(),
    matchId: randomUUID(),
    mode,
    tier,
    boardId: boardById(input.boardId ?? tier.boardId).id,
    size: mode.seats === 4 ? '4p' : '2p',
    isPrivate: input.isPrivate ?? mode.matchmaking === 'code',
    solo,
    hostUserId: input.hostUserId,
    seats: [],
    state: null,
    turnDeadline: 0,
    turnStartedAt: 0,
    chat: [],
    settled: false,
    createdAt: Date.now(),
    startedAt: null,
    // Matchmade public games are watchable; private rooms and practice are not.
    isSpectatable: !solo && !(input.isPrivate ?? mode.matchmaking === 'code'),
    spectatorPeak: 0,
    tournamentMatchId: null,
    tournamentId: null,
  };

  rooms.set(room.code, room);
  roomByMatch.set(room.matchId, room);
  return room;
}

export function getRoom(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

export function getRoomByMatch(matchId: string): Room | undefined {
  return roomByMatch.get(matchId);
}

export function roomOfSocket(socketId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.seats.some((s) => s.socketId === socketId)) return room;
  }
  return undefined;
}

export function roomOfUser(userId: string): Room | undefined {
  for (const room of rooms.values()) {
    if (room.seats.some((s) => s.userId === userId)) return room;
  }
  return undefined;
}

export function removeRoom(room: Room): void {
  rooms.delete(room.code);
  roomByMatch.delete(room.matchId);
}

export function capacityOf(room: Room): number {
  return room.solo ? 1 : seatCount(room.size);
}

export function isFull(room: Room): boolean {
  return room.seats.length >= capacityOf(room);
}

export function turnSecondsOf(room: Room): number {
  return TIMERS[room.mode.timer].turnSeconds;
}

/** Seat a player, or reattach an existing seat to a new socket on reconnect. */
export function addSeat(room: Room, input: SeatInput): Seat {
  const existing = room.seats.find((s) => s.userId === input.userId);
  if (existing) {
    existing.socketId = input.socketId;
    existing.connected = true;
    existing.disconnectedAt = null;
    return existing;
  }

  const index = room.seats.length;
  const isBot = Boolean(input.isBot);
  const seat: Seat = {
    userId: input.userId,
    username: input.username,
    displayName: input.displayName,
    avatarUrl: input.avatarUrl,
    seat: index,
    color: colorOfSeat(index),
    socketId: isBot ? null : input.socketId,
    connected: true,
    disconnectedAt: null,
    strikerSkinId: input.strikerSkinId,
    coinSkinId: input.coinSkinId,
    level: input.level,
    trophies: input.trophies,
    balanceBefore: input.balance,
    ready: room.mode.matchmaking !== 'code',
    skippedTurns: 0,
    fouls: 0,
    isBot: Boolean(input.isBot),
    botSkill: input.botSkill ?? null,
    botPlaysAt: null,
  };
  room.seats.push(seat);
  return seat;
}

export function removeSeat(room: Room, userId: string): void {
  room.seats = room.seats.filter((s) => s.userId !== userId);
  room.seats.forEach((seat, index) => {
    seat.seat = index;
    seat.color = colorOfSeat(index);
  });
}

export function seatOfUser(room: Room, userId: string): Seat | undefined {
  return room.seats.find((s) => s.userId === userId);
}

export function seatsOfColor(room: Room, color: Color): Seat[] {
  return room.seats.filter((s) => s.color === color);
}

export function everyoneReady(room: Room): boolean {
  return isFull(room) && room.seats.every((s) => s.ready);
}

/** Build the authoritative opening state. Coins are taken by the caller first. */
export function beginMatch(room: Room): GameState {
  const players: GamePlayer[] = room.seats.map((seat) => ({
    userId: seat.userId,
    username: seat.username,
    displayName: seat.displayName,
    avatarUrl: seat.avatarUrl ?? undefined,
    seat: seat.seat,
    color: seat.color,
    connected: seat.connected,
    provider: 'guest',
    level: seat.level,
    trophies: seat.trophies,
    balance: seat.balanceBefore,
    strikerSkinId: seat.strikerSkinId,
    coinSkinId: seat.coinSkinId,
    pocketed: 0,
  }));

  const state = createGame({
    matchId: room.matchId,
    modeId: room.mode.id,
    tierId: room.tier.id,
    boardId: room.boardId,
    size: room.size,
    players,
    turnSeconds: turnSecondsOf(room),
    staked: room.mode.staked && !room.solo,
  });

  // Solo practice is unstaked, and so is a tournament board — the entry was
  // taken at registration and the prize pool holds it.
  state.pot =
    room.solo || !room.mode.staked || room.tournamentMatchId ? 0 : room.tier.entry * room.seats.length;

  room.state = state;
  room.startedAt = Date.now();
  resetTurnClock(room);
  return state;
}

export function resetTurnClock(room: Room): void {
  room.turnStartedAt = Date.now();
  room.turnDeadline = room.turnStartedAt + turnSecondsOf(room) * 1000;
}

export function markConnection(room: Room, userId: string, socketId: string | null): void {
  const seat = seatOfUser(room, userId);
  if (!seat) return;
  seat.socketId = socketId;
  seat.connected = socketId !== null;
  seat.disconnectedAt = socketId === null ? Date.now() : null;

  const player = room.state?.players.find((p) => p.userId === userId);
  if (player) player.connected = seat.connected;
}

/** Seats that have been gone longer than the reconnection window. */
export function lapsedSeats(room: Room, now = Date.now()): Seat[] {
  return room.seats.filter(
    (s) =>
      !s.isBot &&
      !s.connected &&
      s.disconnectedAt !== null &&
      now - s.disconnectedAt >= PRESENCE.reconnectWindowMs,
  );
}

export function isAfk(seat: Seat): boolean {
  // A bot always plays its turn, so it can never be away.
  return !seat.isBot && seat.skippedTurns >= PRESENCE.afkTurns;
}

/** Whether this room contains a computer opponent. */
export function hasBot(room: Room): boolean {
  return room.seats.some((s) => s.isBot);
}

export function botSeats(room: Room): Seat[] {
  return room.seats.filter((s) => s.isBot);
}

export interface RoomView {
  code: string;
  matchId: string;
  modeId: string;
  modeName: string;
  tierId: string;
  tierName: string;
  boardId: string;
  size: TableSize;
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
    color: Color;
    connected: boolean;
    ready: boolean;
    level: number;
    trophies: number;
    strikerSkinId: string;
    coinSkinId: string;
    /** Disclosed so the client can label the seat. */
    isBot: boolean;
    botSkill: 'easy' | 'medium' | 'hard' | null;
  }>;
}

export function toView(room: Room): RoomView {
  const staked = room.mode.staked && !room.solo;
  return {
    code: room.code,
    matchId: room.matchId,
    modeId: room.mode.id,
    modeName: room.mode.name,
    tierId: room.tier.id,
    tierName: room.tier.name,
    boardId: room.boardId,
    size: room.size,
    entry: staked ? room.tier.entry : 0,
    pot: room.state?.pot ?? (staked ? room.tier.entry * room.seats.length : 0),
    turnSeconds: turnSecondsOf(room),
    isPrivate: room.isPrivate,
    solo: room.solo,
    capacity: capacityOf(room),
    started: room.state !== null,
    hostUserId: room.hostUserId,
    players: room.seats.map((s) => ({
      userId: s.userId,
      username: s.username,
      displayName: s.displayName,
      avatarUrl: s.avatarUrl,
      seat: s.seat,
      color: s.color,
      connected: s.connected,
      ready: s.ready,
      level: s.level,
      trophies: s.trophies,
      strikerSkinId: s.strikerSkinId,
      coinSkinId: s.coinSkinId,
      isBot: s.isBot,
      botSkill: s.botSkill,
    })),
  };
}

export function allRooms(): Room[] {
  return [...rooms.values()];
}

export function roomCount(): number {
  return rooms.size;
}

/** Drop empty lobbies that were never filled. */
export function sweepRooms(now = Date.now()): number {
  let removed = 0;
  for (const room of rooms.values()) {
    const stale = room.seats.length === 0 && now - room.createdAt > 5 * 60_000;
    const abandoned =
      room.state?.status === 'finished' && room.settled && now - (room.startedAt ?? room.createdAt) > 60_000;
    if (stale || abandoned) {
      removeRoom(room);
      removed++;
    }
  }
  return removed;
}
