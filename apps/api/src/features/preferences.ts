import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db/pool.js';
import { notFound, route } from '../lib/errors.js';
import { generalRateLimit, requireAuth } from '../auth/middleware.js';

/**
 * Player preferences: interface theme, accessibility and audio.
 *
 * These live on the server rather than in browser storage so they follow a
 * player between the web app, their phone and a second device. Accessibility
 * settings in particular should not have to be rediscovered on every install.
 */
export const preferencesRouter = Router();

/** Interface themes. The board has its own separate skins. */
export const UI_THEMES = [
  { id: 'classic', name: 'Classic', accent: '#f2c94c', surface: '#0c0e15', description: 'Warm brass on near-black.' },
  { id: 'dark', name: 'Dark', accent: '#8a93a6', surface: '#08090c', description: 'Neutral greys, minimal colour.' },
  { id: 'neon', name: 'Neon', accent: '#39ffb0', surface: '#05070c', description: 'High-contrast green on black.' },
  { id: 'royal', name: 'Royal', accent: '#f2618c', surface: '#120a14', description: 'Deep plum and rose.' },
  { id: 'jungle', name: 'Jungle', accent: '#7fc45c', surface: '#0a140c', description: 'Forest greens.' },
  { id: 'galaxy', name: 'Galaxy', accent: '#a78bfa', surface: '#0a0814', description: 'Violet on deep space.' },
] as const;

export type UiThemeId = (typeof UI_THEMES)[number]['id'];

const THEME_IDS = UI_THEMES.map((t) => t.id) as [UiThemeId, ...UiThemeId[]];

interface PreferenceRow {
  ui_theme: string;
  reduced_motion: boolean;
  high_contrast: boolean;
  sound_enabled: boolean;
  music_enabled: boolean;
  haptics_enabled: boolean;
  emotes_muted: boolean;
  tutorial_done: boolean;
}

function toPreferences(row: PreferenceRow) {
  return {
    theme: row.ui_theme,
    reducedMotion: row.reduced_motion,
    highContrast: row.high_contrast,
    sound: row.sound_enabled,
    music: row.music_enabled,
    haptics: row.haptics_enabled,
    muteEmotes: row.emotes_muted,
    tutorialDone: row.tutorial_done,
  };
}

export async function preferencesFor(userId: string) {
  const row = await one<PreferenceRow>(
    `SELECT ui_theme, reduced_motion, high_contrast, sound_enabled,
            music_enabled, haptics_enabled, emotes_muted, tutorial_done
       FROM profiles WHERE user_id = $1`,
    [userId],
  );
  if (!row) throw notFound('Profile not found');
  return toPreferences(row);
}

/** Whether this player wants opponent emotes suppressed. */
export async function emotesMuted(userId: string): Promise<boolean> {
  const row = await one<{ emotes_muted: boolean }>(
    'SELECT emotes_muted FROM profiles WHERE user_id = $1',
    [userId],
  );
  return row?.emotes_muted ?? false;
}

preferencesRouter.get(
  '/',
  requireAuth,
  route(async (req, res) => {
    res.json({ preferences: await preferencesFor(req.auth!.sub), themes: UI_THEMES });
  }),
);

preferencesRouter.patch(
  '/',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const body = z
      .object({
        theme: z.enum(THEME_IDS).optional(),
        reducedMotion: z.boolean().optional(),
        highContrast: z.boolean().optional(),
        sound: z.boolean().optional(),
        music: z.boolean().optional(),
        haptics: z.boolean().optional(),
        muteEmotes: z.boolean().optional(),
        tutorialDone: z.boolean().optional(),
      })
      .parse(req.body);

    // COALESCE so an omitted field is left alone rather than reset.
    const row = await one<PreferenceRow>(
      `UPDATE profiles SET
         ui_theme        = COALESCE($2, ui_theme),
         reduced_motion  = COALESCE($3, reduced_motion),
         high_contrast   = COALESCE($4, high_contrast),
         sound_enabled   = COALESCE($5, sound_enabled),
         music_enabled   = COALESCE($6, music_enabled),
         haptics_enabled = COALESCE($7, haptics_enabled),
         emotes_muted    = COALESCE($8, emotes_muted),
         tutorial_done   = COALESCE($9, tutorial_done)
       WHERE user_id = $1
       RETURNING ui_theme, reduced_motion, high_contrast, sound_enabled,
                 music_enabled, haptics_enabled, emotes_muted, tutorial_done`,
      [
        req.auth!.sub,
        body.theme ?? null,
        body.reducedMotion ?? null,
        body.highContrast ?? null,
        body.sound ?? null,
        body.music ?? null,
        body.haptics ?? null,
        body.muteEmotes ?? null,
        body.tutorialDone ?? null,
      ],
    );
    if (!row) throw notFound('Profile not found');

    res.json({ preferences: toPreferences(row) });
  }),
);

/** Called when a player finishes or skips the tutorial. */
preferencesRouter.post(
  '/tutorial-complete',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    await query('UPDATE profiles SET tutorial_done = TRUE WHERE user_id = $1', [req.auth!.sub]);
    res.json({ ok: true });
  }),
);
