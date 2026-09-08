'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  role: 'player' | 'moderator' | 'admin';
  is_guest: boolean;
  created_at: string;
  level: number;
  coins: number;
  trophies: number;
  games_played: number;
  wins: number;
  win_rate: string;
  banned: boolean;
  reports_against: string;
  open_flags: string;
}

export default function UsersPage() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<UserRow | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminApi<{ users: UserRow[] }>(
        `/admin/users${search ? `?search=${encodeURIComponent(search)}` : ''}`,
      );
      setRows(data.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [search]);

  useEffect(() => {
    void load();
  }, [load]);

  const unban = async (userId: string) => {
    setBusy(userId);
    try {
      await adminApi(`/admin/moderation/users/${userId}/unban`, { method: 'POST', body: {} });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not lift that ban');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Players</h1>
        <form
          className="ml-auto flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void load();
          }}
        >
          <input
            className="field w-56"
            placeholder="Search username or email"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit" className="btn-ghost text-xs">
            Search
          </button>
        </form>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[900px]">
          <thead className="border-b border-white/8">
            <tr>
              <th className="th">Player</th>
              <th className="th">Role</th>
              <th className="th">Level</th>
              <th className="th">Record</th>
              <th className="th">Coins</th>
              <th className="th">Signals</th>
              <th className="th">Status</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/6">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-white/[0.03]">
                <td className="td">
                  <div className="font-semibold">{row.username}</div>
                  <div className="text-[11px] text-white/35">
                    {row.email ?? (row.is_guest ? 'guest' : 'no email')}
                  </div>
                </td>
                <td className="td capitalize text-white/60">{row.role}</td>
                <td className="td tabular-nums">{row.level}</td>
                <td className="td text-white/60">
                  {row.wins}/{row.games_played}
                  <span className="ml-1.5 text-white/35">
                    ({Math.round(Number(row.win_rate) * 100)}%)
                  </span>
                </td>
                <td className="td tabular-nums text-brass-400">
                  {Number(row.coins).toLocaleString()}
                </td>
                <td className="td">
                  {Number(row.reports_against) > 0 && (
                    <span className="mr-1.5 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300">
                      {row.reports_against} reports
                    </span>
                  )}
                  {Number(row.open_flags) > 0 && (
                    <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-300">
                      {row.open_flags} flags
                    </span>
                  )}
                </td>
                <td className="td">
                  {row.banned ? (
                    <span className="rounded bg-red-500/20 px-2 py-0.5 text-[11px] font-semibold text-red-300">
                      Banned
                    </span>
                  ) : (
                    <span className="text-[11px] text-white/40">Active</span>
                  )}
                </td>
                <td className="td text-right">
                  <div className="flex justify-end gap-1.5">
                    <button
                      type="button"
                      className="btn-ghost text-xs"
                      onClick={() => setAdjusting(row)}
                    >
                      Coins
                    </button>
                    {row.banned && (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        disabled={busy === row.id}
                        onClick={() => void unban(row.id)}
                      >
                        Unban
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="td text-white/40" colSpan={8}>
                  No players match that search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {adjusting && (
        <CoinDialog
          user={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={async () => {
            setAdjusting(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/** Manual coin adjustment. Always requires a reason, always audit logged. */
function CoinDialog({
  user,
  onClose,
  onDone,
}: {
  user: UserRow;
  onClose(): void;
  onDone(): Promise<void>;
}) {
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
      <div className="panel w-full max-w-md p-6">
        <h2 className="text-lg font-bold">Adjust coins — {user.username}</h2>
        <p className="mt-1 text-sm text-white/45">
          Current balance {Number(user.coins).toLocaleString()}. Virtual currency only.
        </p>

        {error && (
          <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            {error}
          </p>
        )}

        <input
          className="field mt-4"
          type="number"
          placeholder="Amount (negative to remove)"
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
        />
        <input
          className="field mt-2"
          placeholder="Reason (required, recorded in the audit log)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />

        <div className="mt-4 flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary flex-1"
            disabled={busy || !delta || note.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await adminApi(`/admin/users/${user.id}/coins`, {
                  method: 'POST',
                  body: { delta: Number(delta), note: note.trim() },
                });
                await onDone();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not apply that');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
