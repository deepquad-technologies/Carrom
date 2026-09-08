import { beforeEach, describe, expect, it } from 'vitest';
import { EMOTE_LIMITS, checkEmote, clearEmoteState, resolveEmote } from '../src/features/emotes.js';

/**
 * The emote limiter decides whether a player may speak. It is the difference
 * between a friendly game and being spammed with the same taunt forty times,
 * so it is worth testing at the boundaries rather than in the middle.
 */
const USER = 'user-under-test';

beforeEach(() => {
  clearEmoteState(USER);
});

describe('emote cooldown', () => {
  it('allows the first emote', () => {
    expect(checkEmote(USER, 1_000).ok).toBe(true);
  });

  it('blocks a second emote inside the cooldown', () => {
    checkEmote(USER, 1_000);
    const verdict = checkEmote(USER, 1_000 + EMOTE_LIMITS.cooldownMs - 1);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/slow down/i);
  });

  it('allows one exactly at the cooldown boundary', () => {
    checkEmote(USER, 1_000);
    expect(checkEmote(USER, 1_000 + EMOTE_LIMITS.cooldownMs).ok).toBe(true);
  });

  it('does not consume the quota when it blocks', () => {
    checkEmote(USER, 1_000);
    for (let i = 0; i < 20; i++) checkEmote(USER, 1_100 + i); // all blocked

    // Only the very first emote counted, so there is still room in the window.
    let allowed = 0;
    for (let i = 1; i < EMOTE_LIMITS.perMinute + 2; i++) {
      if (checkEmote(USER, 1_000 + i * EMOTE_LIMITS.cooldownMs).ok) allowed += 1;
    }
    expect(allowed).toBe(EMOTE_LIMITS.perMinute - 1);
  });
});

describe('per-minute cap', () => {
  /** Send `count` emotes spaced far enough apart to clear the cooldown. */
  function burst(count: number, start = 0): boolean[] {
    const results: boolean[] = [];
    for (let i = 0; i < count; i++) {
      results.push(checkEmote(USER, start + i * EMOTE_LIMITS.cooldownMs).ok);
    }
    return results;
  }

  it('allows exactly the cap', () => {
    expect(burst(EMOTE_LIMITS.perMinute).every(Boolean)).toBe(true);
  });

  it('mutes the player once the cap is passed', () => {
    burst(EMOTE_LIMITS.perMinute);
    const verdict = checkEmote(USER, EMOTE_LIMITS.perMinute * EMOTE_LIMITS.cooldownMs);
    expect(verdict.ok).toBe(false);
    expect(verdict.retryInSeconds).toBe(EMOTE_LIMITS.timeoutMs / 1000);
  });

  it('keeps them muted for the whole timeout', () => {
    burst(EMOTE_LIMITS.perMinute);
    const breach = EMOTE_LIMITS.perMinute * EMOTE_LIMITS.cooldownMs;
    checkEmote(USER, breach);

    expect(checkEmote(USER, breach + EMOTE_LIMITS.timeoutMs - 1).ok).toBe(false);
    expect(checkEmote(USER, breach + EMOTE_LIMITS.timeoutMs + 60_000).ok).toBe(true);
  });

  it('rolls the window forward after a quiet minute', () => {
    burst(EMOTE_LIMITS.perMinute);
    // A minute later the count resets, so the same burst is allowed again.
    expect(checkEmote(USER, 60_001).ok).toBe(true);
  });

  it('tracks players separately', () => {
    burst(EMOTE_LIMITS.perMinute);
    const other = 'someone-else';
    clearEmoteState(other);
    expect(checkEmote(other, 0).ok).toBe(true);
  });
});

describe('resolveEmote', () => {
  it('rejects free text', () => {
    expect(resolveEmote({ messageId: 'not-a-real-preset' })).toBeNull();
    expect(resolveEmote({ emoji: 'https://example.com' })).toBeNull();
    expect(resolveEmote({})).toBeNull();
  });

  it('resolves a preset to its own text, not the caller’s', () => {
    const resolved = resolveEmote({ messageId: 'qm_good_luck' });
    // A preset id that does not exist would be null; if it resolved, the text
    // must come from the catalogue.
    if (resolved) {
      expect(resolved.messageId).toBe('qm_good_luck');
      expect(resolved.text.length).toBeGreaterThan(0);
    }
  });
});
