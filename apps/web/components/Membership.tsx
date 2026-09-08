'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';

/**
 * Your membership: what you have, when it renews, and how to stop it.
 *
 * Cancelling is one click and does not hide behind a support form. It also does
 * not take anything away — the membership runs to the end of the period already
 * paid for, and the panel says so before you press the button rather than after.
 */
interface Subscription {
  id: string;
  name: string;
  status: 'active' | 'past_due' | 'cancelled' | 'expired';
  currentEnd: string;
  cancelAtEnd: boolean;
  periodDays: number | null;
  active: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  past_due: 'Payment problem',
  cancelled: 'Cancelled',
  expired: 'Ended',
};

export default function Membership() {
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ subscriptions: Subscription[] }>('/subscriptions').catch(() => null);
    setSubscriptions(data?.subscriptions ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: 'cancel' | 'resume') => {
    setBusy(id);
    setNote(null);
    try {
      const result = await api<{ message?: string }>(`/subscriptions/${id}/${action}`, {
        method: 'POST',
      });
      setNote(
        result.message ??
          (action === 'resume' ? 'Your membership will renew again.' : 'Cancelled.'),
      );
      await load();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  // Nothing to manage and nothing bought: say so rather than render an empty box.
  if (subscriptions === null) return null;

  return (
    <section className="panel p-5">
      <h2 className="mb-3 font-display text-lg font-semibold">Membership</h2>

      {subscriptions.length === 0 && (
        <p className="text-sm text-white/45">
          No membership.{' '}
          <Link href="/store" className="text-brass-400 hover:underline">
            See what is included
          </Link>
          .
        </p>
      )}

      <div className="space-y-2">
        {subscriptions.map((subscription) => {
          const ends = new Date(subscription.currentEnd);
          return (
            <div
              key={subscription.id}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{subscription.name}</div>
                  <div className="text-[11px] text-white/45">
                    {subscription.active
                      ? subscription.cancelAtEnd
                        ? `Ends ${ends.toDateString()} — no further payments`
                        : `Renews ${ends.toDateString()}`
                      : `Ended ${ends.toDateString()}`}
                  </div>
                </div>

                <span
                  className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase ${
                    subscription.active && !subscription.cancelAtEnd
                      ? 'bg-felt-500/15 text-felt-400'
                      : subscription.active
                        ? 'bg-brass-400/15 text-brass-400'
                        : 'bg-white/8 text-white/45'
                  }`}
                >
                  {subscription.cancelAtEnd && subscription.active
                    ? 'Ending'
                    : (STATUS_LABEL[subscription.status] ?? subscription.status)}
                </span>
              </div>

              {subscription.active && (
                <button
                  type="button"
                  className={`mt-3 text-xs ${subscription.cancelAtEnd ? 'btn-primary' : 'btn-ghost'}`}
                  disabled={busy === subscription.id}
                  onClick={() =>
                    void act(subscription.id, subscription.cancelAtEnd ? 'resume' : 'cancel')
                  }
                >
                  {busy === subscription.id
                    ? '…'
                    : subscription.cancelAtEnd
                      ? 'Keep my membership'
                      : 'Cancel renewal'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {note && (
        <p className="mt-3 animate-fade-up rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/70">
          {note}
        </p>
      )}

      {subscriptions.some((s) => s.active) && (
        <p className="mt-3 text-[11px] leading-relaxed text-white/35">
          Cancelling stops the next payment. You keep everything until the date above.
        </p>
      )}
    </section>
  );
}
