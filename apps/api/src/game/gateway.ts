import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import {
  GAME_MODES, MATCH_TIERS, PRESENCE, TIMERS, modeById, tierById,
} from '@carrom/config';
import { isValidReaction } from '@carrom/content';
import {
  checkEmote, clearEmoteState, recipientsWhoAllowEmotes, resolveEmote,
} from '../features/emotes.js';
import {
  applyShot, applyTimeout, chooseShot, profileFor, resolveShot, seatCount, skillForLevel,
  thinkTimeFor, validateShot, type BotSkill,
} from '@carrom/game-engine';
import type { Color, Shot, ShotBroadcast } from '@carrom/types';
import { verifyAccessToken } from '../auth/tokens.js';
import { activeBans, findProfile, touchLastSeen } from '../auth/users.js';
import { one } from '../db/pool.js';
import { CORS_ORIGINS } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import {
  checkRate, checkShotTiming, dropConnection, markTurnStart, noteInvalidShot,
  noteMultiSession, noteValidShot, trackConnection,
} from './antiCheat.js';
import {
  collectEntries, markMatchCancelled, persistMatchStart, recordEvent, recordShot,
} from './matches.js';
import {
  dequeueSocket, dequeueUser, enqueue, fleetDepth, staleEntries, sweepQueues,
} from './matchmaking.js';
import { ensureBotFloat, pickBot } from '../features/bots.js';
import { expireLapsedSubscriptions } from '../features/subscriptions.js';
import {
  claimForPlay, playableMatches, releaseClaim, reportTournamentResult,
  type PlayableTournamentMatch,
} from '../features/tournaments.js';
import { settleMatch } from './rewards.js';
import {
  addSpectator, canReact, clearMatch as clearSpectators, liveMatches, redactForSpectator,
  removeSpectator, removeSpectatorEverywhere, spectatorCount, spectatorsOf, totalSpectators,
} from './spectate.js';
import { ageOutPresence, clearPresence, setPresence, touchPresence } from '../features/presence.js';
import {
  addSeat, allRooms, beginMatch, botSeats, capacityOf, createRoom, everyoneReady, getRoom,
  hasBot, isAfk, isFull, lapsedSeats, markConnection, removeRoom, removeSeat, resetTurnClock,
  roomOfSocket, roomOfUser, seatOfUser, sweepRooms, toView, turnSecondsOf,
  type Room, type Seat,
} from './rooms.js';

interface SocketAuth {
  userId: string;
  username: string;
  role: string;
  guest: boolean;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  trophies: number;
  balance: number;
  strikerSkinId: string;
  coinSkinId: string;
}

/** One entry per live socket, so we can spot an account playing itself. */
const sessionsByUser = new Map<string, Set<string>>();

export function createGateway(http: HttpServer): Server {
  const io = new Server(http, {
    cors: { origin: CORS_ORIGINS.includes('*') ? true : CORS_ORIGINS, credentials: true },
    pingInterval: PRESENCE.heartbeatMs,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e5,
  });

  /* ------------------------------ authentication ----------------------------- */

  io.use(async (socket, next) => {
    try {
      const token = String(socket.handshake.auth?.token ?? '');
      if (!token) throw new Error('Sign in to play');

      const claims = verifyAccessToken(token);

      const bans = await activeBans(claims.sub);
      const account = bans.find((b) => b.scope === 'account');
      if (account) throw new Error(`Account suspended: ${account.reason}`);

      const profile = await findProfile(claims.sub);
      if (!profile) throw new Error('Profile missing');

      const auth: SocketAuth = {
        userId: claims.sub,
        username: claims.username,
        role: claims.role,
        guest: claims.guest,
        displayName: profile.display_name,
        avatarUrl: profile.avatar_url,
        level: profile.level,
        trophies: profile.trophies,
        balance: Number(profile.coins),
        strikerSkinId: profile.equipped_striker,
        coinSkinId: profile.equipped_coin_set,
      };
      socket.data.auth = auth;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error('Could not authenticate'));
    }
  });

  const authOf = (socket: Socket): SocketAuth => socket.data.auth as SocketAuth;

  /* -------------------------------- helpers --------------------------------- */

  function broadcastRoom(room: Room): void {
    io.to(room.code).emit('room:state', toView(room));
  }

  /** Socket.IO room that only spectators of a match belong to. */
  const watchRoom = (matchId: string) => `watch:${matchId}`;

  /**
   * Push the redacted board to viewers. Spectators receive their own event on
   * their own channel, so nothing a player receives is ever addressed to them.
   */
  function broadcastToSpectators(room: Room, event: string, payload: Record<string, unknown>): void {
    if (spectatorCount(room.matchId) === 0) return;
    io.to(watchRoom(room.matchId)).emit(event, {
      ...payload,
      spectators: spectatorCount(room.matchId),
    });
  }

  function spectatorView(room: Room) {
    const state = room.state;
    return {
      matchId: room.matchId,
      boardId: room.boardId,
      modeName: room.mode.name,
      tierName: room.tier.name,
      state: state ? redactForSpectator(state) : null,
      deadline: room.turnDeadline,
      serverTime: Date.now(),
      spectators: spectatorCount(room.matchId),
      players: room.seats.map((seat) => ({
        userId: seat.userId,
        displayName: seat.displayName,
        avatarUrl: seat.avatarUrl,
        seat: seat.seat,
        color: seat.color,
        level: seat.level,
        trophies: seat.trophies,
        connected: seat.connected,
      })),
    };
  }

  function emitError(socket: Socket, message: string, code = 'error'): void {
    socket.emit('game:error', { message, code });
  }

  async function refreshSeatBalance(userId: string): Promise<number> {
    const row = await one<{ coins: number }>('SELECT coins FROM profiles WHERE user_id = $1', [userId]);
    return Number(row?.coins ?? 0);
  }

  function joinSockets(room: Room): void {
    for (const seat of room.seats) {
      if (seat.socketId) io.sockets.sockets.get(seat.socketId)?.join(room.code);
    }
  }

  async function startMatch(room: Room): Promise<void> {
    // Order matters: the coin ledger references the match, so the match row has
    // to exist before any entry fee is charged against it.
    const state = beginMatch(room);
    await persistMatchStart(room);

    const entries = await collectEntries(room);
    if (!entries.ok) {
      await markMatchCancelled(room.matchId, entries.error ?? 'entry collection failed');
      room.state = null;
      io.to(room.code).emit('lobby:error', { message: entries.error });
      return;
    }

    // Balances shown in the match header are the post-entry ones.
    for (const seat of room.seats) {
      seat.balanceBefore = await refreshSeatBalance(seat.userId);
      const player = state.players.find((p) => p.seat === seat.seat);
      if (player) player.balance = seat.balanceBefore;
    }

    await recordEvent(room.matchId, 0, 'game_start', {
      mode: room.mode.id,
      tier: room.tier.id,
      board: room.boardId,
      seats: room.seats.map((s) => ({ userId: s.userId, seat: s.seat, color: s.color })),
    });

    joinSockets(room);
    broadcastRoom(room);

    io.to(room.code).emit('game:start', {
      state,
      deadline: room.turnDeadline,
      serverTime: Date.now(),
      board: room.boardId,
    });

    for (const seat of room.seats) {
      if (seat.isBot) continue;
      markTurnStart(seat.socketId!);
      io.to(seat.socketId ?? '').emit('wallet:update', { balance: seat.balanceBefore });
      void setPresence(seat.userId, 'in_game', room.matchId);
    }

    broadcastToSpectators(room, 'watch:start', spectatorView(room));

    // If the bot breaks, it needs to know to play.
    scheduleBotTurn(room);
  }

  /**
   * Apply one shot and tell everybody about it.
   *
   * Both a human socket and a bot turn end up here, which is the point: there
   * is exactly one place where a shot is simulated, recorded and broadcast, so
   * a bot cannot accidentally get a different game to the one people play.
   */
  async function playShot(room: Room, seatIndex: number, shot: Shot, thinkMs: number): Promise<void> {
    if (!room.state) return;

    const seat = room.seats.find((s) => s.seat === seatIndex);

    // Compute the launch before applying, so clients replay the exact vector.
    const striker = resolveShot(room.state, shot);
    const summary = applyShot(room.state, shot);

    if (seat) {
      if (summary.foul) seat.fouls += 1;
      seat.skippedTurns = 0;
    }
    resetTurnClock(room);
    scheduleBotTurn(room);

    const broadcast: ShotBroadcast = {
      seq: room.state.seq,
      serverTime: Date.now(),
      seat: seatIndex,
      shot,
      striker,
      summary,
      state: room.state,
      deadline: room.turnDeadline,
    };

    io.to(room.code).emit('game:shot', broadcast);
    broadcastToSpectators(room, 'watch:shot', {
      seq: broadcast.seq,
      seat: seatIndex,
      shot,
      striker,
      summary,
      state: redactForSpectator(room.state),
      deadline: room.turnDeadline,
      serverTime: broadcast.serverTime,
    });
    void recordShot(room.matchId, room.state.seq, seatIndex, shot, summary, thinkMs);

    for (const member of room.seats) {
      if (member.socketId) markTurnStart(member.socketId);
    }

    if (room.state.status === 'finished') {
      const reason = room.state.turnCount >= 150 ? 'decision' : 'complete';
      await endMatch(room, reason);
    }
  }

  /* ------------------------------ tournaments ------------------------------ */

  /**
   * Seat a bracket pairing whose two players are both online.
   *
   * The match is claimed in the database before anything else happens, so two
   * nodes cannot seat the same pairing; if seating then fails the claim is
   * handed back rather than leaving the bracket stuck on a match nobody plays.
   */
  async function seatTournamentMatch(pairing: PlayableTournamentMatch): Promise<boolean> {
    const socketA = socketOfUser(pairing.playerA);
    const socketB = socketOfUser(pairing.playerB);
    if (!socketA || !socketB) return false;

    // Neither player may already be at a table.
    if (roomOfUser(pairing.playerA) || roomOfUser(pairing.playerB)) return false;

    if (!(await claimForPlay(pairing.id))) return false;

    try {
      const room = createRoom({
        modeId: 'tournament',
        tierId: pairing.tierId,
        boardId: pairing.boardId,
        hostUserId: pairing.playerA,
        isPrivate: false,
      });
      room.tournamentMatchId = pairing.id;
      room.tournamentId = pairing.tournamentId;

      for (const socket of [socketA, socketB]) {
        const member = authOf(socket);
        addSeat(room, {
          userId: member.userId,
          username: member.username,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
          strikerSkinId: member.strikerSkinId,
          coinSkinId: member.coinSkinId,
          level: member.level,
          trophies: member.trophies,
          balance: member.balance,
          socketId: socket.id,
        });
        socket.join(room.code);
        await dequeueUser(member.userId);
      }

      broadcastRoom(room);
      io.to(room.code).emit('tournament:matchStarting', {
        tournamentId: pairing.tournamentId,
        name: pairing.tournamentName,
        round: pairing.round,
      });

      await startMatch(room);
      logger.info(
        { bracket: pairing.id, tournament: pairing.tournamentId, match: room.matchId },
        'tournament match seated',
      );
      return true;
    } catch (err) {
      await releaseClaim(pairing.id).catch(() => undefined);
      logger.error({ err, bracket: pairing.id }, 'could not seat a tournament match');
      return false;
    }
  }

  /** The live socket for a user, if they have exactly one open. */
  function socketOfUser(userId: string): Socket | undefined {
    const ids = sessionsByUser.get(userId);
    if (!ids) return undefined;
    for (const id of ids) {
      const socket = io.sockets.sockets.get(id);
      if (socket) return socket;
    }
    return undefined;
  }

  /* --------------------------------- bots ---------------------------------- */

  /**
   * Decide when the bot whose turn it is should play.
   *
   * The delay is what makes a bot feel like an opponent rather than a reflex —
   * it is set once per turn so the pause does not change while the player
   * watches the clock.
   */
  function scheduleBotTurn(room: Room): void {
    for (const seat of room.seats) seat.botPlaysAt = null;
    if (!room.state || room.state.status !== 'playing') return;

    const seat = room.seats.find((s) => s.seat === room.state!.turnSeat);
    if (!seat?.isBot) return;

    const profile = profileFor(seat.botSkill ?? 'medium');
    // Never let the bot think past its own shot clock.
    const clockMs = Math.max(1_000, room.turnDeadline - Date.now() - 2_000);
    seat.botPlaysAt = Date.now() + Math.min(thinkTimeFor(profile), clockMs);
  }

  /** Rooms currently waiting on a bot, so one slow search cannot block another. */
  const botThinking = new Set<string>();

  async function runBotTurn(room: Room, seat: Seat): Promise<void> {
    if (!room.state || botThinking.has(room.matchId)) return;
    botThinking.add(room.matchId);

    const startedAt = Date.now();
    try {
      const profile = profileFor(seat.botSkill ?? 'medium');
      // The search yields between batches, so a bot thinking never stalls
      // anybody else's shot on this node.
      const decision = await chooseShot(room.state, profile, 220);

      // The board can move while the search runs — a timeout, or the match
      // ending. Re-check before committing anything.
      if (!room.state || room.state.status !== 'playing') return;
      if (room.state.turnSeat !== seat.seat) return;

      const check = validateShot(room.state, seat.seat, decision.shot);
      if (!check.ok) {
        logger.warn({ match: room.matchId, reason: check.reason }, 'bot produced an illegal shot');
        return;
      }

      await playShot(room, seat.seat, decision.shot, Date.now() - startedAt);
    } catch (err) {
      logger.error({ err, match: room.matchId }, 'bot turn failed');
    } finally {
      botThinking.delete(room.matchId);
      seat.botPlaysAt = null;
    }
  }

  /**
   * Seat a bot opposite a player who has waited long enough.
   *
   * The bot pays its entry fee from its own balance like anybody else, so this
   * moves coins rather than creating them.
   */
  async function seatBotAgainst(
    entry: { userId: string; socketId: string },
    modeId: string,
    tierId: string,
    skill: BotSkill,
  ): Promise<boolean> {
    const memberSocket = io.sockets.sockets.get(entry.socketId);
    if (!memberSocket) return false;

    const member = authOf(memberSocket);
    const mode = modeById(modeId) ?? GAME_MODES.quick;
    const tier = tierById(tierId) ?? MATCH_TIERS[0];

    const bot = await pickBot(skill);
    if (!bot) return false;

    if (mode.staked) await ensureBotFloat(bot.userId, tier.entry);

    const room = createRoom({
      modeId: mode.id,
      tierId: tier.id,
      hostUserId: member.userId,
      isPrivate: false,
    });

    addSeat(room, {
      userId: member.userId,
      username: member.username,
      displayName: member.displayName,
      avatarUrl: member.avatarUrl,
      strikerSkinId: member.strikerSkinId,
      coinSkinId: member.coinSkinId,
      level: member.level,
      trophies: member.trophies,
      balance: member.balance,
      socketId: entry.socketId,
    });
    memberSocket.join(room.code);

    addSeat(room, {
      userId: bot.userId,
      username: bot.username,
      displayName: bot.displayName,
      avatarUrl: bot.avatarUrl,
      strikerSkinId: bot.strikerSkinId,
      coinSkinId: bot.coinSkinId,
      level: bot.level,
      trophies: bot.trophies,
      balance: bot.coins,
      socketId: null,
      isBot: true,
      botSkill: bot.skill,
    });

    // A bot match is not a spectacle for other players.
    room.isSpectatable = false;

    await dequeueUser(member.userId);
    broadcastRoom(room);
    await startMatch(room);

    logger.info(
      { match: room.matchId, player: member.userId, bot: bot.username, skill },
      'seated a bot opponent',
    );
    return true;
  }

  async function endMatch(
    room: Room,
    reason: 'complete' | 'forfeit' | 'abandoned' | 'cancelled' | 'decision',
    forcedWinner: Color | null = null,
    note?: string,
  ): Promise<void> {
    const result = await settleMatch(room, reason, forcedWinner);

    await recordEvent(room.matchId, (room.state?.seq ?? 0) + 1, 'game_end', {
      reason,
      winner: result.winner,
      points: result.points,
    });

    io.to(room.code).emit('game:over', { ...result, note, state: room.state });

    broadcastToSpectators(room, 'watch:over', {
      winner: result.winner,
      points: result.points,
      note,
      state: room.state ? redactForSpectator(room.state) : null,
    });
    clearSpectators(room.matchId);

    for (const seat of room.seats) {
      if (!seat.isBot) void setPresence(seat.userId, 'online');
    }

    // A bracket only advances when somebody tells it the match is over. Doing
    // this after settlement means a reporting failure costs a bracket step that
    // an operator can repair, never the players' payout.
    if (room.tournamentMatchId) {
      const winningSeat = room.seats.find((s) => s.color === result.winner);
      if (winningSeat) {
        reportTournamentResult(room.tournamentMatchId, winningSeat.userId, room.matchId).catch(
          (err) =>
            logger.error(
              { err, match: room.matchId, bracket: room.tournamentMatchId },
              'could not advance the tournament bracket',
            ),
        );
      } else {
        // A draw leaves the slot playable again rather than stalling the bracket.
        releaseClaim(room.tournamentMatchId).catch(() => undefined);
      }
    }

    for (const seat of room.seats) {
      const reward = result.rewards[seat.userId];
      if (seat.socketId && reward) {
        io.to(seat.socketId).emit('wallet:update', { balance: reward.balance });
      }
    }
    broadcastRoom(room);
  }

  /* ------------------------------- connection ------------------------------- */

  io.on('connection', (socket) => {
    const auth = authOf(socket);
    trackConnection(socket.id, auth.userId);

    const sessions = sessionsByUser.get(auth.userId) ?? new Set<string>();
    sessions.add(socket.id);
    sessionsByUser.set(auth.userId, sessions);
    if (sessions.size > 1) void noteMultiSession(auth.userId, sessions.size);

    void touchLastSeen(auth.userId);
    void setPresence(auth.userId, 'online');

    socket.emit('session', {
      userId: auth.userId,
      username: auth.username,
      displayName: auth.displayName,
      balance: auth.balance,
      level: auth.level,
      trophies: auth.trophies,
      serverTime: Date.now(),
    });

    // Rejoin a match still in progress after a refresh or a dropped connection.
    const existing = roomOfUser(auth.userId);
    if (existing && existing.state && existing.state.status === 'playing') {
      markConnection(existing, auth.userId, socket.id);
      socket.join(existing.code);
      socket.emit('game:resume', {
        state: existing.state,
        deadline: existing.turnDeadline,
        serverTime: Date.now(),
        board: existing.boardId,
        chat: existing.chat.slice(-20),
      });
      broadcastRoom(existing);
      io.to(existing.code).emit('player:reconnect', { userId: auth.userId });
    }

    /* -------------------------------- lobby -------------------------------- */

    socket.on('lobby:quickMatch', async (payload: { modeId?: string; tierId?: string }) => {
      const gate = await checkRate(socket.id, 'lobby');
      if (!gate.ok) return emitError(socket, gate.reason!, 'rate_limited');

      const mode = modeById(payload?.modeId) ?? GAME_MODES.quick;
      const tier = tierById(payload?.tierId) ?? MATCH_TIERS[0];

      if (mode.matchmaking !== 'queue') {
        return emitError(socket, 'That mode uses a room code', 'wrong_mode');
      }
      if (auth.level < Math.max(mode.minLevel, tier.minLevel)) {
        return emitError(
          socket,
          `Reach level ${Math.max(mode.minLevel, tier.minLevel)} to play ${tier.name}`,
          'level_locked',
        );
      }
      if (mode.ranked) {
        const bans = await activeBans(auth.userId);
        if (bans.some((b) => b.scope === 'ranked')) {
          return emitError(socket, 'You are restricted from ranked play', 'banned');
        }
      }

      const balance = await refreshSeatBalance(auth.userId);
      if (mode.staked && balance < tier.minBalance) {
        return emitError(
          socket,
          `You need ${tier.entry.toLocaleString()} coins for the ${tier.name}`,
          'insufficient_coins',
        );
      }

      const result = await enqueue(mode.id, tier.id, {
        userId: auth.userId,
        socketId: socket.id,
        trophies: auth.trophies,
      });

      void setPresence(auth.userId, 'in_matchmaking');

      if (!result.matched) {
        return socket.emit('lobby:queued', {
          modeId: mode.id,
          tierId: tier.id,
          waiting: result.waiting,
          fleetWaiting: await fleetDepth(mode.id, tier.id),
        });
      }

      const room = createRoom({
        modeId: mode.id,
        tierId: tier.id,
        hostUserId: result.matched[0].userId,
        isPrivate: false,
      });

      for (const entry of result.matched) {
        const memberSocket = io.sockets.sockets.get(entry.socketId);
        if (!memberSocket) continue;
        const member = authOf(memberSocket);
        addSeat(room, {
          userId: member.userId,
          username: member.username,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
          strikerSkinId: member.strikerSkinId,
          coinSkinId: member.coinSkinId,
          level: member.level,
          trophies: member.trophies,
          balance: member.balance,
          socketId: entry.socketId,
        });
        memberSocket.join(room.code);
      }

      if (room.seats.length < seatCount(room.size)) {
        // Someone vanished between queueing and seating; put the rest back.
        for (const seat of room.seats) {
          if (!seat.socketId) continue;
          await enqueue(mode.id, tier.id, {
            userId: seat.userId,
            socketId: seat.socketId,
            trophies: seat.trophies,
          });
        }
        removeRoom(room);
        return;
      }

      broadcastRoom(room);
      await startMatch(room);
    });

    /**
     * Play a bot on purpose.
     *
     * Distinct from the matchmaking fallback: here the player chooses the
     * difficulty, so it is a practice board rather than a substitute for a real
     * opponent. Practice is unstaked, which is why it can be started instantly
     * and why it pays only a token amount of XP.
     */
    socket.on('lobby:playBot', async (payload: { skill?: string; boardId?: string }) => {
      const gate = await checkRate(socket.id, 'lobby');
      if (!gate.ok) return emitError(socket, gate.reason!, 'rate_limited');

      const requested = String(payload?.skill ?? 'medium');
      const skill: BotSkill =
        requested === 'easy' || requested === 'medium' || requested === 'hard'
          ? requested
          : 'medium';

      const bot = await pickBot(skill);
      if (!bot) return emitError(socket, 'No practice opponents are available', 'no_bot');

      // Leaving a lobby you had not started is fine; leaving a live match is not.
      const previous = roomOfUser(auth.userId);
      if (previous?.state && previous.state.status === 'playing') {
        return emitError(socket, 'Finish your current match first', 'already_playing');
      }
      if (previous && !previous.state) removeSeat(previous, auth.userId);

      await dequeueUser(auth.userId);

      const room = createRoom({
        modeId: 'practice',
        tierId: MATCH_TIERS[0].id,
        boardId: payload?.boardId,
        hostUserId: auth.userId,
        isPrivate: true,
      });
      // Practice against a bot is a two-seat board, not the solo table where
      // one player drives both sides.
      room.solo = false;
      room.isSpectatable = false;

      addSeat(room, {
        userId: auth.userId,
        username: auth.username,
        displayName: auth.displayName,
        avatarUrl: auth.avatarUrl,
        strikerSkinId: auth.strikerSkinId,
        coinSkinId: auth.coinSkinId,
        level: auth.level,
        trophies: auth.trophies,
        balance: auth.balance,
        socketId: socket.id,
      });
      socket.join(room.code);

      addSeat(room, {
        userId: bot.userId,
        username: bot.username,
        displayName: bot.displayName,
        avatarUrl: bot.avatarUrl,
        strikerSkinId: bot.strikerSkinId,
        coinSkinId: bot.coinSkinId,
        level: bot.level,
        trophies: bot.trophies,
        balance: bot.coins,
        socketId: null,
        isBot: true,
        botSkill: bot.skill,
      });

      broadcastRoom(room);
      await startMatch(room);

      logger.info(
        { match: room.matchId, player: auth.userId, bot: bot.username, skill },
        'practice match against a bot',
      );
    });

    socket.on('lobby:cancel', async () => {
      await dequeueSocket(socket.id);
      await setPresence(auth.userId, 'online');
      socket.emit('lobby:cancelled', {});
    });

    // Keeps a session from drifting to "away" while the app is open.
    socket.on('presence:heartbeat', () => {
      void touchPresence(auth.userId);
    });

    socket.on(
      'lobby:createRoom',
      async (payload: { modeId?: string; tierId?: string; boardId?: string; solo?: boolean }) => {
        const gate = await checkRate(socket.id, 'lobby');
        if (!gate.ok) return emitError(socket, gate.reason!, 'rate_limited');

        const mode = modeById(payload?.modeId) ?? GAME_MODES.private;
        const tier = tierById(payload?.tierId) ?? MATCH_TIERS[0];
        const solo = Boolean(payload?.solo) || mode.matchmaking === 'solo';

        const balance = await refreshSeatBalance(auth.userId);
        if (mode.staked && !solo && balance < tier.minBalance) {
          return emitError(
            socket,
            `You need ${tier.entry.toLocaleString()} coins for the ${tier.name}`,
            'insufficient_coins',
          );
        }

        const previous = roomOfUser(auth.userId);
        if (previous && !previous.state) removeSeat(previous, auth.userId);

        const room = createRoom({
          modeId: mode.id,
          tierId: tier.id,
          boardId: payload?.boardId,
          hostUserId: auth.userId,
          isPrivate: true,
          solo,
        });

        addSeat(room, { ...auth, socketId: socket.id, balance });
        socket.join(room.code);
        broadcastRoom(room);
        socket.emit('lobby:roomCreated', { code: room.code });

        if (solo) await startMatch(room);
      },
    );

    socket.on('lobby:joinRoom', async (payload: { code?: string }) => {
      const gate = await checkRate(socket.id, 'lobby');
      if (!gate.ok) return emitError(socket, gate.reason!, 'rate_limited');

      const room = getRoom(String(payload?.code ?? ''));
      if (!room) return emitError(socket, 'No table with that code', 'no_room');

      const rejoining = Boolean(seatOfUser(room, auth.userId));
      if (!rejoining) {
        if (room.state) return emitError(socket, 'That match already started', 'already_started');
        if (isFull(room)) return emitError(socket, 'That table is full', 'room_full');

        const balance = await refreshSeatBalance(auth.userId);
        if (room.mode.staked && balance < room.tier.minBalance) {
          return emitError(socket, 'You cannot cover the entry for that table', 'insufficient_coins');
        }
        addSeat(room, { ...auth, socketId: socket.id, balance });
      } else {
        markConnection(room, auth.userId, socket.id);
      }

      socket.join(room.code);
      broadcastRoom(room);

      if (room.state) {
        socket.emit('game:resume', {
          state: room.state,
          deadline: room.turnDeadline,
          serverTime: Date.now(),
          board: room.boardId,
          chat: room.chat.slice(-20),
        });
      } else if (everyoneReady(room)) {
        await startMatch(room);
      }
    });

    socket.on('lobby:ready', async (payload: { ready?: boolean }) => {
      const room = roomOfSocket(socket.id);
      if (!room || room.state) return;
      const seat = seatOfUser(room, auth.userId);
      if (!seat) return;

      seat.ready = payload?.ready !== false;
      broadcastRoom(room);
      if (everyoneReady(room)) await startMatch(room);
    });

    /* --------------------------------- play -------------------------------- */

    socket.on('game:shot', async (payload: { shot?: Shot }) => {
      const gate = await checkRate(socket.id, 'shot');
      if (!gate.ok) {
        emitError(socket, gate.reason!, 'rate_limited');
        if (gate.disconnect) socket.disconnect(true);
        return;
      }

      const room = roomOfSocket(socket.id);
      if (!room || !room.state) return emitError(socket, 'You are not in a match', 'no_match');

      const seat = seatOfUser(room, auth.userId);
      if (!seat) return emitError(socket, 'You are not seated', 'no_seat');

      // In solo practice the single player takes whichever seat is to move.
      const seatIndex = room.solo ? room.state.turnSeat : seat.seat;

      const check = validateShot(room.state, seatIndex, payload?.shot);
      if (!check.ok) {
        const verdict = await noteInvalidShot(socket.id, room.matchId, check.reason!, payload?.shot);
        emitError(socket, check.reason!, 'invalid_shot');
        if (verdict.disconnect) socket.disconnect(true);
        return;
      }

      const timing = await checkShotTiming(socket.id, room.matchId, room.turnStartedAt);
      if (!timing.ok) return emitError(socket, timing.reason!, 'too_fast');

      noteValidShot(socket.id);

      await playShot(room, seatIndex, payload!.shot as Shot, Date.now() - room.turnStartedAt);
    });

    /* --------------------------------- chat -------------------------------- */

    socket.on('chat:quick', async (payload: { messageId?: string; emoji?: string }) => {
      const gate = await checkRate(socket.id, 'chat');
      if (!gate.ok) return emitError(socket, gate.reason!, 'rate_limited');

      const room = roomOfSocket(socket.id);
      if (!room) return;

      const bans = await activeBans(auth.userId);
      if (bans.some((b) => b.scope === 'chat' || b.scope === 'account')) {
        return emitError(socket, 'You are restricted from chat', 'banned');
      }

      // Only preset phrases and approved reactions ever reach the wire.
      const emote = resolveEmote(payload ?? {});
      if (!emote) return;

      // Cooldown and per-minute cap, so an opponent cannot be spammed.
      const verdict = checkEmote(auth.userId);
      if (!verdict.ok) {
        return socket.emit('chat:blocked', {
          message: verdict.reason,
          retryInSeconds: verdict.retryInSeconds ?? 1,
        });
      }

      const line = {
        userId: auth.userId,
        from: auth.displayName,
        messageId: emote.messageId,
        text: emote.text,
        emoji: emote.emoji,
        at: Date.now(),
      };
      room.chat.push(line);
      if (room.chat.length > 60) room.chat.shift();

      // Anyone who has muted emotes simply never receives it.
      const allowed = await recipientsWhoAllowEmotes(
        room.seats.map((seat) => seat.userId),
        auth.userId,
      );
      for (const seat of room.seats) {
        if (seat.socketId && allowed.has(seat.userId)) {
          io.to(seat.socketId).emit('chat:message', line);
        }
      }
    });

    /* ------------------------------- spectating ------------------------------ */

    socket.on('watch:list', async () => {
      const gate = await checkRate(socket.id, 'lobby');
      if (!gate.ok) return emitError(socket, gate.reason!, 'rate_limited');
      socket.emit('watch:list', { matches: liveMatches(allRooms()) });
    });

    socket.on('watch:join', async (payload: { matchId?: string }) => {
      const gate = await checkRate(socket.id, 'lobby');
      if (!gate.ok) return emitError(socket, gate.reason!, 'rate_limited');

      const room = allRooms().find((r) => r.matchId === payload?.matchId);
      if (!room) return emitError(socket, 'That match is no longer live', 'no_match');

      const verdict = addSpectator(room, {
        userId: auth.userId,
        socketId: socket.id,
        displayName: auth.displayName,
        avatarUrl: auth.avatarUrl,
      });
      if (!verdict.ok) return emitError(socket, verdict.reason!, 'cannot_watch');

      socket.join(watchRoom(room.matchId));
      socket.emit('watch:start', spectatorView(room));

      // Players see the viewer count, never who is watching.
      io.to(room.code).emit('watch:count', { spectators: spectatorCount(room.matchId) });
      broadcastToSpectators(room, 'watch:count', {});
    });

    socket.on('watch:leave', () => {
      const matchId = removeSpectatorEverywhere(auth.userId);
      if (!matchId) return;
      socket.leave(watchRoom(matchId));

      const room = allRooms().find((r) => r.matchId === matchId);
      if (room) {
        io.to(room.code).emit('watch:count', { spectators: spectatorCount(matchId) });
        broadcastToSpectators(room, 'watch:count', {});
      }
      socket.emit('watch:left', { matchId });
    });

    /**
     * A spectator reaction. It carries an approved emoji and nothing else, is
     * rate limited per viewer, and is delivered only to other spectators — it
     * never reaches the players, so it cannot be used to signal a table.
     */
    socket.on('watch:react', (payload: { emoji?: string }) => {
      const room = allRooms().find((r) =>
        spectatorsOf(r.matchId).some((viewer) => viewer.userId === auth.userId),
      );
      if (!room) return;

      const emoji = payload?.emoji;
      if (!emoji || !isValidReaction(emoji)) return;
      if (!canReact(room.matchId, auth.userId)) {
        return emitError(socket, 'Slow down with the reactions', 'rate_limited');
      }

      io.to(watchRoom(room.matchId)).emit('watch:reaction', {
        from: auth.displayName,
        emoji,
        at: Date.now(),
      });
    });

    /* -------------------------------- leaving ------------------------------- */

    socket.on('room:leave', async () => {
      const room = roomOfSocket(socket.id);
      if (!room) return;
      socket.leave(room.code);
      await handleExit(room, auth.userId, true);
    });

    socket.on('disconnect', async () => {
      dropConnection(socket.id);
      await dequeueSocket(socket.id);

      const watchedMatch = removeSpectatorEverywhere(auth.userId);
      if (watchedMatch) {
        const watched = allRooms().find((r) => r.matchId === watchedMatch);
        if (watched) {
          io.to(watched.code).emit('watch:count', { spectators: spectatorCount(watchedMatch) });
        }
      }

      await clearPresence(auth.userId);

      const set = sessionsByUser.get(auth.userId);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          sessionsByUser.delete(auth.userId);
          clearEmoteState(auth.userId);
        }
      }

      const room = roomOfSocket(socket.id);
      if (room) await handleExit(room, auth.userId, false);
    });

    /** Shared path for a deliberate exit and a dropped connection. */
    async function handleExit(room: Room, userId: string, deliberate: boolean): Promise<void> {
      const seat = seatOfUser(room, userId);
      if (!seat) return;

      markConnection(room, userId, null);

      if (!room.state) {
        // Nothing has been staked yet, so just free the seat.
        removeSeat(room, userId);
        if (room.seats.length === 0) removeRoom(room);
        else broadcastRoom(room);
        return;
      }

      if (room.state.status !== 'playing') return;

      if (deliberate) {
        const winner: Color = seat.color === 'white' ? 'black' : 'white';
        room.state.status = 'finished';
        room.state.winner = winner;
        await endMatch(room, 'forfeit', winner, `${seat.displayName} left the table`);
        return;
      }

      broadcastRoom(room);
      io.to(room.code).emit('player:disconnect', {
        userId,
        displayName: seat.displayName,
        reconnectWindowMs: PRESENCE.reconnectWindowMs,
      });
    }
  });

  /* ------------------------------- server tick ------------------------------ */

  const tick = setInterval(() => {
    void runTick();
  }, 1_000);
  tick.unref();

  /** Throttles the subscription sweep; the tick itself runs every second. */
  let lastSubscriptionSweep = 0;

  async function runTick(): Promise<void> {
    const now = Date.now();

    for (const room of allRooms()) {
      const state = room.state;
      if (!state || state.status !== 'playing') continue;

      // A bot whose thinking time is up plays now. Started, not awaited: a
      // search must never hold up the tick for every other match.
      if (hasBot(room)) {
        const thinking = botSeats(room).find(
          (s) => s.botPlaysAt !== null && now >= s.botPlaysAt && s.seat === state.turnSeat,
        );
        if (thinking) void runBotTurn(room, thinking);
      }

      // Someone did not come back inside the reconnection window.
      const lapsed = lapsedSeats(room, now);
      if (lapsed.length > 0) {
        const gone = lapsed[0];
        const winner: Color = gone.color === 'white' ? 'black' : 'white';
        state.status = 'finished';
        state.winner = winner;
        await endMatch(room, 'abandoned', winner, `${gone.displayName} did not come back`);
        continue;
      }

      if (now <= room.turnDeadline) continue;

      // The clock ran out: a foul, the turn passes, and repeated misses are AFK.
      const seatIndex = state.turnSeat;
      const seat = room.seats.find((s) => s.seat === seatIndex);
      const summary = applyTimeout(state);
      if (!summary) continue;

      if (seat) {
        seat.skippedTurns += 1;
        seat.fouls += 1;
      }
      resetTurnClock(room);

      io.to(room.code).emit('game:timeout', {
        seat: seatIndex,
        summary,
        state,
        deadline: room.turnDeadline,
        serverTime: Date.now(),
      });
      broadcastToSpectators(room, 'watch:timeout', {
        seat: seatIndex,
        summary,
        state: redactForSpectator(state),
        deadline: room.turnDeadline,
      });
      void recordEvent(room.matchId, state.seq, 'turn_timeout', { seat: seatIndex }, seatIndex);

      // applyTimeout can end the board at the turn cap, so re-read the status
      // through the room rather than the already-narrowed local.
      if (room.state?.status === 'finished') {
        await endMatch(room, 'decision');
        continue;
      }

      if (seat && isAfk(seat) && !room.solo) {
        const winner: Color = seat.color === 'white' ? 'black' : 'white';
        state.status = 'finished';
        state.winner = winner;
        await endMatch(room, 'abandoned', winner, `${seat.displayName} is away`);
      }
    }

    await sweepQueues((socketId) => io.sockets.sockets.has(socketId));

    // Bracket pairings whose players are both online get seated automatically.
    for (const pairing of await playableMatches().catch(() => [])) {
      const seated = await seatTournamentMatch(pairing).catch((err) => {
        logger.error({ err, bracket: pairing.id }, 'tournament seating failed');
        return false;
      });
      if (seated) break;
    }

    // Nobody to play against? Offer a bot rather than a spinner.
    for (const entry of staleEntries(now)) {
      const socket = io.sockets.sockets.get(entry.socketId);
      if (!socket) continue;

      const member = authOf(socket);
      const skill = skillForLevel(member.level, member.trophies);
      const seated = await seatBotAgainst(entry, entry.modeId, entry.tierId, skill).catch((err) => {
        logger.error({ err, user: entry.userId }, 'could not seat a bot');
        return false;
      });
      // One per tick: seating is the expensive part, and the next tick is a
      // second away.
      if (seated) break;
    }

    await ageOutPresence();
    sweepRooms(now);

    // Retire lapsed memberships once a minute. A subscription that ran out and
    // was never renewed must stop granting ad-free, otherwise a missing webhook
    // becomes a free membership forever.
    if (now - lastSubscriptionSweep > 60_000) {
      lastSubscriptionSweep = now;
      expireLapsedSubscriptions().catch((err) =>
        logger.error({ err }, 'subscription sweep failed'),
      );
    }
  }

  io.engine.on('connection_error', (err: { message: string; code: number }) => {
    logger.debug({ code: err.code, message: err.message }, 'socket connection rejected');
  });

  logger.info(
    { modes: Object.keys(GAME_MODES).length, tiers: MATCH_TIERS.length, timers: Object.keys(TIMERS).length },
    'realtime gateway ready',
  );

  return io;
}

export function liveStats() {
  const rooms = allRooms();
  return {
    rooms: rooms.length,
    playing: rooms.filter((r) => r.state?.status === 'playing').length,
    seated: rooms.reduce((sum, r) => sum + r.seats.length, 0),
    spectators: totalSpectators(),
    sessions: sessionsByUser.size,
  };
}

export { dequeueUser, capacityOf, turnSecondsOf };
