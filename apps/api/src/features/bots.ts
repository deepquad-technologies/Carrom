import { BOT_NAME_POOL, COIN_SETS, STRIKERS, botUsername, buildBotNames } from '@carrom/content';
import type { BotSkill } from '@carrom/game-engine';
import { one, query, transaction } from '../db/pool.js';
import { moveCoins } from './economy.js';
import { logger } from '../lib/logger.js';

/**
 * Bot accounts.
 *
 * A bot is a real user with a real profile and a real coin balance. That is the
 * whole trick: it pays its entry fee and collects its winnings through the same
 * append-only ledger every human uses, so a match against a bot moves coins
 * between two accounts instead of minting them. The economy audit stays honest
 * without needing a special case.
 *
 * Bots are excluded from leaderboards, search and player counts. They are
 * marked as bots to the client too — a player should always be able to tell
 * whether they are facing a person.
 */
export interface BotAccount {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  skill: BotSkill;
  level: number;
  trophies: number;
  coins: number;
  floatCoins: number;
  strikerSkinId: string;
  coinSkinId: string;
}

interface BotRow {
  user_id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  skill: BotSkill;
  level: number;
  trophies: number;
  coins: string;
  float_coins: string;
  equipped_striker: string;
  equipped_coin_set: string;
}

function toBot(row: BotRow): BotAccount {
  return {
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    skill: row.skill,
    level: row.level,
    trophies: row.trophies,
    coins: Number(row.coins),
    floatCoins: Number(row.float_coins),
    strikerSkinId: row.equipped_striker,
    coinSkinId: row.equipped_coin_set,
  };
}

/**
 * The roster.
 *
 * Bots are generated from a pool of over a hundred human first names rather
 * than a short hardcoded list, so a player who plays a lot meets different
 * opponents instead of the same three names. Difficulty is spread evenly, and
 * each bot's level and trophies are drawn from a band that matches its skill —
 * a "hard" bot showing level 3 would give the game away immediately.
 */
const BOTS_PER_SKILL = 12;

/** Level and trophy bands, so a bot's profile matches how it actually plays. */
const SKILL_BANDS: Record<BotSkill, { level: [number, number]; trophies: [number, number] }> = {
  easy: { level: [2, 7], trophies: [40, 200] },
  medium: { level: [8, 18], trophies: [300, 800] },
  hard: { level: [20, 38], trophies: [1_200, 2_200] },
};

function between([min, max]: [number, number], random: () => number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * A small seeded generator, so the roster is the *same* roster on every boot.
 *
 * This matters more than it looks: seeding checks for a bot by username, so a
 * roster built from Math.random would produce different names each restart and
 * quietly create another thirty-six accounts every time the server came up.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fixed, so the roster is stable for the life of the deployment. */
const ROSTER_SEED = 0xca55_0111;

export interface RosterEntry {
  displayName: string;
  username: string;
  skill: BotSkill;
  level: number;
  trophies: number;
}

/**
 * Build the roster.
 *
 * Deterministic given a random source, which is what lets the tests assert
 * things about it without re-seeding a database.
 */
export function buildRoster(
  perSkill = BOTS_PER_SKILL,
  random: () => number = seededRandom(ROSTER_SEED),
): RosterEntry[] {
  const skills: BotSkill[] = ['easy', 'medium', 'hard'];
  const names = buildBotNames(perSkill * skills.length, random);

  return names.map((displayName, index) => {
    const skill = skills[index % skills.length]!;
    const band = SKILL_BANDS[skill];
    return {
      displayName,
      username: botUsername(displayName, index),
      skill,
      level: between(band.level, random),
      trophies: between(band.trophies, random),
    };
  });
}

/** How many distinct names are available, for the operator dashboard. */
export const BOT_NAME_POOL_SIZE = BOT_NAME_POOL.length;

/** In-process cache; the roster changes only when an operator edits it. */
let cache: { at: number; bots: BotAccount[] } = { at: 0, bots: [] };
const CACHE_MS = 30_000;

export function isBotId(userId: string): boolean {
  return cache.bots.some((bot) => bot.userId === userId);
}

export async function allBots(force = false): Promise<BotAccount[]> {
  if (!force && Date.now() - cache.at < CACHE_MS && cache.bots.length > 0) return cache.bots;

  const rows = await query<BotRow>(
    `SELECT u.id AS user_id, u.username, p.display_name, p.avatar_url,
            b.skill, p.level, p.trophies, p.coins::text, b.float_coins::text,
            p.equipped_striker, p.equipped_coin_set
       FROM bot_accounts b
       JOIN users u ON u.id = b.user_id
       JOIN profiles p ON p.user_id = b.user_id
      WHERE b.active = TRUE
      ORDER BY p.trophies`,
  );

  cache = { at: Date.now(), bots: rows.map(toBot) };
  return cache.bots;
}

/**
 * Pick a bot of a given skill, avoiding one the player just faced.
 *
 * Playing the same named opponent three times in a row makes the illusion
 * collapse, so the last one is skipped when there is an alternative.
 */
export async function pickBot(skill: BotSkill, avoidUserId?: string): Promise<BotAccount | null> {
  const bots = await allBots();
  const matching = bots.filter((bot) => bot.skill === skill);
  if (matching.length === 0) return bots[0] ?? null;

  const choices = matching.length > 1 ? matching.filter((b) => b.userId !== avoidUserId) : matching;
  return choices[Math.floor(Math.random() * choices.length)] ?? null;
}

export async function botById(userId: string): Promise<BotAccount | null> {
  const bots = await allBots();
  return bots.find((bot) => bot.userId === userId) ?? null;
}

/**
 * Make sure a bot can cover an entry fee.
 *
 * Top-ups are a normal ledger movement with reason `bot_float`, so the coins a
 * bot brings to the table are visible and countable rather than appearing from
 * nowhere. Over time bots lose more than they win — that is the intended sink,
 * and this is where its cost shows up.
 */
export async function ensureBotFloat(userId: string, needed: number): Promise<void> {
  const row = await one<{ coins: string; float_coins: string }>(
    `SELECT p.coins::text, b.float_coins::text
       FROM profiles p JOIN bot_accounts b ON b.user_id = p.user_id
      WHERE p.user_id = $1`,
    [userId],
  );
  if (!row) return;

  const coins = Number(row.coins);
  if (coins >= needed) return;

  const target = Number(row.float_coins);
  const topUp = Math.max(needed - coins, target - coins);

  await transaction((client) =>
    moveCoins(client, {
      userId,
      delta: topUp,
      reason: 'bot_float',
      note: 'automatic bot top-up',
    }),
  );

  logger.info({ bot: userId, topUp }, 'bot float topped up');
  cache = { at: 0, bots: [] };
}

/**
 * Create the roster if it is missing. Idempotent, and safe to run on boot.
 *
 * Bots get a starting float through the ledger rather than a direct balance
 * write, so `profiles.coins` still equals the sum of `coin_ledger` the moment
 * they exist.
 */
export async function seedBots(): Promise<number> {
  let created = 0;

  for (const entry of buildRoster()) {
    const existing = await one<{ id: string }>('SELECT id FROM users WHERE username = $1', [
      entry.username,
    ]);
    if (existing) continue;

    // Give each bot a different-looking loadout so a lobby of them is not
    // dozens of identical strikers.
    const striker = STRIKERS[Math.floor(Math.random() * Math.min(20, STRIKERS.length))]!;
    const coinSet = COIN_SETS[Math.floor(Math.random() * Math.min(20, COIN_SETS.length))]!;

    await transaction(async (client) => {
      const user = await client.query<{ id: string }>(
        `INSERT INTO users (username, is_guest, is_bot, role)
         VALUES ($1, FALSE, TRUE, 'player') RETURNING id`,
        [entry.username],
      );
      const userId = user.rows[0]!.id;

      await client.query(
        `INSERT INTO profiles
           (user_id, display_name, level, trophies, coins,
            equipped_striker, equipped_coin_set)
         VALUES ($1, $2, $3, $4, 0, $5, $6)`,
        [userId, entry.displayName, entry.level, entry.trophies, striker.id, coinSet.id],
      );

      await client.query('INSERT INTO bot_accounts (user_id, skill) VALUES ($1, $2)', [
        userId,
        entry.skill,
      ]);

      // The opening float, through the ledger so the audit balances.
      await moveCoins(client, {
        userId,
        delta: 5_000_000,
        reason: 'bot_float',
        note: 'initial bot float',
      });
    });

    created += 1;
  }

  if (created > 0) {
    cache = { at: 0, bots: [] };
    logger.info({ created }, 'bot roster seeded');
  }
  return created;
}

/** Bot ids, for excluding them from counts and leaderboards. */
export async function botUserIds(): Promise<string[]> {
  return (await allBots()).map((bot) => bot.userId);
}
