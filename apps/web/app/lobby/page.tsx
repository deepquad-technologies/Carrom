'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Avatar } from '@/components/AppShell';
import { AdBanner } from '@/components/Ads';
import GiftCoins from '@/components/GiftCoins';

/**
 * The social lobby.
 *
 * Who is online, who you just played, what is running this weekend, and who is
 * waiting on an answer from you. Everything here is a route into a match or a
 * profile — it is a place to leave, not a place to sit.
 */
interface Friend {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  level: number;
  trophies: number;
  presence: string;
  presenceLabel: string;
  presenceColor: string;
  online: boolean;
  currentMatchId: string | null;
  watchable: boolean;
}

interface RecentPlayer {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  level: number;
  trophies: number;
  played_at: string;
  is_friend: boolean;
}

interface PendingRequest {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
}

interface LiveEvent {
  id: string;
  name: string;
  description: string;
  kind: string;
  multiplier: number;
  accent: string;
  endsAt: string;
}

export default function LobbyPage() {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [recent, setRecent] = useState<RecentPlayer[]>([]);
  const [requests, setRequests] = useState<PendingRequest[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, r, q, e] = await Promise.all([
      api<{ friends: Friend[] }>('/social/friends').catch(() => ({ friends: [] })),
      api<{ players: RecentPlayer[] }>('/social/recent').catch(() => ({ players: [] })),
      api<{ incoming: PendingRequest[] }>('/social/requests').catch(() => ({ incoming: [] })),
      api<{ active: LiveEvent[] }>('/events').catch(() => ({ active: [] })),
    ]);
    setFriends(f.friends);
    setRecent(r.players);
    setRequests(q.incoming ?? []);
    setEvents(e.active);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    // Presence goes stale quickly; a 20-second refresh is enough to feel live
    // without keeping a second socket open just for the lobby.
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const answer = async (id: string, verdict: 'accept' | 'reject') => {
    setBusy(id);
    try {
      await api(`/social/requests/${id}/${verdict}`, { method: 'POST' });
      setRequests((prev) => prev.filter((r) => r.id !== id));
      if (verdict === 'accept') await load();
    } finally {
      setBusy(null);
    }
  };

  const online = friends.filter((f) => f.online);
  const offline = friends.filter((f) => !f.online);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold">Lobby</h1>
          <p className="text-sm text-white/45">
            {loading
              ? 'Looking around…'
              : `${online.length} friend${online.length === 1 ? '' : 's'} online`}
          </p>
        </div>
        <Link href="/play" className="btn-primary text-sm">
          Find a match
        </Link>
      </header>

      {events.length > 0 && (
        <section className="space-y-2">
          {events.map((event) => (
            <div
              key={event.id}
              className="panel flex items-center gap-3 p-4"
              style={{ borderColor: `${event.accent}55` }}
            >
              <span
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-lg"
                style={{ background: `${event.accent}22`, color: event.accent }}
              >
                {'✨'}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-semibold">{event.name}</h2>
                  {event.multiplier > 1 && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-black"
                      style={{ background: event.accent, color: '#07080d' }}
                    >
                      {event.multiplier}×
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-white/50">{event.description}</p>
              </div>
              <span className="shrink-0 text-[11px] text-white/40">{until(event.endsAt)}</span>
            </div>
          ))}
        </section>
      )}

      {requests.length > 0 && (
        <section className="panel p-5">
          <h2 className="mb-3 font-display text-lg font-semibold">
            Friend requests
            <span className="ml-2 rounded-full bg-brass-400 px-2 py-0.5 text-[10px] font-black text-ink-950">
              {requests.length}
            </span>
          </h2>
          <div className="space-y-2">
            {requests.map((request) => (
              <div key={request.id} className="flex items-center gap-3 rounded-xl bg-white/[0.03] p-3">
                <Avatar url={request.avatar_url} name={request.display_name} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{request.display_name}</div>
                  <div className="truncate text-[11px] text-white/40">@{request.username}</div>
                </div>
                <button
                  type="button"
                  className="btn-primary px-3 py-1.5 text-xs"
                  disabled={busy === request.id}
                  onClick={() => void answer(request.id, 'accept')}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className="btn-ghost px-3 py-1.5 text-xs"
                  disabled={busy === request.id}
                  onClick={() => void answer(request.id, 'reject')}
                >
                  Decline
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">Friends</h2>

        {!loading && friends.length === 0 && (
          <p className="py-6 text-center text-sm text-white/40">
            No friends yet. Play a few matches, then add the people you enjoyed playing.
          </p>
        )}

        <div className="space-y-1.5">
          {online.map((friend) => (
            <FriendRow key={friend.user_id} friend={friend} />
          ))}

          {offline.length > 0 && online.length > 0 && (
            <div className="pt-3 text-[10px] font-bold uppercase tracking-wider text-white/30">
              Offline
            </div>
          )}

          {offline.map((friend) => (
            <FriendRow key={friend.user_id} friend={friend} />
          ))}
        </div>
      </section>

      <GiftCoins />

      <section className="panel p-5">
        <h2 className="mb-1 font-display text-lg font-semibold">Recently played</h2>
        <p className="mb-3 text-xs text-white/45">People you have faced across the table.</p>

        {!loading && recent.length === 0 && (
          <p className="py-6 text-center text-sm text-white/40">No matches yet.</p>
        )}

        <div className="grid gap-1.5 sm:grid-cols-2">
          {recent.slice(0, 12).map((player) => (
            <div
              key={player.user_id}
              className="flex items-center gap-3 rounded-xl bg-white/[0.03] px-3 py-2.5"
            >
              <Avatar url={player.avatar_url} name={player.display_name} size={32} />
              <Link href={`/profile?user=${player.user_id}`} className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium hover:underline">
                  {player.display_name}
                </div>
                <div className="text-[11px] text-white/40">
                  Lv {player.level} · {relative(player.played_at)}
                </div>
              </Link>
              {player.is_friend ? (
                <span className="chip text-[10px]">Friend</span>
              ) : (
                <AddFriend userId={player.user_id} />
              )}
            </div>
          ))}
        </div>
      </section>

      <AdBanner />
    </div>
  );
}

function FriendRow({ friend }: { friend: Friend }) {
  return (
    <div className="flex items-center gap-3 rounded-xl px-1 py-2 transition hover:bg-white/[0.03]">
      <span className="relative">
        <Avatar url={friend.avatar_url} name={friend.display_name} size={36} />
        <span
          className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-ink-900"
          style={{ background: friend.presenceColor }}
          title={friend.presenceLabel}
        />
      </span>

      <Link href={`/profile?user=${friend.user_id}`} className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium hover:underline">{friend.display_name}</div>
        <div className="text-[11px]" style={{ color: friend.online ? friend.presenceColor : undefined }}>
          <span className={friend.online ? '' : 'text-white/35'}>{friend.presenceLabel}</span>
          <span className="text-white/30"> · Lv {friend.level}</span>
        </div>
      </Link>

      {friend.watchable && friend.currentMatchId && (
        <Link href={`/watch?match=${friend.currentMatchId}`} className="btn-ghost px-3 py-1.5 text-xs">
          Watch
        </Link>
      )}
    </div>
  );
}

function AddFriend({ userId }: { userId: string }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');

  const send = async () => {
    setState('sending');
    try {
      await api('/social/requests', { method: 'POST', body: { userId } });
      setState('sent');
    } catch {
      setState('failed');
    }
  };

  if (state === 'sent') return <span className="chip text-[10px]">Requested</span>;

  return (
    <button
      type="button"
      className="btn-ghost px-3 py-1.5 text-xs"
      disabled={state === 'sending'}
      onClick={() => void send()}
    >
      {state === 'failed' ? 'Retry' : 'Add'}
    </button>
  );
}

function relative(iso: string): string {
  const days = (Date.now() - new Date(iso).getTime()) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 30) return `${Math.floor(days)}d ago`;
  return new Date(iso).toLocaleDateString();
}

function until(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'ending';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.ceil(ms / 60_000)}m left`;
  if (hours < 48) return `${Math.floor(hours)}h left`;
  return `${Math.floor(hours / 24)}d left`;
}
