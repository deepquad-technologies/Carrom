import { isValidReaction, quickMessageById, type QuickMessage } from '@carrom/content';
import { emotesMuted } from './preferences.js';

/**
 * Quick chat and emotes.
 *
 * Only preset phrases and an approved emoji list ever go on the wire, so there
 * is no free text to moderate. On top of that there are two limits, because
 * spamming an opponent is the one way a harmless feature turns nasty:
 *
 *   - a **cooldown** between emotes, so they cannot be machine-gunned;
 *   - a **per-minute cap**, after which the player is quietly muted for a while.
 *
 * Both are enforced here rather than in the client, and the recipient's own
 * "mute emotes" preference is checked before anything is delivered.
 */
export const EMOTE_LIMITS = {
  /** Minimum gap between two emotes from the same player. */
  cooldownMs: 1_500,
  /** Emotes allowed in a rolling minute. */
  perMinute: 8,
  /** How long a player sits out after exceeding the cap. */
  timeoutMs: 30_000,
};

interface EmoteState {
  lastSentAt: number;
  windowStartedAt: number;
  sentInWindow: number;
  mutedUntil: number;
}

const state = new Map<string, EmoteState>();

export interface EmoteVerdict {
  ok: boolean;
  reason?: string;
  /** Seconds the player has to wait, when they are timed out. */
  retryInSeconds?: number;
}

/** Check and record an emote attempt in one step. */
export function checkEmote(userId: string, now = Date.now()): EmoteVerdict {
  let entry = state.get(userId);
  if (!entry) {
    // Negative infinity, not 0: a brand new player has not sent anything, so
    // their first emote must never look like it landed inside a cooldown.
    entry = {
      lastSentAt: Number.NEGATIVE_INFINITY,
      windowStartedAt: now,
      sentInWindow: 0,
      mutedUntil: 0,
    };
    state.set(userId, entry);
  }

  if (now < entry.mutedUntil) {
    return {
      ok: false,
      reason: 'You are sending too many emotes. Take a moment.',
      retryInSeconds: Math.ceil((entry.mutedUntil - now) / 1000),
    };
  }

  if (now - entry.lastSentAt < EMOTE_LIMITS.cooldownMs) {
    return { ok: false, reason: 'Slow down a moment' };
  }

  // Roll the window forward once a minute has passed.
  if (now - entry.windowStartedAt >= 60_000) {
    entry.windowStartedAt = now;
    entry.sentInWindow = 0;
  }

  if (entry.sentInWindow >= EMOTE_LIMITS.perMinute) {
    entry.mutedUntil = now + EMOTE_LIMITS.timeoutMs;
    return {
      ok: false,
      reason: 'Too many emotes. Muted briefly.',
      retryInSeconds: Math.ceil(EMOTE_LIMITS.timeoutMs / 1000),
    };
  }

  entry.lastSentAt = now;
  entry.sentInWindow += 1;
  return { ok: true };
}

export function clearEmoteState(userId: string): void {
  state.delete(userId);
}

export interface ResolvedEmote {
  messageId: string;
  text: string;
  emoji: string;
}

/**
 * Turn a request into something safe to broadcast. Anything not in the preset
 * list or the approved emoji list is rejected outright.
 */
export function resolveEmote(payload: {
  messageId?: string;
  emoji?: string;
}): ResolvedEmote | null {
  const preset: QuickMessage | undefined = payload.messageId
    ? quickMessageById(payload.messageId)
    : undefined;

  if (preset) {
    return { messageId: preset.id, text: preset.text, emoji: preset.emoji };
  }

  if (payload.emoji && isValidReaction(payload.emoji)) {
    return { messageId: 'reaction', text: '', emoji: payload.emoji };
  }

  return null;
}

/**
 * Which of these players want emotes suppressed. The sender always sees their
 * own — muting is about not being shouted at, not about hiding your own words.
 */
export async function recipientsWhoAllowEmotes(
  userIds: string[],
  senderId: string,
): Promise<Set<string>> {
  const allowed = new Set<string>();
  for (const userId of userIds) {
    if (userId === senderId) {
      allowed.add(userId);
      continue;
    }
    if (!(await emotesMuted(userId))) allowed.add(userId);
  }
  return allowed;
}
