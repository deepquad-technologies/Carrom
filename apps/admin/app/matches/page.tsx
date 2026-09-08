'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';

interface MatchRow {
  id: string;
  mode_id: string;
  tier_id: string;
  board_id: string;
  status: string;
  end_reason: string | null;
  winner_color: string | null;
  turn_count: number;
  pot_coins: number;
  created_at: string;
  players: string[];
  flags: string;
}

interface Replay {
  match: MatchRow;
  players: Array<{
    username: string;
    seat: number;
    color: string;
    pocketed: number;
    fouls: number;
    won: boolean | null;
  }>;
  events: Array<{
    seq: number;
    seat: number | null;
    kind: string;
    payload: Record<string, unknown>;
    think_ms: number | null;
  }>;
}

/**
 * Every shot of every match is logged, so a disputed or flagged game can be
 * walked through turn by turn. Unusually fast turns are highlighted.
 */
export default function MatchesPage() {
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [suspicious, setSuspicious] = useState(false);
  const [replay, setReplay] = useState<Replay | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminApi<{ matches: MatchRow[] }>(
        `/admin/matches?suspicious=${suspicious}`,
      );
      setRows(data.matches);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [suspicious]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Matches</h1>
        <label className="flex items-center gap-2 text-sm text-white/55">
          <input
            type="checkbox"
            className="accent-brass-400"
            checked={suspicious}
            onChange={(e) => setSuspicious(e.target.checked)}
          />
          Only flagged matches
        </label>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[820px]">
          <thead className="border-b border-white/8">
            <tr>
              <th className="th">Players</th>
              <th className="th">Mode</th>
              <th className="th">Result</th>
              <th className="th">Turns</th>
              <th className="th">Pot</th>
              <th className="th">When</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/6">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-white/[0.03]">
                <td className="td">
                  {row.players.join(' vs ')}
                  {Number(row.flags) > 0 && (
                    <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-300">
                      {row.flags} flags
                    </span>
                  )}
                </td>
                <td className="td text-white/60">
                  {row.mode_id} / {row.tier_id}
                </td>
                <td className="td text-white/60">
                  {row.winner_color ? `${row.winner_color} won` : row.status}
                  {row.end_reason ? ` (${row.end_reason})` : ''}
                </td>
                <td className="td tabular-nums">{row.turn_count}</td>
                <td className="td tabular-nums text-brass-400">
                  {Number(row.pot_coins).toLocaleString()}
                </td>
                <td className="td text-white/40">{new Date(row.created_at).toLocaleString()}</td>
                <td className="td text-right">
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() =>
                      void adminApi<Replay>(`/admin/matches/${row.id}/replay`)
                        .then(setReplay)
                        .catch((err) =>
                          setError(err instanceof Error ? err.message : 'Failed to load replay'),
                        )
                    }
                  >
                    Replay
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="td text-white/40" colSpan={7}>
                  No matches to show.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {replay && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
          <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-white/10 bg-ink-900 p-6">
            <div className="flex items-start justify-between">
              <h2 className="text-lg font-bold">Match replay</h2>
              <button type="button" className="btn-ghost text-xs" onClick={() => setReplay(null)}>
                Close
              </button>
            </div>

            <div className="mt-4 space-y-1 text-sm">
              {replay.players.map((player) => (
                <div key={player.seat} className="flex gap-3 text-white/70">
                  <span className="w-8">#{player.seat}</span>
                  <span className="flex-1 font-semibold">{player.username}</span>
                  <span className="text-white/40">{player.color}</span>
                  <span className="text-white/40">{player.pocketed} pocketed</span>
                  <span className="text-white/40">{player.fouls} fouls</span>
                </div>
              ))}
            </div>

            <h3 className="mb-2 mt-6 text-xs font-semibold uppercase tracking-wider text-white/40">
              Shot log ({replay.events.length})
            </h3>

            <div className="space-y-1">
              {replay.events.map((event) => (
                <div
                  key={event.seq}
                  className="rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-[11px]"
                >
                  <div className="flex gap-3">
                    <span className="w-8 text-white/35">#{event.seq}</span>
                    <span className="w-14 text-white/50">seat {event.seat ?? '—'}</span>
                    <span className="flex-1 font-medium">{event.kind}</span>
                    {event.think_ms !== null && (
                      <span
                        className={event.think_ms < 400 ? 'font-bold text-red-300' : 'text-white/35'}
                        title="Turns answered faster than a person plausibly could are worth a look"
                      >
                        {event.think_ms}ms
                      </span>
                    )}
                  </div>
                  <pre className="mt-1 overflow-x-auto text-white/45">
                    {JSON.stringify(event.payload)}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
