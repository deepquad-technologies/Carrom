'use client';

import { EMOJI_REACTIONS, boardById } from '@carrom/content';
import { PIECES_PER_SIDE } from '@carrom/config';
import GameBoard from '@/components/GameBoard';
import { Avatar } from '@/components/AppShell';
import { BoardPreview } from '@/components/SkinPreview';
import { useSpectate } from '@/lib/useSpectate';

/**
 * Spectator mode.
 *
 * The board here is read-only — `interactive={false}` means no aim guide, no
 * pointer handling and no way to emit a shot. That is a convenience, not the
 * safeguard: the server never gives a spectator a seat, so a forged shot has no
 * seat to come from and is discarded.
 */
export default function WatchPage() {
  const spectate = useSpectate();

  if (spectate.watchingId && spectate.displayState) {
    const state = spectate.displayState;
    const theme = boardById(state.boardId);
    const remaining = (color: 'white' | 'black') =>
      state.bodies.filter((b) => b.kind === color && !b.pocketed).length;

    return (
      <div className="animate-fade-up space-y-4">
        <div className="panel p-3">
          <div className="flex flex-wrap items-center gap-3">
            {spectate.players
              .slice()
              .sort((a, b) => a.seat - b.seat)
              .map((player) => {
                const isTurn = state.turnSeat === player.seat;
                return (
                  <div
                    key={player.userId}
                    className={`flex min-w-[150px] flex-1 items-center gap-2.5 rounded-xl border px-3 py-2 ${
                      isTurn ? 'border-brass-400/60 bg-brass-400/10' : 'border-white/10 bg-white/[0.03]'
                    } ${player.connected ? '' : 'opacity-50'}`}
                  >
                    <Avatar url={player.avatarUrl} name={player.displayName} size={34} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{player.displayName}</div>
                      <div className="text-[11px] text-white/45">
                        Lv {player.level} · {remaining(player.color)} left
                      </div>
                    </div>
                    <div className="text-lg font-bold tabular-nums">
                      {PIECES_PER_SIDE - remaining(player.color)}
                    </div>
                  </div>
                );
              })}

            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-center">
              <div className="text-lg font-bold tabular-nums">{spectate.secondsLeft}</div>
              <div className="text-[10px] text-white/40">seconds</div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-center">
              <div className="text-lg font-bold tabular-nums">{spectate.spectators}</div>
              <div className="text-[10px] text-white/40">watching</div>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/8 pt-2 text-[11px] text-white/45">
            <span>{theme.name}</span>
            {state.queenPending && (
              <span className="chip border-red-400/30 bg-red-500/10 text-red-200">
                Queen taken — must be covered
              </span>
            )}
            <span className="ml-auto">You are watching. You cannot affect this match.</span>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_240px]">
          <div className="relative mx-auto w-full max-w-[min(78vh,720px)]">
            <GameBoard
              state={state}
              viewSeat={0}
              interactive={false}
              pockets={spectate.pockets}
              trail={[]}
              onShoot={() => undefined}
            />

            {/* Floating reactions from other viewers. */}
            <div className="pointer-events-none absolute inset-x-0 bottom-16 flex flex-col items-center gap-1">
              {spectate.reactions.map((reaction, index) => (
                <span
                  key={`${reaction.at}-${index}`}
                  className="animate-pop-in rounded-full bg-black/60 px-3 py-1 text-sm backdrop-blur"
                >
                  {reaction.emoji}{' '}
                  <span className="text-[11px] text-white/50">{reaction.from}</span>
                </span>
              ))}
            </div>
          </div>

          <aside className="space-y-3">
            <div className="panel p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/40">
                React
              </h3>
              <div className="flex flex-wrap gap-1">
                {EMOJI_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="rounded-lg px-2 py-1.5 text-lg transition hover:bg-white/10"
                    onClick={() => spectate.react(emoji)}
                    aria-label={`React ${emoji}`}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-white/30">
                Reactions are seen by other viewers only, never by the players.
              </p>
            </div>

            {spectate.summary && (
              <div className="panel p-3 text-[11px] text-white/70">{spectate.summary.message}</div>
            )}

            {spectate.ended && (
              <div className="panel border-brass-400/30 bg-brass-400/10 p-4 text-center">
                <div className="text-lg font-bold">
                  {spectate.ended.winner ? `${spectate.ended.winner} wins` : 'Drawn board'}
                </div>
                {spectate.ended.note && (
                  <p className="mt-1 text-xs text-white/55">{spectate.ended.note}</p>
                )}
              </div>
            )}

            <button type="button" className="btn-ghost w-full" onClick={spectate.stop}>
              Stop watching
            </button>
          </aside>
        </div>

        {spectate.error && (
          <div className="fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-red-500/35 bg-red-950/90 px-4 py-3 text-sm text-red-100 md:bottom-6">
            {spectate.error}
          </div>
        )}
      </div>
    );
  }

  /* --------------------------------- browse --------------------------------- */

  return (
    <div className="animate-fade-up space-y-4">
      <header className="flex items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Watch</h1>
          <p className="text-sm text-white/45">
            {spectate.connected
              ? `${spectate.matches.length} match${spectate.matches.length === 1 ? '' : 'es'} live now`
              : 'Connecting…'}
          </p>
        </div>
        <button type="button" className="btn-ghost text-xs" onClick={spectate.refresh}>
          Refresh
        </button>
      </header>

      {spectate.error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {spectate.error}
        </div>
      )}

      {spectate.matches.length === 0 ? (
        <div className="panel p-10 text-center">
          <div className="mb-3 text-4xl opacity-30">{'\u{1F441}'}</div>
          <p className="text-sm text-white/45">
            No public matches are running right now. Check back in a moment.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {spectate.matches.map((match) => (
            <button
              key={match.matchId}
              type="button"
              onClick={() => spectate.watch(match.matchId)}
              className="panel flex items-center gap-4 p-4 text-left transition hover:border-white/25"
            >
              <BoardPreview theme={boardById(match.boardId)} size={84} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">
                    {match.players.map((p) => p.displayName).join(' vs ')}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-white/45">
                  {match.modeName} · {match.tierName} · turn {match.turnCount}
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {match.players.map((player) => (
                    <span key={player.userId} className="chip py-0.5 text-[10px]">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          player.color === 'white' ? 'bg-white' : 'bg-ink-700 ring-1 ring-white/40'
                        }`}
                      />
                      {player.pocketed}
                    </span>
                  ))}
                </div>
              </div>

              <div className="text-right">
                <div className="text-lg font-bold tabular-nums">{match.spectators}</div>
                <div className="text-[10px] text-white/40">watching</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
