'use client';

import { useState } from 'react';
import { usePreferences } from '@/lib/preferences';
import { useSession } from '@/lib/session';
import Tutorial from '@/components/Tutorial';
import Membership from '@/components/Membership';

/**
 * Settings: appearance, accessibility, audio and social.
 *
 * Every control writes through to the server immediately — there is no Save
 * button to forget. Accessibility sits above audio because a player who needs
 * it should not have to scroll past volume sliders to find it.
 */
export default function SettingsPage() {
  const { prefs, themes, update } = usePreferences();
  const { user, signOut } = useSession();
  const [replayTutorial, setReplayTutorial] = useState(false);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <h1 className="font-display text-2xl font-bold">Settings</h1>
        <p className="text-sm text-white/45">
          These follow your account, so they apply on every device you sign in on.
        </p>
      </header>

      {/* ------------------------------ appearance ----------------------------- */}
      <section className="panel p-5">
        <h2 className="mb-1 font-display text-lg font-semibold">Theme</h2>
        <p className="mb-4 text-xs text-white/45">
          Changes the interface only. Board and piece designs come from your locker.
        </p>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {(themes.length ? themes : FALLBACK_THEMES).map((theme) => {
            const active = prefs.theme === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => void update({ theme: theme.id })}
                aria-pressed={active}
                className={`rounded-xl border p-3 text-left transition ${
                  active
                    ? 'border-brass-400/70 bg-brass-400/10'
                    : 'border-white/10 bg-white/[0.03] hover:border-white/25'
                }`}
              >
                <div className="mb-2 flex items-center gap-1.5">
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-white/20"
                    style={{ background: theme.accent }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-white/20"
                    style={{ background: theme.surface }}
                  />
                </div>
                <div className="text-sm font-semibold">{theme.name}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-white/45">
                  {theme.description}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* ---------------------------- accessibility ---------------------------- */}
      <section className="panel p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Accessibility</h2>

        <div className="space-y-1">
          <Toggle
            label="Reduce motion"
            hint="Stops celebrations, particles and board shake."
            checked={prefs.reducedMotion}
            onChange={(v) => void update({ reducedMotion: v })}
          />
          <Toggle
            label="High contrast"
            hint="Stronger borders and brighter secondary text."
            checked={prefs.highContrast}
            onChange={(v) => void update({ highContrast: v })}
          />
        </div>

        <div className="mt-4 border-t border-white/8 pt-4">
          <div className="mb-2 flex items-baseline justify-between">
            <label className="text-sm font-medium" htmlFor="text-scale">
              Text size
            </label>
            <span className="text-xs tabular-nums text-white/45">
              {Math.round(prefs.textScale * 100)}%
            </span>
          </div>
          <input
            id="text-scale"
            type="range"
            min={90}
            max={140}
            step={5}
            value={Math.round(prefs.textScale * 100)}
            onChange={(e) => void update({ textScale: Number(e.target.value) / 100 })}
            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-brass-400"
          />
          <p className="mt-1.5 text-[11px] text-white/40">
            Scales every label and number. The board itself always fills the space available.
          </p>
        </div>
      </section>

      {/* -------------------------------- audio -------------------------------- */}
      <section className="panel p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Sound</h2>
        <div className="space-y-1">
          <Toggle
            label="Sound effects"
            hint="Strikes, pockets and button taps."
            checked={prefs.sound}
            onChange={(v) => void update({ sound: v })}
          />
          <Toggle
            label="Music"
            hint="Lobby and match background music."
            checked={prefs.music}
            onChange={(v) => void update({ music: v })}
          />
          <Toggle
            label="Vibration"
            hint="Haptic feedback on phones. Ignored on desktop."
            checked={prefs.haptics}
            onChange={(v) => void update({ haptics: v })}
          />
        </div>
      </section>

      {/* -------------------------------- social ------------------------------- */}
      <section className="panel p-5">
        <h2 className="mb-4 font-display text-lg font-semibold">Social</h2>
        <Toggle
          label="Mute emotes"
          hint="Hides quick chat and reactions from opponents. Yours still send."
          checked={prefs.muteEmotes}
          onChange={(v) => void update({ muteEmotes: v })}
        />
      </section>

      <Membership />

      {/* -------------------------------- account ------------------------------ */}
      <section className="panel p-5">
        <h2 className="mb-3 font-display text-lg font-semibold">Account</h2>
        <div className="space-y-2 text-sm">
          <Row label="Signed in as" value={user?.username ?? '—'} />
          <Row label="Account type" value={user?.isGuest ? 'Guest' : 'Registered'} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn-ghost text-sm" onClick={() => setReplayTutorial(true)}>
            Replay tutorial
          </button>
          <button type="button" className="btn-danger text-sm" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </section>

      <p className="pb-4 text-center text-[11px] leading-relaxed text-white/30">
        Carrom Club is free to play and uses virtual coins only. Coins have no cash value and
        cannot be exchanged for money.
      </p>

      {replayTutorial && <Tutorial onDone={() => setReplayTutorial(false)} />}
    </div>
  );
}

/** Themes shown before /preferences answers, so the page is never empty. */
const FALLBACK_THEMES = [
  { id: 'classic', name: 'Classic', accent: '#f2c94c', surface: '#0c0e15', description: 'Warm brass on near-black.' },
];

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-lg px-1 py-2.5 transition hover:bg-white/[0.03]">
      <span className="flex-1">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-[11px] leading-snug text-white/45">{hint}</span>
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          checked ? 'bg-brass-400' : 'bg-white/15'
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left] ${
            checked ? 'left-[22px]' : 'left-0.5'
          }`}
        />
      </button>
    </label>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-white/6 pb-2 last:border-0">
      <span className="text-white/45">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
