'use client';

import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';

interface Category {
  id: string;
  label: string;
}

/**
 * Report a player. The report goes to the moderation queue with the match
 * attached; a human reviews it before anything happens to the account.
 */
export default function ReportDialog({
  userId,
  displayName,
  matchId,
  onClose,
}: {
  userId: string;
  displayName: string;
  matchId?: string;
  onClose(): void;
}) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<string>('cheating');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alsoMute, setAlsoMute] = useState(true);

  useEffect(() => {
    api<{ categories: Category[] }>('/reports/categories')
      .then((data) => {
        setCategories(data.categories);
        if (data.categories[0]) setCategory(data.categories[0].id);
      })
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/reports', {
        method: 'POST',
        body: { reportedUserId: userId, category, matchId, detail: detail.trim() || undefined },
      });
      if (alsoMute) {
        await api('/reports/mute', { method: 'POST', body: { userId, muted: true } }).catch(
          () => undefined,
        );
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send that report');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="panel w-full max-w-md animate-pop-in p-6">
        {done ? (
          <div className="text-center">
            <div className="mb-3 text-4xl">{'✅'}</div>
            <h2 className="font-display text-xl font-bold">Report sent</h2>
            <p className="mt-2 text-sm text-white/55">
              Our team reviews every report. We will not share the outcome, but action is
              taken when it is warranted.
            </p>
            <button type="button" className="btn-primary mt-5 w-full" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            <h2 className="font-display text-xl font-bold">Report {displayName}</h2>
            <p className="mt-1 text-sm text-white/45">
              Tell us what happened. False reports are also reviewed.
            </p>

            {error && (
              <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                {error}
              </div>
            )}

            <div className="mt-4 space-y-2">
              {categories.map((option) => (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 text-sm transition ${
                    category === option.id
                      ? 'border-brass-400/50 bg-brass-400/10'
                      : 'border-white/10 hover:border-white/25'
                  }`}
                >
                  <input
                    type="radio"
                    name="report-category"
                    className="accent-brass-400"
                    checked={category === option.id}
                    onChange={() => setCategory(option.id)}
                  />
                  {option.label}
                </label>
              ))}
            </div>

            <div className="mt-4">
              <label className="label" htmlFor="report-detail">
                Anything else? (optional)
              </label>
              <textarea
                id="report-detail"
                className="field min-h-[80px] resize-none"
                maxLength={500}
                placeholder="What did you see?"
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
              />
            </div>

            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-white/60">
              <input
                type="checkbox"
                className="accent-brass-400"
                checked={alsoMute}
                onChange={(e) => setAlsoMute(e.target.checked)}
              />
              Also mute this player
            </label>

            <div className="mt-5 flex gap-2">
              <button type="button" className="btn-ghost flex-1" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger flex-1"
                onClick={() => void submit()}
                disabled={busy}
              >
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
