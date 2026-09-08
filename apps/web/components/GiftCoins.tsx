'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatCoins } from '@carrom/config';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Avatar } from '@/components/AppShell';

/**
 * Send a friend some coins.
 *
 * Once a day, to one friend, within a capped range. The limits are enforced on
 * the server — this panel's job is to make them legible *before* someone picks
 * an amount, rather than explaining a rejection afterwards.
 */
interface Friend {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  level: number;
  /** False while the friendship is still too new to move coins across. */
  eligible: boolean;
}

interface Limits {
  maxAmount: number;
  minAmount: number;
  senderFloor: number;
  friendshipHours: number;
}

export default function GiftCoins() {
  const { profile, refresh } = useSession();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [canSendToday, setCanSendToday] = useState(true);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<string | null>(null);
  const [amount, setAmount] = useState(1_000);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ canSendToday: boolean; limits: Limits; friends: Friend[] }>(
        '/gifts/eligible',
      );
      setFriends(data.friends);
      setLimits(data.limits);
      setCanSendToday(data.canSendToday);
      setAmount(data.limits.minAmount * 2);
    } catch {
      setFriends([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    if (!chosen) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await api<{ amount: number; to: string }>('/gifts', {
        method: 'POST',
        body: { userId: chosen, amount },
      });
      setNote({ ok: true, text: `Sent ${formatCoins(result.amount)} coins to ${result.to}.` });
      setCanSendToday(false);
      setChosen(null);
      await refresh();
    } catch (err) {
      setNote({
        ok: false,
        text: err instanceof ApiError ? err.message : 'That did not go through.',
      });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;

  const giftable = friends.filter((f) => f.eligible);
  const coins = profile?.coins ?? 0;
  const affordable = limits ? coins - amount >= limits.senderFloor : false;

  return (
    <section className="panel p-5">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-lg font-semibold">Send a friend coins</h2>
        <span className="text-[11px] text-white/40">
          {canSendToday ? 'One gift a day' : 'Already sent today'}
        </span>
      </div>

      {friends.length === 0 && (
        <p className="py-4 text-sm text-white/45">
          Add a friend first. You can gift coins once you have been friends for a day.
        </p>
      )}

      {friends.length > 0 && giftable.length === 0 && (
        <p className="py-4 text-sm text-white/45">
          Your friendships are still new. Coins can be gifted after{' '}
          {limits?.friendshipHours ?? 24} hours.
        </p>
      )}

      {giftable.length > 0 && (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {giftable.map((friend) => {
              const active = chosen === friend.userId;
              return (
                <button
                  key={friend.userId}
                  type="button"
                  disabled={!canSendToday}
                  onClick={() => setChosen(active ? null : friend.userId)}
                  aria-pressed={active}
                  className={`flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${
                    active
                      ? 'border-brass-400/70 bg-brass-400/12 text-white'
                      : 'border-white/10 bg-white/[0.03] text-white/70 hover:bg-white/8'
                  }`}
                >
                  <Avatar url={friend.avatarUrl} name={friend.displayName} size={22} />
                  <span className="max-w-[110px] truncate">{friend.displayName}</span>
                </button>
              );
            })}
          </div>

          {chosen && limits && (
            <div className="animate-fade-up rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <label className="text-xs font-medium" htmlFor="gift-amount">
                  Amount
                </label>
                <span className="text-sm font-bold tabular-nums text-brass-400">
                  {formatCoins(amount)}
                </span>
              </div>

              <input
                id="gift-amount"
                type="range"
                min={limits.minAmount}
                max={limits.maxAmount}
                step={500}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-brass-400"
              />

              <p className="mt-2 text-[11px] text-white/40">
                You keep {formatCoins(Math.max(0, coins - amount))}. At least{' '}
                {formatCoins(limits.senderFloor)} has to stay with you.
              </p>

              <button
                type="button"
                className="btn-primary mt-3 w-full text-sm"
                disabled={busy || !canSendToday || !affordable}
                onClick={() => void send()}
              >
                {busy
                  ? 'Sending…'
                  : !affordable
                    ? 'Not enough coins'
                    : `Send ${formatCoins(amount)} coins`}
              </button>
            </div>
          )}
        </>
      )}

      {note && (
        <p
          className={`mt-3 animate-fade-up rounded-lg px-3 py-2 text-sm ${
            note.ok
              ? 'border border-felt-500/40 bg-felt-500/10 text-felt-400'
              : 'border border-red-500/30 bg-red-500/10 text-red-200'
          }`}
        >
          {note.text}
        </p>
      )}

      <p className="mt-3 text-[10px] leading-relaxed text-white/30">
        Gifts move virtual coins between accounts. They have no cash value and cannot be exchanged
        for money.
      </p>
    </section>
  );
}
