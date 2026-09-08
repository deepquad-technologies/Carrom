'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminApi } from '@/lib/admin';

/**
 * Limited-time events.
 *
 * Running a double-XP weekend should be a form, not a deploy. The multiplier is
 * capped server-side and overlapping events of the same kind take the largest
 * rather than compounding, so a mistake here costs a weekend of generosity
 * rather than the economy.
 */
interface LiveEvent {
  id: string;
  name: string;
  description: string;
  kind: string;
  multiplier: number;
  accent: string;
  startsAt: string;
  endsAt: string;
  active: boolean;
}

const KINDS: Array<[string, string]> = [
  ['xp_boost', 'XP boost'],
  ['coin_boost', 'Coin boost'],
  ['crate_boost', 'Crate boost'],
  ['themed', 'Themed'],
  ['tournament', 'Tournament'],
];

function localInput(date: Date): string {
  // datetime-local wants local time with no zone, so trim the ISO string after
  // shifting by the offset.
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export default function EventsPage() {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const now = new Date();
  const [form, setForm] = useState({
    id: '',
    name: '',
    description: '',
    kind: 'xp_boost',
    multiplier: 2,
    accent: '#f2c94c',
    startsAt: localInput(now),
    endsAt: localInput(new Date(now.getTime() + 48 * 3_600_000)),
  });

  const load = useCallback(async () => {
    try {
      const data = await adminApi<{ events: LiveEvent[] }>('/admin/events');
      setEvents(data.events);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await adminApi('/admin/events', {
        method: 'POST',
        body: {
          ...form,
          multiplier: Number(form.multiplier),
          startsAt: new Date(form.startsAt).toISOString(),
          endsAt: new Date(form.endsAt).toISOString(),
          bannerId: null,
          active: true,
        },
      });
      setForm((prev) => ({ ...prev, id: '', name: '', description: '' }));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const stop = async (id: string) => {
    if (!window.confirm(`Stop "${id}" now? Players will stop seeing it immediately.`)) return;
    await adminApi(`/admin/events/${id}/stop`, { method: 'POST' }).catch(() => undefined);
    await load();
  };

  const running = (event: LiveEvent) => {
    const start = new Date(event.startsAt).getTime();
    const end = new Date(event.endsAt).getTime();
    return event.active && start <= Date.now() && end > Date.now();
  };

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Events</h1>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <section className="panel p-5">
        <h2 className="mb-3 font-semibold">Create or update</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Id" hint="Lowercase, no spaces. Reusing an id updates that event.">
            <input
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              placeholder="diwali_2026"
              className="field"
            />
          </Field>

          <Field label="Name">
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Diwali Double XP"
              className="field"
            />
          </Field>

          <Field label="Description" wide>
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Every match earns double XP all weekend."
              className="field"
            />
          </Field>

          <Field label="Kind">
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
              className="field"
            >
              {KINDS.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Multiplier" hint="1 to 10. Ignored for themed events.">
            <input
              type="number"
              min={1}
              max={10}
              step={0.5}
              value={form.multiplier}
              onChange={(e) => setForm({ ...form, multiplier: Number(e.target.value) })}
              className="field"
            />
          </Field>

          <Field label="Starts">
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
              className="field"
            />
          </Field>

          <Field label="Ends">
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
              className="field"
            />
          </Field>

          <Field label="Accent">
            <input
              type="color"
              value={form.accent}
              onChange={(e) => setForm({ ...form, accent: e.target.value })}
              className="h-9 w-full cursor-pointer rounded-lg border border-white/10 bg-white/5"
            />
          </Field>
        </div>

        <button
          type="button"
          disabled={saving || !form.id || !form.name}
          onClick={() => void save()}
          className="mt-4 rounded-xl bg-emerald-500/20 px-4 py-2 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-500/30 disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save event'}
        </button>
      </section>

      <section className="panel overflow-hidden">
        <h2 className="border-b border-white/8 px-5 py-3 font-semibold">All events</h2>

        {events.length === 0 && (
          <p className="p-8 text-center text-sm text-white/35">No events yet.</p>
        )}

        <ul className="divide-y divide-white/6">
          {events.map((event) => (
            <li key={event.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span
                className="h-8 w-1.5 shrink-0 rounded-full"
                style={{ background: event.accent }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-sm">{event.name}</b>
                  <code className="text-[10px] text-white/30">{event.id}</code>
                  {running(event) && (
                    <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                      LIVE
                    </span>
                  )}
                  {!event.active && (
                    <span className="rounded-full bg-white/8 px-2 py-0.5 text-[10px] text-white/40">
                      stopped
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-white/40">
                  {event.kind.replace('_', ' ')} · {event.multiplier}× ·{' '}
                  {new Date(event.startsAt).toLocaleString()} →{' '}
                  {new Date(event.endsAt).toLocaleString()}
                </div>
              </div>

              {event.active && (
                <button
                  type="button"
                  onClick={() => void stop(event.id)}
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-200 transition hover:bg-red-500/20"
                >
                  Stop
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Field({
  label,
  hint,
  wide,
  children,
}: {
  label: string;
  hint?: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-white/45">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[10px] text-white/30">{hint}</span>}
    </label>
  );
}
