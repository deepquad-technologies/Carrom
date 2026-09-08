'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppNotification } from '@carrom/types';
import { api } from '@/lib/api';
import { Avatar } from '@/components/AppShell';

/**
 * Header tools: global search and the notification bell.
 *
 * Both are panels rather than pages, because both are things you do *while*
 * doing something else — looking up an opponent halfway through picking a
 * table, or checking whether a crate finished.
 */
export default function HeaderTools() {
  const [open, setOpen] = useState<'none' | 'search' | 'bell'>('none');
  const [unread, setUnread] = useState(0);

  // Poll the unread count rather than holding a socket open for it. Once a
  // minute is often enough for a badge, and it costs one indexed count.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api<{ unread: number }>('/notifications/unread-count');
        if (!cancelled) setUnread(data.unread);
      } catch {
        // Not signed in, or the API is down; the badge simply stays put.
      }
    };
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // Ctrl/Cmd-K is where people reach for search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((prev) => (prev === 'search' ? 'none' : 'search'));
      }
      if (event.key === 'Escape') setOpen('none');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <button
        type="button"
        aria-label="Search"
        title="Search (Ctrl+K)"
        onClick={() => setOpen(open === 'search' ? 'none' : 'search')}
        className="grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/5 text-sm transition hover:bg-white/10"
      >
        {'\u{1F50D}'}
      </button>

      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        onClick={() => setOpen(open === 'bell' ? 'none' : 'bell')}
        className="relative grid h-9 w-9 place-items-center rounded-full border border-white/10 bg-white/5 text-sm transition hover:bg-white/10"
      >
        {'\u{1F514}'}
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-brass-400 px-1 text-[9px] font-black text-ink-950">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open === 'search' && <SearchPanel onClose={() => setOpen('none')} />}
      {open === 'bell' && (
        <NotificationPanel onClose={() => setOpen('none')} onRead={(count) => setUnread(count)} />
      )}
    </>
  );
}

/* --------------------------------- search --------------------------------- */

interface Hit {
  type: 'player' | 'item' | 'tournament';
  id: string;
  title: string;
  subtitle: string;
  color?: string;
  avatarUrl?: string | null;
}

interface SearchResponse {
  players: Hit[];
  items: Hit[];
  tournaments: Hit[];
  total: number;
}

function SearchPanel({ onClose }: { onClose(): void }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced, and every in-flight request is abandoned when the term changes,
  // so a fast typist never sees results for a prefix they already replaced.
  useEffect(() => {
    if (term.trim().length < 2) {
      setResults(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const data = await api<SearchResponse>(
          `/search?q=${encodeURIComponent(term.trim())}`,
          { signal: controller.signal },
        );
        setResults(data);
      } catch {
        // Aborted or failed; leave the previous results on screen.
      } finally {
        setSearching(false);
      }
    }, 220);

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [term]);

  return (
    <Overlay onClose={onClose} label="Search">
      <div className="border-b border-white/10 p-3">
        <input
          ref={inputRef}
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Players, strikers, boards, tournaments…"
          className="field"
          aria-label="Search"
        />
      </div>

      <div className="max-h-[60vh] overflow-y-auto p-2">
        {term.trim().length < 2 && (
          <p className="p-4 text-center text-xs text-white/40">Type at least two characters.</p>
        )}

        {results && results.total === 0 && !searching && (
          <p className="p-4 text-center text-xs text-white/40">Nothing matched “{term}”.</p>
        )}

        {results && (
          <>
            <Group title="Players" hits={results.players} onClose={onClose} />
            <Group title="Items" hits={results.items} onClose={onClose} />
            <Group title="Tournaments" hits={results.tournaments} onClose={onClose} />
          </>
        )}
      </div>
    </Overlay>
  );
}

function Group({ title, hits, onClose }: { title: string; hits: Hit[]; onClose(): void }) {
  if (hits.length === 0) return null;

  return (
    <section className="mb-2">
      <h3 className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white/35">
        {title}
      </h3>
      {hits.map((hit) => (
        <Link
          key={`${hit.type}-${hit.id}`}
          href={hrefFor(hit)}
          onClick={onClose}
          className="flex items-center gap-3 rounded-lg px-3 py-2 transition hover:bg-white/5"
        >
          {hit.type === 'player' ? (
            <Avatar url={hit.avatarUrl ?? null} name={hit.title} size={30} />
          ) : (
            <span
              className="h-7 w-7 rounded-lg ring-1 ring-white/15"
              style={{ background: hit.color ?? '#4a5268' }}
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{hit.title}</span>
            <span className="block truncate text-[11px] text-white/45">{hit.subtitle}</span>
          </span>
        </Link>
      ))}
    </section>
  );
}

function hrefFor(hit: Hit): string {
  if (hit.type === 'player') return `/profile?user=${hit.id}`;
  if (hit.type === 'tournament') return `/tournaments?id=${hit.id}`;
  return `/locker?item=${hit.id}`;
}

/* ------------------------------ notifications ----------------------------- */

const ICONS: Record<string, string> = {
  friend_request: '\u{1F464}',
  friend_accepted: '\u{1F91D}',
  match_invite: '\u{1F3AF}',
  crate_ready: '\u{1F381}',
  achievement: '\u{1F3C5}',
  mission: '\u{1F4CB}',
  tournament: '\u{1F3C6}',
  system: '\u{2139}\u{FE0F}',
};

function NotificationPanel({
  onClose,
  onRead,
}: {
  onClose(): void;
  onRead(unread: number): void;
}) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api<{ notifications: AppNotification[]; unread: number }>('/notifications');
      setItems(data.notifications);
      onRead(data.unread);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [onRead]);

  useEffect(() => {
    void load();
  }, [load]);

  const markAll = async () => {
    // Optimistic: the list is already on screen and the call cannot half-succeed.
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    onRead(0);
    await api('/notifications/read-all', { method: 'POST' }).catch(() => undefined);
  };

  const dismiss = async (id: string) => {
    setItems((prev) => prev.filter((n) => n.id !== id));
    await api(`/notifications/${id}`, { method: 'DELETE' }).catch(() => undefined);
  };

  return (
    <Overlay onClose={onClose} label="Notifications">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h2 className="font-display text-base font-semibold">Notifications</h2>
        <button type="button" className="text-xs text-brass-400 hover:underline" onClick={markAll}>
          Mark all read
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto">
        {loading && <p className="p-6 text-center text-xs text-white/40">Loading…</p>}

        {!loading && items.length === 0 && (
          <p className="p-8 text-center text-xs text-white/40">Nothing new.</p>
        )}

        {items.map((item) => (
          <article
            key={item.id}
            className={`flex gap-3 border-b border-white/6 px-4 py-3 last:border-0 ${
              item.readAt ? '' : 'bg-brass-400/[0.06]'
            }`}
          >
            <span className="mt-0.5 text-lg leading-none">{ICONS[item.kind] ?? '\u{2139}\u{FE0F}'}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{item.title}</div>
              <div className="text-xs leading-snug text-white/55">{item.body}</div>
              <time className="mt-1 block text-[10px] text-white/30">{relative(item.createdAt)}</time>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              className="self-start text-white/25 transition hover:text-white/70"
              onClick={() => void dismiss(item.id)}
            >
              ×
            </button>
          </article>
        ))}
      </div>
    </Overlay>
  );
}

function relative(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/* --------------------------------- shared --------------------------------- */

function Overlay({
  children,
  onClose,
  label,
}: {
  children: React.ReactNode;
  onClose(): void;
  label: string;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 p-4 pt-16 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="panel w-full max-w-lg animate-fade-up overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
      </div>
    </div>
  );
}
