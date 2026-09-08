'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';

interface Flag {
  id: string;
  signal: string;
  severity: number;
  detail: Record<string, unknown>;
  match_id: string | null;
  reviewed: boolean;
  created_at: string;
  user_id: string;
  username: string;
  level: number;
  trophies: number;
  games_played: number;
  wins: number;
}

/**
 * The automated anti-cheat queue. Flags never act on their own — this is the
 * list a moderator works through.
 */
export default function FlagsPage() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [showReviewed, setShowReviewed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await adminApi<{ flags: Flag[] }>(
        `/admin/moderation/flags?reviewed=${showReviewed}`,
      );
      setFlags(data.flags);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [showReviewed]);

  useEffect(() => {
    void load();
  }, [load]);

  const markReviewed = async (id: string) => {
    setBusy(id);
    try {
      await adminApi(`/admin/moderation/flags/${id}/review`, { method: 'POST' });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const runScan = async () => {
    setBusy('scan');
    try {
      await adminApi('/admin/anti-cheat/collusion-scan', { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">Anti-cheat</h1>
        <label className="flex items-center gap-2 text-sm text-white/55">
          <input
            type="checkbox"
            className="accent-brass-400"
            checked={showReviewed}
            onChange={(e) => setShowReviewed(e.target.checked)}
          />
          Show reviewed
        </label>
        <button
          type="button"
          className="btn-ghost ml-auto text-xs"
          disabled={busy === 'scan'}
          onClick={() => void runScan()}
        >
          {busy === 'scan' ? 'Scanning…' : 'Run collusion scan'}
        </button>
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </p>
      )}

      <p className="text-sm text-white/45">
        These signals are raised automatically and never ban anyone on their own. They
        exist so a person can look at a pattern and decide.
      </p>

      <div className="space-y-2">
        {flags.map((flag) => (
          <div key={flag.id} className="panel p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                  flag.severity >= 4
                    ? 'bg-red-500/20 text-red-300'
                    : flag.severity >= 2
                      ? 'bg-amber-500/20 text-amber-300'
                      : 'bg-white/10 text-white/60'
                }`}
              >
                Severity {flag.severity}
              </span>
              <span className="font-semibold capitalize">{flag.signal.replace(/_/g, ' ')}</span>
              <span className="text-sm text-white/50">
                {flag.username} · Lv {flag.level} · {flag.wins}/{flag.games_played} wins
              </span>
              <span className="ml-auto text-[11px] text-white/35">
                {new Date(flag.created_at).toLocaleString()}
              </span>
              {!flag.reviewed && (
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={busy === flag.id}
                  onClick={() => void markReviewed(flag.id)}
                >
                  Mark reviewed
                </button>
              )}
            </div>

            {Object.keys(flag.detail).length > 0 && (
              <pre className="mt-3 overflow-x-auto rounded-lg bg-black/40 p-3 text-[11px] text-white/55">
                {JSON.stringify(flag.detail, null, 2)}
              </pre>
            )}
          </div>
        ))}

        {flags.length === 0 && (
          <p className="panel p-6 text-center text-sm text-white/40">
            Nothing flagged. That is the good outcome.
          </p>
        )}
      </div>
    </div>
  );
}
