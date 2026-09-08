'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { useSession } from './session';

/**
 * Interface preferences: theme, accessibility and audio.
 *
 * They are stored on the server, not in this browser, so a player who sets up
 * larger text or reduced motion on their phone finds it already applied on the
 * web. Until they load we use the OS hints — a player who has asked their
 * system for reduced motion should not get a burst of animation while we wait
 * on a network call.
 */
export interface Preferences {
  theme: string;
  reducedMotion: boolean;
  highContrast: boolean;
  sound: boolean;
  music: boolean;
  haptics: boolean;
  muteEmotes: boolean;
  tutorialDone: boolean;
  /** Text scale, 1 = default. Client-side only; it never leaves the device. */
  textScale: number;
}

export interface UiTheme {
  id: string;
  name: string;
  accent: string;
  surface: string;
  description: string;
}

const SYSTEM_REDUCED =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const TEXT_SCALE_KEY = 'carrom.textScale';

const DEFAULTS: Preferences = {
  theme: 'classic',
  reducedMotion: Boolean(SYSTEM_REDUCED),
  highContrast: false,
  sound: true,
  music: true,
  haptics: true,
  muteEmotes: false,
  tutorialDone: true, // Assume done until told otherwise, so it never flashes.
  textScale: 1,
};

interface PreferencesValue {
  prefs: Preferences;
  themes: UiTheme[];
  loaded: boolean;
  update(patch: Partial<Preferences>): Promise<void>;
  markTutorialDone(): void;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

function readTextScale(): number {
  if (typeof window === 'undefined') return 1;
  const raw = Number(window.localStorage.getItem(TEXT_SCALE_KEY));
  return Number.isFinite(raw) && raw >= 0.9 && raw <= 1.5 ? raw : 1;
}

export function PreferencesProvider({ children }: { children: React.ReactNode }) {
  const { signedIn } = useSession();
  const [prefs, setPrefs] = useState<Preferences>(DEFAULTS);
  const [themes, setThemes] = useState<UiTheme[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Text scale is a rendering concern only, so it stays local and instant.
  useEffect(() => {
    setPrefs((prev) => ({ ...prev, textScale: readTextScale() }));
  }, []);

  useEffect(() => {
    if (!signedIn) {
      setLoaded(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ preferences: Omit<Preferences, 'textScale'>; themes: UiTheme[] }>(
          '/preferences',
        );
        if (cancelled) return;
        setPrefs((prev) => ({ ...prev, ...data.preferences, textScale: prev.textScale }));
        setThemes(data.themes);
        setLoaded(true);
      } catch {
        // An older server without /preferences just means the defaults stand.
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  // Everything visual is driven from attributes on <html>, so a theme change is
  // one attribute write rather than a re-render of the whole tree.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = prefs.theme;
    root.classList.toggle('reduce-motion', prefs.reducedMotion);
    root.classList.toggle('high-contrast', prefs.highContrast);
    root.style.setProperty('--text-scale', String(prefs.textScale));
  }, [prefs.theme, prefs.reducedMotion, prefs.highContrast, prefs.textScale]);

  const update = useCallback(
    async (patch: Partial<Preferences>) => {
      // Apply first: a settings toggle that lags behind the tap feels broken.
      setPrefs((prev) => ({ ...prev, ...patch }));

      if (patch.textScale !== undefined && typeof window !== 'undefined') {
        window.localStorage.setItem(TEXT_SCALE_KEY, String(patch.textScale));
      }

      const { textScale: _ignored, ...server } = patch;
      if (Object.keys(server).length === 0) return;

      try {
        const data = await api<{ preferences: Omit<Preferences, 'textScale'> }>('/preferences', {
          method: 'PATCH',
          body: server,
        });
        setPrefs((prev) => ({ ...prev, ...data.preferences }));
      } catch {
        // Keep the optimistic value; the next load reconciles it.
      }
    },
    [],
  );

  const markTutorialDone = useCallback(() => {
    setPrefs((prev) => ({ ...prev, tutorialDone: true }));
  }, []);

  const value = useMemo<PreferencesValue>(
    () => ({ prefs, themes, loaded, update, markTutorialDone }),
    [prefs, themes, loaded, update, markTutorialDone],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  const context = useContext(PreferencesContext);
  if (!context) throw new Error('usePreferences must be used inside PreferencesProvider');
  return context;
}

/** Convenience for animation-heavy components. */
export function useReducedMotion(): boolean {
  return usePreferences().prefs.reducedMotion;
}
