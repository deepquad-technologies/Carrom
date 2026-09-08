'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';

interface ReportRow {
  id: string;
  category: string;
  detail: string | null;
  status: 'open' | 'reviewing' | 'actioned' | 'dismissed';
  resolution: string | null;
  created_at: string;
  match_id: string | null;
  reporter_username: string;
  reported_username: string;
  reported_id: string;
  level: number;
  trophies: number;
  games_played: number;
  wins: number;
  reports_against: string;
  open_flags: string;
}

interface Detail {
  report: ReportRow;
  account: Record<string, unknown> & { username: string; win_rate: string; games_played: number };
  matches: Array<Record<string, unknown> & { id: string; mode_id: string; won: boolean | null; fouls: number; turn_count: number; created_at: string }>;
  cheatFlags: Array<{ id: string; signal: string; severity: number; detail: Record<string, unknown>; created_at: string }>;
  otherReports: Array<{ id: string; category: string; status: string; reporter: string; created_at: string }>;
  bans: Array<{ id: string; reason: string; scope: string; expires_at: string | null; lifted_at: string | null }>;
  ledger: Array<{ delta: number; reason: string; note: string | null; created_at: string }>;
}

export default function ReportsPage() {
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [counts, setCounts] = useState({ open: 0, reviewing: 0 });
  const [status, setStatus] = useState<'open' | 'reviewing' | 'actioned' | 'dismissed' | ''>('open');
  const [selected, setSelected] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await adminApi<{ reports: ReportRow[]; counts: { open: number; reviewing: number } }>(
        `/admin/moderation/reports${status ? `?status=${status}` : ''}`,
      );
      setRows(data.reports);
      setCounts(data.counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (id: string) => {
    setError(null);
    try {
      setSelected(await adminApi<Detail>(`/admin/moderation/reports/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open');
    }
  };

  const resolve = async (
    id: string,
    resolution: 'ban' | 'warn' | 'no_action' | 'duplicate',
    ban?: { reason: string; scope: 'account' | 'ranked' | 'chat'; days?: number },
    note?: string,
  ) => {
    setBusy(true);
    try {
      await adminApi(`/admin/moderation/reports/${id}/resolve`, {
        method: 'POST',
        body: { resolution, ban, note },
      });
      setSelected(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Reports</h1>
        <span className="rounded-full bg-amber-400/15 px-2.5 py-1 text-[11px] font-semibold text-amber-300">
          {counts.open} open
        </span>
        <span className="rounded-full bg-white/8 px-2.5 py-1 text-[11px] text-white/50">
          {counts.reviewing} in review
        </span>

        <div className="ml-auto flex gap-1">
          {(['open', 'reviewing', 'actioned', 'dismissed', ''] as const).map((option) => (
            <button
              key={option || 'all'}
              type="button"
              onClick={() => setStatus(option)}
              className={`rounded-lg px-3 py-1.5 text-xs capitalize ${
                status === option ? 'bg-white/12 text-white' : 'text-white/45 hover:bg-white/5'
              }`}
            >
              {option || 'all'}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead className="border-b border-white/8">
            <tr>
              <th className="th">Reported</th>
              <th className="th">Category</th>
              <th className="th">Record</th>
              <th className="th">Signals</th>
              <th className="th">By</th>
              <th className="th">When</th>
              <th className="th" />
            </tr>
          </thead>
          <tbody className="divide-y divide-white/6">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-white/[0.03]">
                <td className="td font-semibold">{row.reported_username}</td>
                <td className="td capitalize text-white/70">{row.category.replace('_', ' ')}</td>
                <td className="td text-white/55">
                  Lv {row.level} · {row.wins}/{row.games_played} wins
                </td>
                <td className="td">
                  <span className="text-white/55">{row.reports_against} reports</span>
                  {Number(row.open_flags) > 0 && (
                    <span className="ml-2 rounded bg-red-500/15 px-1.5 py-0.5 text-[11px] text-red-300">
                      {row.open_flags} flags
                    </span>
                  )}
                </td>
                <td className="td text-white/45">{row.reporter_username}</td>
                <td className="td text-white/45">
                  {new Date(row.created_at).toLocaleDateString()}
                </td>
                <td className="td text-right">
                  <button type="button" className="btn-ghost text-xs" onClick={() => void open(row.id)}>
                    Review
                  </button>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="td text-white/40" colSpan={7}>
                  Nothing here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selected && (
        <ReviewDrawer
          detail={selected}
          busy={busy}
          onClose={() => setSelected(null)}
          onResolve={resolve}
        />
      )}
    </div>
  );
}

function ReviewDrawer({
  detail,
  busy,
  onClose,
  onResolve,
}: {
  detail: Detail;
  busy: boolean;
  onClose(): void;
  onResolve(
    id: string,
    resolution: 'ban' | 'warn' | 'no_action' | 'duplicate',
    ban?: { reason: string; scope: 'account' | 'ranked' | 'chat'; days?: number },
    note?: string,
  ): Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [banReason, setBanReason] = useState('');
  const [scope, setScope] = useState<'account' | 'ranked' | 'chat'>('account');
  const [days, setDays] = useState<string>('');

  const account = detail.account;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60">
      <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-white/10 bg-ink-900 p-6">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold">{account.username}</h2>
            <p className="text-sm text-white/45 capitalize">
              Reported for {detail.report.category.replace('_', ' ')}
            </p>
          </div>
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>
            Close
          </button>
        </div>

        {detail.report.detail && (
          <p className="mt-4 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/75">
            “{detail.report.detail}”
          </p>
        )}

        <section className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Level" value={String(account.level ?? '—')} />
          <Stat label="Games" value={String(account.games_played ?? 0)} />
          <Stat label="Win rate" value={`${Math.round(Number(account.win_rate ?? 0) * 100)}%`} />
          <Stat label="Trophies" value={String(account.trophies ?? 0)} />
        </section>

        <Section title={`Anti-cheat flags (${detail.cheatFlags.length})`}>
          {detail.cheatFlags.length === 0 ? (
            <p className="text-sm text-white/40">No automated flags on this account.</p>
          ) : (
            <ul className="space-y-1.5">
              {detail.cheatFlags.slice(0, 12).map((flag) => (
                <li
                  key={flag.id}
                  className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2 text-sm"
                >
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      flag.severity >= 4
                        ? 'bg-red-500/20 text-red-300'
                        : flag.severity >= 2
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-white/10 text-white/60'
                    }`}
                  >
                    S{flag.severity}
                  </span>
                  <span className="font-medium">{flag.signal.replace(/_/g, ' ')}</span>
                  <span className="ml-auto text-[11px] text-white/35">
                    {new Date(flag.created_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Recent matches">
          <ul className="space-y-1">
            {detail.matches.slice(0, 10).map((match) => (
              <li key={match.id} className="flex gap-3 text-sm text-white/65">
                <span className="w-6 font-bold">
                  {match.won === true ? 'W' : match.won === false ? 'L' : '–'}
                </span>
                <span className="flex-1">{match.mode_id}</span>
                <span className="text-white/40">{match.turn_count} turns</span>
                <span className="text-white/40">{match.fouls} fouls</span>
                <span className="text-white/30">
                  {new Date(match.created_at).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Other reports">
          {detail.otherReports.length === 0 ? (
            <p className="text-sm text-white/40">This is the only report against them.</p>
          ) : (
            <ul className="space-y-1 text-sm text-white/60">
              {detail.otherReports.map((other) => (
                <li key={other.id} className="flex gap-3">
                  <span className="flex-1 capitalize">{other.category.replace('_', ' ')}</span>
                  <span className="text-white/40">{other.status}</span>
                  <span className="text-white/30">by {other.reporter}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {detail.bans.length > 0 && (
          <Section title="Ban history">
            <ul className="space-y-1 text-sm">
              {detail.bans.map((ban) => (
                <li key={ban.id} className="text-white/60">
                  {ban.scope} · {ban.reason}
                  {ban.lifted_at ? ' (lifted)' : ban.expires_at ? ` until ${new Date(ban.expires_at).toLocaleDateString()}` : ' (permanent)'}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Decision */}
        <section className="mt-6 rounded-xl border border-white/10 bg-ink-850 p-4">
          <h3 className="text-sm font-semibold">Decision</h3>

          <textarea
            className="field mt-3 min-h-[70px] resize-none"
            placeholder="Notes for the record (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn-ghost flex-1"
              disabled={busy}
              onClick={() => void onResolve(detail.report.id, 'no_action', undefined, note)}
            >
              No action
            </button>
            <button
              type="button"
              className="btn-ghost flex-1"
              disabled={busy}
              onClick={() => void onResolve(detail.report.id, 'warn', undefined, note)}
            >
              Warn
            </button>
            <button
              type="button"
              className="btn-ghost flex-1"
              disabled={busy}
              onClick={() => void onResolve(detail.report.id, 'duplicate', undefined, note)}
            >
              Duplicate
            </button>
          </div>

          <div className="mt-4 rounded-lg border border-red-500/25 bg-red-500/[0.06] p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-red-300">Ban</p>

            <input
              className="field mt-2"
              placeholder="Reason shown to the player"
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
            />

            <div className="mt-2 flex gap-2">
              <select
                className="field"
                value={scope}
                onChange={(e) => setScope(e.target.value as typeof scope)}
              >
                <option value="account">Whole account</option>
                <option value="ranked">Ranked only</option>
                <option value="chat">Chat only</option>
              </select>
              <input
                className="field"
                type="number"
                min={1}
                placeholder="Days (blank = permanent)"
                value={days}
                onChange={(e) => setDays(e.target.value)}
              />
            </div>

            <button
              type="button"
              className="btn-danger mt-3 w-full"
              disabled={busy || banReason.trim().length < 3}
              onClick={() =>
                void onResolve(
                  detail.report.id,
                  'ban',
                  {
                    reason: banReason.trim(),
                    scope,
                    days: days ? Number(days) : undefined,
                  },
                  note,
                )
              }
            >
              {busy ? 'Applying…' : `Ban ${account.username}`}
            </button>
            <p className="mt-2 text-[11px] text-white/35">
              Banning revokes every active session for that account immediately.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/40">{title}</h3>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.03] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-base font-bold tabular-nums">{value}</div>
    </div>
  );
}
