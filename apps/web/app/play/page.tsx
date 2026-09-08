'use client';

import { useCallback, useMemo, useState } from 'react';
import { GAME_MODE_LIST, MATCH_TIERS, TIMERS, formatCoins } from '@carrom/config';
import { BOARDS, QUICK_MESSAGES, EMOJI_REACTIONS } from '@carrom/content';
import type { Shot } from '@carrom/types';
import GameBoard from '@/components/GameBoard';
import MatchHud from '@/components/MatchHud';
import VictoryScreen from '@/components/VictoryScreen';
import { BoardPreview } from '@/components/SkinPreview';
import { useMatch } from '@/lib/useMatch';
import { useSession } from '@/lib/session';

/**
 * The three practice opponents.
 *
 * Described by how they play rather than by a number, because "medium" tells a
 * player nothing about what they are about to face.
 */
const BOT_LEVELS = [
  {
    id: 'easy' as const,
    name: 'Easy',
    icon: '\u{1F331}',
    blurb: 'Aims roughly and misses often. A fair first opponent.',
  },
  {
    id: 'medium' as const,
    name: 'Medium',
    icon: '\u{1F3AF}',
    blurb: 'Takes the obvious shot and usually makes it.',
  },
  {
    id: 'hard' as const,
    name: 'Hard',
    icon: '\u{1F525}',
    blurb: 'Hunts the queen, plays position, rarely fouls.',
  },
];

export default function PlayPage() {
  const { profile, setBalance, refresh } = useSession();
  const match = useMatch(setBalance);

  const [modeId, setModeId] = useState('quick');
  const [tierId, setTierId] = useState('beginner');
  const [boardId, setBoardId] = useState<string | undefined>(undefined);
  const [joinCode, setJoinCode] = useState('');

  const mode = GAME_MODE_LIST.find((m) => m.id === modeId) ?? GAME_MODE_LIST[0];
  const tier = MATCH_TIERS.find((t) => t.id === tierId) ?? MATCH_TIERS[0];
  const coins = profile?.coins ?? 0;

  const canAfford = !mode.staked || coins >= tier.minBalance;
  const levelOk = (profile?.level ?? 1) >= Math.max(mode.minLevel, tier.minLevel);

  const onShoot = useCallback((shot: Shot) => match.shoot(shot), [match]);

  const board = match.displayState;
  const viewSeat = match.mySeat ?? 0;

  const inMatch = board !== null && (match.phase === 'playing' || match.phase === 'animating' || match.phase === 'over');

  /* --------------------------------- in play -------------------------------- */

  if (inMatch && board) {
    return (
      <div className="animate-fade-up space-y-4">
        <MatchHud match={match} />

        <div className="grid gap-4 lg:grid-cols-[1fr_260px]">
          <div className="mx-auto w-full max-w-[min(78vh,720px)]">
            <GameBoard
              state={board}
              viewSeat={viewSeat}
              interactive={match.myTurn}
              pockets={match.pockets}
              trail={match.strikerTrail}
              onShoot={onShoot}
            />
          </div>

          <aside className="space-y-3">
            <QuickChat match={match} />
            <MatchLog match={match} />
            <button type="button" className="btn-danger w-full" onClick={match.leave}>
              Leave match
            </button>
            <p className="text-center text-[11px] text-white/30">
              Leaving an active match forfeits it.
            </p>
          </aside>
        </div>

        {match.result && (
          <VictoryScreen
            result={match.result}
            victoryId={profile?.equippedVictory ?? null}
            displayName={profile?.displayName ?? 'You'}
            avatarUrl={profile?.avatarUrl ?? null}
            onClose={() => {
              match.dismissResult();
              void refresh();
            }}
          />
        )}

        <Toasts message={match.message} error={match.error} />
      </div>
    );
  }

  /* ---------------------------------- lobby --------------------------------- */

  if (match.phase === 'lobby' && match.room && !match.room.started) {
    const room = match.room;
    return (
      <div className="mx-auto max-w-lg animate-fade-up space-y-4">
        <div className="panel p-6 text-center">
          <p className="text-xs uppercase tracking-widest text-white/40">Room code</p>
          <p className="my-3 font-display text-5xl font-bold tracking-[0.3em] text-brass-400">
            {room.code}
          </p>
          <button
            type="button"
            className="btn-ghost mx-auto text-xs"
            onClick={() => void navigator.clipboard?.writeText(room.code)}
          >
            Copy code
          </button>

          <div className="mt-6 space-y-2">
            {Array.from({ length: room.capacity }).map((_, seat) => {
              const player = room.players.find((p) => p.seat === seat);
              return (
                <div
                  key={seat}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
                    player ? 'border-white/12 bg-white/[0.04]' : 'border-dashed border-white/10'
                  }`}
                >
                  <span
                    className={`h-3 w-3 rounded-full ${
                      seat % 2 === 0 ? 'bg-white' : 'bg-ink-600 ring-1 ring-white/30'
                    }`}
                  />
                  <span className="flex-1 text-left text-sm">
                    {player ? player.displayName : 'Waiting for a player…'}
                  </span>
                  {player && (
                    <span className="text-xs text-white/40">
                      Lv {player.level} · {player.ready ? 'Ready' : 'Not ready'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-5 flex gap-2">
            <button type="button" className="btn-primary flex-1" onClick={() => match.setReady(true)}>
              I am ready
            </button>
            <button type="button" className="btn-ghost" onClick={match.leave}>
              Leave
            </button>
          </div>

          <p className="mt-4 text-xs text-white/40">
            {room.tierName} · entry {formatCoins(room.entry)} coins ·{' '}
            {TIMERS[mode.timer].turnSeconds}s a turn
          </p>
        </div>

        <Toasts message={match.message} error={match.error} />
      </div>
    );
  }

  /* --------------------------------- queued --------------------------------- */

  if (match.phase === 'queued') {
    return (
      <div className="mx-auto max-w-md animate-fade-up">
        <div className="panel p-10 text-center">
          <div className="relative mx-auto mb-6 h-24 w-24">
            <span className="absolute inset-0 animate-pulse-ring rounded-full border-2 border-brass-400/60" />
            <span className="absolute inset-0 grid place-items-center text-4xl">{'\u{1F3AF}'}</span>
          </div>
          <h2 className="font-display text-2xl font-bold">Finding an opponent</h2>
          <p className="mt-2 text-sm text-white/45">
            {match.queueInfo?.waiting ?? 1} in the {tier.name} queue
          </p>
          <button type="button" className="btn-ghost mt-6" onClick={match.cancelQueue}>
            Cancel
          </button>
        </div>
        <Toasts message={match.message} error={match.error} />
      </div>
    );
  }

  /* ------------------------------- mode chooser ------------------------------ */

  return (
    <div className="animate-fade-up space-y-5">
      <header>
        <h1 className="font-display text-3xl font-bold">Play</h1>
        <p className="text-sm text-white/45">
          {match.connected ? 'Connected' : 'Connecting…'} · Coins are virtual and have no cash value.
        </p>
      </header>

      {/* Mode */}
      <section className="panel p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">Mode</h2>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {GAME_MODE_LIST.map((option) => {
            const active = option.id === modeId;
            const locked = (profile?.level ?? 1) < option.minLevel;
            return (
              <button
                key={option.id}
                type="button"
                disabled={locked}
                onClick={() => setModeId(option.id)}
                className={`rounded-xl border p-3 text-left transition disabled:opacity-40 ${
                  active
                    ? 'border-brass-400/60 bg-brass-400/10'
                    : 'border-white/10 bg-white/[0.03] hover:border-white/25'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{option.name}</span>
                  {option.ranked && <span className="chip py-0 text-[10px]">Ranked</span>}
                  {option.seats === 4 && <span className="chip py-0 text-[10px]">4P</span>}
                </div>
                <p className="mt-1 text-[11px] leading-snug text-white/45">{option.description}</p>
                <p className="mt-1.5 text-[10px] text-white/35">
                  {TIMERS[option.timer].turnSeconds}s per turn
                  {locked ? ` · unlocks at level ${option.minLevel}` : ''}
                </p>
              </button>
            );
          })}
        </div>
      </section>

      {/* Table */}
      {mode.staked && (
        <section className="panel p-5">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-display text-lg font-semibold">Table</h2>
            <span className="text-xs text-white/40">
              Balance {formatCoins(coins)} coins
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {MATCH_TIERS.map((option) => {
              const active = option.id === tierId;
              const affordable = coins >= option.minBalance;
              const unlocked = (profile?.level ?? 1) >= option.minLevel;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={!affordable || !unlocked}
                  onClick={() => setTierId(option.id)}
                  className={`rounded-xl border p-3 text-left transition disabled:opacity-40 ${
                    active
                      ? 'border-brass-400/60 bg-brass-400/10'
                      : 'border-white/10 bg-white/[0.03] hover:border-white/25'
                  }`}
                >
                  <div className="text-sm font-semibold">{option.name}</div>
                  <div className="mt-1 text-lg font-bold tabular-nums text-brass-400">
                    {formatCoins(option.entry)}
                  </div>
                  <div className="text-[10px] text-white/35">
                    {!unlocked
                      ? `Level ${option.minLevel} required`
                      : !affordable
                        ? 'Not enough coins'
                        : `Win ${formatCoins(Math.floor(option.entry * 2 * 0.9))}`}
                  </div>
                </button>
              );
            })}
          </div>

          {!canAfford && (
            <p className="mt-3 rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
              You need more coins for that table. Drop to a lower one, or claim a free
              top-up from your profile when you run low.
            </p>
          )}
        </section>
      )}

      {/* Board picker, private rooms only */}
      {mode.matchmaking === 'code' && (
        <section className="panel p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">Board</h2>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {BOARDS.map((theme) => (
              <button
                key={theme.id}
                type="button"
                onClick={() => setBoardId(theme.id)}
                className={`shrink-0 rounded-xl border p-2 transition ${
                  boardId === theme.id
                    ? 'border-brass-400/60 bg-brass-400/10'
                    : 'border-white/10 hover:border-white/25'
                }`}
              >
                <BoardPreview theme={theme} size={104} />
                <div className="mt-1.5 text-center text-[11px] text-white/60">{theme.name}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Practice opponents. Always available, whatever mode is selected. */}
      <section className="panel p-5">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">Play a bot</h2>
          <span className="text-[11px] text-white/40">No entry fee, no stake</span>
        </div>
        <p className="mb-3 text-xs text-white/45">
          A computer opponent, right now. Good for learning a board or warming up — it plays by
          exactly the same rules you do.
        </p>

        <div className="grid gap-2 sm:grid-cols-3">
          {BOT_LEVELS.map((level) => (
            <button
              key={level.id}
              type="button"
              disabled={!match.connected}
              onClick={() => match.playBot(level.id, boardId)}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left transition hover:border-brass-400/50 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <div className="flex items-center gap-2">
                <span className="text-base leading-none">{level.icon}</span>
                <span className="text-sm font-semibold">{level.name}</span>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-white/45">{level.blurb}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Actions */}
      <section className="grid gap-3 sm:grid-cols-2">
        {mode.matchmaking === 'queue' && (
          <button
            type="button"
            className="btn-primary btn-lg"
            disabled={!match.connected || !canAfford || !levelOk}
            onClick={() => match.quickMatch(mode.id, tier.id)}
          >
            Find a match
          </button>
        )}

        {mode.matchmaking === 'code' && (
          <button
            type="button"
            className="btn-primary btn-lg"
            disabled={!match.connected || !canAfford}
            onClick={() => match.createRoom({ modeId: mode.id, tierId: tier.id, boardId })}
          >
            Create room
          </button>
        )}

        {mode.matchmaking === 'solo' && (
          <button
            type="button"
            className="btn-ghost btn-lg"
            disabled={!match.connected}
            onClick={() => match.createRoom({ modeId: mode.id, tierId: tier.id, boardId, solo: true })}
          >
            Practise both sides
          </button>
        )}

        <div className="flex gap-2">
          <input
            className="field"
            placeholder="Room code"
            maxLength={5}
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
          />
          <button
            type="button"
            className="btn-ghost shrink-0"
            disabled={joinCode.length < 4}
            onClick={() => match.joinRoom(joinCode)}
          >
            Join
          </button>
        </div>
      </section>

      <Toasts message={match.message} error={match.error} />
    </div>
  );
}

/* -------------------------------- side panels ------------------------------- */

function QuickChat({ match }: { match: ReturnType<typeof useMatch> }) {
  return (
    <div className="panel p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/40">Say</h3>
      <div className="grid grid-cols-2 gap-1.5">
        {QUICK_MESSAGES.slice(0, 6).map((message) => (
          <button
            key={message.id}
            type="button"
            className="rounded-lg border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11px] transition hover:bg-white/10"
            onClick={() => match.sendQuick(message.id)}
          >
            {message.emoji} {message.text}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {EMOJI_REACTIONS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="rounded-lg px-1.5 py-1 text-lg transition hover:bg-white/10"
            onClick={() => match.sendReaction(emoji)}
            aria-label={`React ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}

function MatchLog({ match }: { match: ReturnType<typeof useMatch> }) {
  const lines = useMemo(() => match.chat.slice(-8).reverse(), [match.chat]);

  return (
    <div className="panel max-h-64 overflow-y-auto p-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/40">Table</h3>
      {match.lastSummary && (
        <p className="mb-2 rounded-lg bg-white/[0.05] px-2.5 py-2 text-[11px] text-white/70">
          {match.lastSummary.message}
        </p>
      )}
      <ul className="space-y-1.5">
        {lines.map((line, index) => (
          <li key={`${line.at}-${index}`} className="text-[11px]">
            <span className="text-white/40">{line.from}: </span>
            <span className="text-white/80">
              {line.emoji} {line.text}
            </span>
          </li>
        ))}
        {lines.length === 0 && <li className="text-[11px] text-white/30">No messages yet.</li>}
      </ul>
    </div>
  );
}

function Toasts({ message, error }: { message: string | null; error: string | null }) {
  if (!message && !error) return null;
  return (
    <div className="pointer-events-none fixed bottom-24 left-1/2 z-40 w-[92%] max-w-sm -translate-x-1/2 space-y-2 md:bottom-6">
      {error && (
        <div className="animate-pop-in rounded-xl border border-red-500/35 bg-red-950/90 px-4 py-3 text-sm text-red-100 shadow-card backdrop-blur">
          {error}
        </div>
      )}
      {message && (
        <div className="animate-pop-in rounded-xl border border-white/12 bg-ink-900/95 px-4 py-3 text-sm text-white/85 shadow-card backdrop-blur">
          {message}
        </div>
      )}
    </div>
  );
}
