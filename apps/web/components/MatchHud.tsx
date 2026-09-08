'use client';

import { useState } from 'react';
import { PIECES_PER_SIDE, formatCoins } from '@carrom/config';
import { boardById } from '@carrom/content';
import type { Color } from '@carrom/types';
import { Avatar } from '@/components/AppShell';
import ReportDialog from '@/components/ReportDialog';
import type { useMatch } from '@/lib/useMatch';

/**
 * The in-match header: both players, the score, the queen's status and the
 * shot clock. Everything shown here comes from the server's state.
 */
export default function MatchHud({ match }: { match: ReturnType<typeof useMatch> }) {
  const [reporting, setReporting] = useState<{ userId: string; name: string } | null>(null);

  const state = match.state;
  const room = match.room;
  if (!state || !room) return null;

  const theme = boardById(state.boardId);
  const remaining = (color: Color) =>
    state.bodies.filter((b) => b.kind === color && !b.pocketed).length;

  const timeFraction = room.turnSeconds > 0 ? match.secondsLeft / room.turnSeconds : 0;
  const urgent = match.secondsLeft <= Math.max(5, room.turnSeconds * 0.2);

  const opponents = room.players.filter((p) => p.seat !== match.mySeat);

  return (
    <>
      <div className="panel overflow-hidden">
        <div
          className="h-1 transition-[width] duration-300 ease-linear"
          style={{
            width: `${Math.max(0, timeFraction * 100)}%`,
            background: urgent ? '#ef4444' : theme.accent,
          }}
        />

        <div className="flex flex-wrap items-center gap-3 p-3">
          {room.players
            .slice()
            .sort((a, b) => a.seat - b.seat)
            .map((player) => {
              const isTurn = state.turnSeat === player.seat && state.status === 'playing';
              const isMe = player.seat === match.mySeat;
              return (
                <div
                  key={player.userId}
                  className={`flex min-w-[150px] flex-1 items-center gap-2.5 rounded-xl border px-3 py-2 transition ${
                    isTurn
                      ? 'border-brass-400/60 bg-brass-400/10'
                      : 'border-white/10 bg-white/[0.03]'
                  } ${player.connected ? '' : 'opacity-50'}`}
                >
                  <Avatar url={player.avatarUrl} name={player.displayName} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-semibold">
                        {isMe ? 'You' : player.displayName}
                      </span>
                      <span
                        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                          player.color === 'white' ? 'bg-white' : 'bg-ink-700 ring-1 ring-white/40'
                        }`}
                        title={player.color}
                      />
                      {player.isBot && (
                        <span
                          className="shrink-0 rounded border border-white/15 bg-white/8 px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-white/60"
                          title={`Computer opponent · ${player.botSkill ?? 'medium'}`}
                        >
                          Bot
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-white/45">
                      {remaining(player.color)} left
                      {player.isBot
                        ? ` · ${player.botSkill ?? 'medium'}`
                        : !player.connected && ' · reconnecting'}
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-lg font-bold tabular-nums">
                      {PIECES_PER_SIDE - remaining(player.color)}
                    </div>
                    {state.queenOwner === player.color && (
                      <div className="text-[10px] text-red-300">{'\u{1F451}'} queen</div>
                    )}
                  </div>
                </div>
              );
            })}

          <div className="flex items-center gap-2">
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2 text-center">
              <div className={`text-lg font-bold tabular-nums ${urgent ? 'text-red-400' : ''}`}>
                {match.secondsLeft}
              </div>
              <div className="text-[10px] text-white/40">seconds</div>
            </div>

            {room.pot > 0 && (
              <div className="rounded-xl border border-brass-400/25 bg-brass-400/10 px-3 py-2 text-center">
                <div className="text-lg font-bold tabular-nums text-brass-400">
                  {formatCoins(room.pot)}
                </div>
                <div className="text-[10px] text-white/40">pot</div>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-white/8 px-3 py-2 text-[11px] text-white/45">
          <span>{room.modeName}</span>
          <span>·</span>
          <span>{room.tierName}</span>
          <span>·</span>
          <span>{theme.name}</span>

          {state.queenPending && (
            <span className="chip ml-auto border-red-400/30 bg-red-500/10 text-red-200">
              Queen taken — cover it
            </span>
          )}

          {opponents.length > 0 && (
            <button
              type="button"
              className="ml-auto text-white/35 transition hover:text-white/70"
              onClick={() =>
                setReporting({ userId: opponents[0].userId, name: opponents[0].displayName })
              }
            >
              Report player
            </button>
          )}
        </div>
      </div>

      {reporting && (
        <ReportDialog
          userId={reporting.userId}
          displayName={reporting.name}
          matchId={room.matchId}
          onClose={() => setReporting(null)}
        />
      )}
    </>
  );
}
