'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatCoins } from '@carrom/config';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Tournaments: the list, and the bracket for one.
 *
 * The bracket is laid out as columns of rounds with each match centred against
 * the two it feeds from, which is what makes a knockout readable at a glance.
 * Entry and prizes are virtual coins; that is stated on the page rather than
 * buried, because it is the single most important thing about it.
 */
interface TournamentRow {
  id: string;
  name: string;
  status: 'registration' | 'running' | 'finished' | 'cancelled' | 'draft';
  entry_coins: string | number;
  max_players: number;
  registered: string | number;
  tier_id: string;
  starts_at: string;
  prize_pool: string | number;
  winner_user_id: string | null;
  joined: boolean;
}

interface BracketPlayer {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  level: number;
  seed: number | null;
  final_position: number | null;
  points: number;
}

interface BracketMatch {
  id: string;
  round: number;
  slot: number;
  status: 'pending' | 'ready' | 'running' | 'finished' | 'bye';
  player_a: string | null;
  player_b: string | null;
  player_a_name: string | null;
  player_b_name: string | null;
  winner_id: string | null;
  match_id: string | null;
}

export default function TournamentsPage() {
  const [list, setList] = useState<TournamentRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const data = await api<{ tournaments: TournamentRow[] }>('/tournaments').catch(() => ({
      tournaments: [],
    }));
    setList(data.tournaments);
    setLoading(false);
    // Deep link support: /tournaments?id=… opens straight into the bracket.
    const wanted = new URLSearchParams(window.location.search).get('id');
    if (wanted) setSelected(wanted);
    else if (!selected && data.tournaments.length > 0) setSelected(data.tournaments[0]!.id);
  }, [selected]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-display text-2xl font-bold">Tournaments</h1>
        <p className="text-sm text-white/45">
          Knockout brackets. Entry and prizes are virtual coins only — no cash value.
        </p>
      </header>

      {loading && <p className="py-10 text-center text-sm text-white/40">Loading…</p>}

      {!loading && list.length === 0 && (
        <div className="panel p-10 text-center">
          <p className="text-sm text-white/45">No tournaments are running right now.</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        {list.length > 0 && (
          <div className="space-y-2">
            {list.map((row) => (
              <TournamentCard
                key={row.id}
                row={row}
                active={selected === row.id}
                onSelect={() => setSelected(row.id)}
                onChanged={load}
              />
            ))}
          </div>
        )}

        {selected && <Bracket tournamentId={selected} />}
      </div>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  registration: 'bg-felt-500/15 text-felt-400 border-felt-500/30',
  running: 'bg-brass-400/15 text-brass-400 border-brass-400/30',
  finished: 'bg-white/8 text-white/50 border-white/12',
  cancelled: 'bg-red-500/10 text-red-300 border-red-500/25',
};

function TournamentCard({
  row,
  active,
  onSelect,
  onChanged,
}: {
  row: TournamentRow;
  active: boolean;
  onSelect(): void;
  onChanged(): Promise<void>;
}) {
  const { profile } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const entry = Number(row.entry_coins);
  const registered = Number(row.registered);
  const canAfford = (profile?.coins ?? 0) >= entry;

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/tournaments/${row.id}/${row.joined ? 'withdraw' : 'register'}`, {
        method: 'POST',
      });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not do that');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`panel w-full p-4 text-left transition ${
        active ? 'border-brass-400/50' : 'hover:border-white/20'
      }`}
    >
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <h2 className="font-semibold leading-tight">{row.name}</h2>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${
            STATUS_STYLE[row.status] ?? STATUS_STYLE.finished
          }`}
        >
          {row.status}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-1.5 text-[11px] text-white/45">
        <div>
          <dt className="inline">Entry </dt>
          <dd className="inline font-semibold text-brass-400">{formatCoins(entry)}</dd>
        </div>
        <div>
          <dt className="inline">Prize </dt>
          <dd className="inline font-semibold text-brass-400">
            {formatCoins(Number(row.prize_pool))}
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="inline">Players </dt>
          <dd className="inline font-semibold text-white/70">
            {registered} / {row.max_players}
          </dd>
        </div>
      </dl>

      <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/8">
        <div
          className="h-full rounded-full bg-brass-400/70"
          style={{ width: `${Math.min(100, (registered / row.max_players) * 100)}%` }}
        />
      </div>

      {row.status === 'registration' && (
        <div className="mt-3">
          <span
            role="button"
            tabIndex={0}
            aria-disabled={busy || (!row.joined && !canAfford)}
            onClick={(e) => {
              e.stopPropagation();
              if (!busy && (row.joined || canAfford)) void toggle();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                if (!busy && (row.joined || canAfford)) void toggle();
              }
            }}
            className={`block w-full rounded-xl px-3 py-2 text-center text-xs font-semibold transition ${
              row.joined
                ? 'border border-white/15 bg-white/5 text-white/80 hover:bg-white/10'
                : canAfford
                  ? 'bg-gradient-to-b from-brass-400 to-brass-600 text-ink-950'
                  : 'cursor-not-allowed border border-white/10 bg-white/5 text-white/30'
            }`}
          >
            {busy ? '…' : row.joined ? 'Withdraw' : canAfford ? 'Register' : 'Not enough coins'}
          </span>
          {error && <p className="mt-1.5 text-[11px] text-red-300">{error}</p>}
        </div>
      )}
    </button>
  );
}

/* -------------------------------- bracket --------------------------------- */

function Bracket({ tournamentId }: { tournamentId: string }) {
  const [players, setPlayers] = useState<BracketPlayer[]>([]);
  const [matches, setMatches] = useState<BracketMatch[]>([]);
  const [rounds, setRounds] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const data = await api<{
          players: BracketPlayer[];
          matches: BracketMatch[];
          rounds: number;
        }>(`/tournaments/${tournamentId}`);
        if (cancelled) return;
        setPlayers(data.players);
        setMatches(data.matches);
        setRounds(data.rounds);
      } catch {
        if (!cancelled) {
          setPlayers([]);
          setMatches([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tournamentId]);

  const nameOf = (userId: string | null, fallback: string | null): string => {
    if (!userId) return fallback ?? '—';
    return players.find((p) => p.user_id === userId)?.display_name ?? fallback ?? '—';
  };

  if (loading) {
    return <div className="panel grid place-items-center p-16 text-sm text-white/40">Loading…</div>;
  }

  if (matches.length === 0) {
    return (
      <div className="panel p-6">
        <h2 className="mb-3 font-display text-lg font-semibold">Registered players</h2>
        {players.length === 0 ? (
          <p className="py-8 text-center text-sm text-white/40">
            Nobody has registered yet. The bracket appears when the tournament starts.
          </p>
        ) : (
          <ol className="grid gap-1.5 sm:grid-cols-2">
            {players.map((player, index) => (
              <li
                key={player.user_id}
                className="flex items-center gap-2.5 rounded-lg bg-white/[0.03] px-3 py-2 text-sm"
              >
                <span className="w-5 text-right text-[11px] tabular-nums text-white/30">
                  {index + 1}
                </span>
                <span className="flex-1 truncate">{player.display_name}</span>
                <span className="text-[11px] text-white/35">Lv {player.level}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    );
  }

  const byRound = Array.from({ length: rounds }, (_, i) =>
    matches.filter((m) => m.round === i + 1).sort((a, b) => a.slot - b.slot),
  );

  return (
    <div className="panel overflow-x-auto p-5">
      <h2 className="mb-4 font-display text-lg font-semibold">Bracket</h2>

      <div className="flex min-w-max gap-6">
        {byRound.map((round, roundIndex) => (
          <div key={roundIndex} className="flex flex-col justify-around gap-3">
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-white/35">
              {roundName(roundIndex + 1, rounds)}
            </div>

            {round.map((match) => {
              const aWon = match.winner_id !== null && match.winner_id === match.player_a;
              const bWon = match.winner_id !== null && match.winner_id === match.player_b;
              return (
                <div
                  key={match.id}
                  className={`w-52 overflow-hidden rounded-xl border text-sm ${
                    match.status === 'running'
                      ? 'border-brass-400/60 shadow-[0_0_18px_-8px_rgb(var(--c-brass-400)/0.9)]'
                      : 'border-white/10'
                  }`}
                >
                  <Slot
                    name={nameOf(match.player_a, match.player_a_name)}
                    won={aWon}
                    decided={Boolean(match.winner_id)}
                  />
                  <div className="h-px bg-white/10" />
                  <Slot
                    name={nameOf(match.player_b, match.player_b_name)}
                    won={bWon}
                    decided={Boolean(match.winner_id)}
                  />

                  {match.status === 'running' && (
                    <div className="bg-brass-400/10 px-2.5 py-1 text-[10px] font-semibold text-brass-400">
                      Playing now
                    </div>
                  )}
                  {match.status === 'bye' && (
                    <div className="bg-white/5 px-2.5 py-1 text-[10px] text-white/40">Bye</div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {players.some((p) => p.final_position === 1) && (
        <div className="mt-5 flex items-center gap-3 rounded-xl border border-brass-400/30 bg-brass-400/8 p-4">
          <span className="text-2xl">{'\u{1F3C6}'}</span>
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wider text-brass-400">
              Champion
            </div>
            <div className="font-display text-lg font-bold">
              {players.find((p) => p.final_position === 1)?.display_name}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Slot({ name, won, decided }: { name: string; won: boolean; decided: boolean }) {
  return (
    <div
      className={`flex items-center justify-between px-2.5 py-2 ${
        won ? 'bg-felt-500/12 font-semibold' : decided ? 'bg-ink-950/40 text-white/35' : 'bg-white/[0.03]'
      }`}
    >
      <span className="truncate">{name}</span>
      {won && <span className="text-xs text-felt-400">{'✓'}</span>}
    </div>
  );
}

function roundName(round: number, total: number): string {
  const fromEnd = total - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semi-final';
  if (fromEnd === 2) return 'Quarter-final';
  return `Round ${round}`;
}
