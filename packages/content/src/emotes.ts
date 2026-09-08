/**
 * Quick chat only. Free-text chat is deliberately not offered, which keeps
 * moderation load low and makes the report queue meaningful.
 */
export interface QuickMessage {
  id: string;
  text: string;
  /** Emoji shown on the button and floated over the sender's avatar. */
  emoji: string;
  tone: 'friendly' | 'reaction' | 'sporting';
}

export const QUICK_MESSAGES: QuickMessage[] = [
  { id: 'qm_gg', text: 'Good game!', emoji: '\u{1F91D}', tone: 'sporting' },
  { id: 'qm_nice', text: 'Nice shot!', emoji: '\u{1F44F}', tone: 'reaction' },
  { id: 'qm_wp', text: 'Well played!', emoji: '\u{1F44D}', tone: 'sporting' },
  { id: 'qm_oops', text: 'Oops!', emoji: '\u{1F605}', tone: 'reaction' },
  { id: 'qm_gl', text: 'Good luck!', emoji: '\u{1F340}', tone: 'friendly' },
  { id: 'qm_congrats', text: 'Congratulations!', emoji: '\u{1F389}', tone: 'sporting' },
  { id: 'qm_close', text: 'So close!', emoji: '\u{1F62C}', tone: 'reaction' },
  { id: 'qm_hurry', text: 'Your turn!', emoji: '\u{23F1}', tone: 'friendly' },
  { id: 'qm_thanks', text: 'Thanks!', emoji: '\u{1F64F}', tone: 'friendly' },
  { id: 'qm_rematch', text: 'Rematch?', emoji: '\u{1F504}', tone: 'friendly' },
];

/** Standalone emoji reactions, no text attached. */
export const EMOJI_REACTIONS = [
  '\u{1F44D}', '\u{1F44F}', '\u{1F602}', '\u{1F62E}', '\u{1F525}',
  '\u{1F9CA}', '\u{1F3AF}', '\u{1F44C}', '\u{1F622}', '\u{1F44B}',
];

const BY_ID = new Map(QUICK_MESSAGES.map((m) => [m.id, m]));

export function quickMessageById(id: string): QuickMessage | undefined {
  return BY_ID.get(id);
}

export function isValidReaction(emoji: string): boolean {
  return EMOJI_REACTIONS.includes(emoji);
}
