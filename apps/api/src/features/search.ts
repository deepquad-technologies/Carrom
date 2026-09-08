import { Router } from 'express';
import { z } from 'zod';
import {
  ALL_ITEMS, AVATARS, BADGES, BANNERS, BOARDS, FRAMES, RARITY, type Rarity,
} from '@carrom/content';
import { query } from '../db/pool.js';
import { route } from '../lib/errors.js';
import { generalRateLimit, requireAuth } from '../auth/middleware.js';

/**
 * One search box across the whole app: players, cosmetics and tournaments.
 *
 * Players are matched in the database; everything else is static content, so it
 * is matched in memory — no query, no index, no load. Results are capped per
 * group so one very common word cannot return a thousand rows.
 *
 * Banned and blocked players are excluded, because being findable is how
 * harassment restarts after a block.
 */
export const searchRouter = Router();

const PER_GROUP = 8;

interface PlayerHit {
  type: 'player';
  id: string;
  title: string;
  subtitle: string;
  avatarUrl: string | null;
  level: number;
}

interface ItemHit {
  type: 'item';
  id: string;
  title: string;
  subtitle: string;
  color: string;
  rarity: string;
}

interface TournamentHit {
  type: 'tournament';
  id: string;
  title: string;
  subtitle: string;
  status: string;
}

/**
 * Escape a user's search term for use inside a LIKE pattern.
 *
 * `%` and `_` are wildcards in LIKE, so an unescaped term does not mean what
 * the player typed: searching for `bot_` matches `botp` and `botq`, and a lone
 * `%` matches every account on the service. Escaping them makes the search
 * return what was actually asked for.
 */
function likeLiteral(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Case-insensitive substring, with a light preference for prefix matches. */
function rank(name: string, needle: string): number {
  const lower = name.toLowerCase();
  const index = lower.indexOf(needle);
  if (index < 0) return -1;
  return index === 0 ? 0 : 1 + index;
}

function searchContent(needle: string): ItemHit[] {
  const pool: Array<{ id: string; name: string; rarity: string; color: string; kind: string }> = [
    ...ALL_ITEMS.map((i) => ({
      id: i.id,
      name: i.name,
      rarity: i.rarity,
      color: i.base,
      kind: i.category === 'striker' ? 'Striker' : 'Coin set',
    })),
    ...BOARDS.map((b) => ({ id: b.id, name: b.name, rarity: b.rarity, color: b.accent, kind: 'Board' })),
    ...AVATARS.map((a) => ({ id: a.id, name: a.name, rarity: a.rarity, color: a.base, kind: 'Avatar' })),
    ...FRAMES.map((f) => ({ id: f.id, name: f.name, rarity: f.rarity, color: f.color, kind: 'Frame' })),
    ...BANNERS.map((b) => ({ id: b.id, name: b.name, rarity: b.rarity, color: b.from, kind: 'Banner' })),
    ...BADGES.map((b) => ({ id: b.id, name: b.name, rarity: b.rarity, color: b.color, kind: 'Badge' })),
  ];

  return pool
    .map((item) => ({ item, score: rank(item.name, needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name))
    .slice(0, PER_GROUP)
    .map(({ item }) => ({
      type: 'item' as const,
      id: item.id,
      title: item.name,
      subtitle: `${item.kind} · ${RARITY[item.rarity as Rarity].name}`,
      color: item.color,
      rarity: item.rarity,
    }));
}

searchRouter.get(
  '/',
  requireAuth,
  generalRateLimit,
  route(async (req, res) => {
    const params = z
      .object({
        q: z.string().trim().min(2).max(40),
        type: z.enum(['all', 'players', 'items', 'tournaments']).default('all'),
      })
      .parse(req.query);

    const needle = params.q.toLowerCase();
    const wants = (group: string) => params.type === 'all' || params.type === group;

    let players: PlayerHit[] = [];
    if (wants('players')) {
      const rows = await query<{
        user_id: string;
        username: string;
        display_name: string;
        avatar_url: string | null;
        level: number;
        trophies: number;
      }>(
        `SELECT p.user_id, u.username, p.display_name, p.avatar_url, p.level, p.trophies
           FROM profiles p
           JOIN users u ON u.id = p.user_id
          WHERE u.is_bot = FALSE
            AND NOT EXISTS (
              SELECT 1 FROM bans b
               WHERE b.user_id = u.id AND b.scope = 'account' AND b.lifted_at IS NULL
                 AND (b.expires_at IS NULL OR b.expires_at > now())
            )
            AND p.user_id <> $1
            AND (u.username ILIKE $2 ESCAPE '\\' OR p.display_name ILIKE $2 ESCAPE '\\')
            AND NOT EXISTS (
              SELECT 1 FROM friends f
               WHERE f.status = 'blocked'
                 AND ((f.user_id = $1 AND f.friend_id = p.user_id)
                   OR (f.user_id = p.user_id AND f.friend_id = $1))
            )
          ORDER BY (u.username ILIKE $3 ESCAPE '\\') DESC, p.trophies DESC
          LIMIT $4`,
        [req.auth!.sub, `%${likeLiteral(params.q)}%`, `${likeLiteral(params.q)}%`, PER_GROUP],
      );

      players = rows.map((row) => ({
        type: 'player',
        id: row.user_id,
        title: row.display_name,
        subtitle: `@${row.username} · Level ${row.level}`,
        avatarUrl: row.avatar_url,
        level: row.level,
      }));
    }

    let tournaments: TournamentHit[] = [];
    if (wants('tournaments')) {
      const rows = await query<{ id: string; name: string; status: string; starts_at: string }>(
        `SELECT id, name, status, starts_at FROM tournaments
          WHERE name ILIKE $1 ESCAPE '\\' AND status <> 'draft'
          ORDER BY starts_at DESC
          LIMIT $2`,
        [`%${likeLiteral(params.q)}%`, PER_GROUP],
      );
      tournaments = rows.map((row) => ({
        type: 'tournament',
        id: row.id,
        title: row.name,
        subtitle: `${row.status} · ${new Date(row.starts_at).toLocaleDateString()}`,
        status: row.status,
      }));
    }

    const items = wants('items') ? searchContent(needle) : [];

    res.json({
      query: params.q,
      players,
      items,
      tournaments,
      total: players.length + items.length + tournaments.length,
    });
  }),
);
