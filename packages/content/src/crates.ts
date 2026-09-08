import { COIN_SETS } from './coinsets';
import { STRIKERS } from './strikers';
import { RARITY, RARITY_ORDER, type Rarity } from './rarity';
import type { CosmeticItem } from './items';

/**
 * Win a match, win a crate. Crates unlock on a timer that scales with how good
 * the crate is, and the virtual coins inside scale with the room you won in.
 *
 * Drop rates are published on the crate card in the UI: `dropTable()` returns
 * exactly the numbers the roll uses, so what players see is what they get.
 */
export type CrateKind = 'rookie' | 'champion' | 'legendary';

export interface CrateType {
  id: CrateKind;
  name: string;
  description: string;
  /** How long it sits locked before it can be opened. */
  unlockMs: number;
  /** Virtual coins inside, as a multiple of the room entry. */
  coinFactor: number;
  /** Floor so low rooms still pay something worth having. */
  minCoins: number;
  /** XP granted on opening. */
  xp: number;
  /** How many cosmetics roll out of it. */
  itemDrops: number;
  /** Relative chance of each rarity for those drops. */
  rarityWeights: Partial<Record<Rarity, number>>;
  /** At least this rarity is guaranteed on one drop. */
  guaranteed: Rarity;
  /** Virtual coins charged per remaining minute to open early. */
  speedUpPerMinute: number;
  color: string;
  accent: string;
  glow: string;
  /** Opening animation the client plays. */
  openAnim: 'crack' | 'burst' | 'ascend';
}

export const CRATE_TYPES: Record<CrateKind, CrateType> = {
  rookie: {
    id: 'rookie',
    name: 'Rookie Crate',
    description: 'A steady drop. Mostly common gear with a chance of something better.',
    unlockMs: 15 * 60_000,
    coinFactor: 1.6,
    minCoins: 320,
    xp: 40,
    itemDrops: 2,
    rarityWeights: { common: 70, rare: 25, epic: 4.5, mythic: 0.5 },
    guaranteed: 'common',
    speedUpPerMinute: 12,
    color: '#8a5a2b',
    accent: '#d9a05c',
    glow: 'rgba(217,160,92,0.45)',
    openAnim: 'crack',
  },
  champion: {
    id: 'champion',
    name: 'Champion Crate',
    description: 'A rare item guaranteed, with a real shot at epic gear.',
    unlockMs: 3 * 60 * 60_000,
    coinFactor: 5,
    minCoins: 1_400,
    xp: 150,
    itemDrops: 3,
    rarityWeights: { common: 20, rare: 45, epic: 27, mythic: 7, legendary: 1 },
    guaranteed: 'rare',
    speedUpPerMinute: 26,
    color: '#7a2246',
    accent: '#f2618c',
    glow: 'rgba(242,97,140,0.55)',
    openAnim: 'burst',
  },
  legendary: {
    id: 'legendary',
    name: 'Legendary Crate',
    description: 'An epic item guaranteed, with mythic and legendary in the pool.',
    unlockMs: 8 * 60 * 60_000,
    coinFactor: 14,
    minCoins: 5_000,
    xp: 450,
    itemDrops: 4,
    rarityWeights: { rare: 26, epic: 45, mythic: 23, legendary: 6 },
    guaranteed: 'epic',
    speedUpPerMinute: 48,
    color: '#3a2f7a',
    accent: '#a78bfa',
    glow: 'rgba(167,139,250,0.6)',
    openAnim: 'ascend',
  },
};

export const CRATE_LIST = Object.values(CRATE_TYPES);
export const CRATE_SLOTS = 4;

export interface CrateInstance {
  id: string;
  kind: CrateKind;
  /** Room entry this crate was won at, used to size the coin reward. */
  tierEntry: number;
  wonAt: number;
  /** Epoch ms when the unlock finishes, or null while it is still queued. */
  readyAt: number | null;
}

export interface CrateDrop {
  item: CosmeticItem;
  duplicate: boolean;
  /** Virtual coins granted instead, when the item was already owned. */
  coins: number;
  fragments: number;
}

export interface CrateReward {
  kind: CrateKind;
  coins: number;
  xp: number;
  drops: CrateDrop[];
  /** Fragments by rarity, from duplicate pulls. */
  fragments: Record<string, number>;
}

type Rng = () => number;

function pickWeighted<T extends string>(weights: Partial<Record<T, number>>, rng: Rng): T {
  const entries = Object.entries(weights) as Array<[T, number]>;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1][0];
}

function poolFor(kind: 'striker' | 'coin_set', rarity: Rarity): CosmeticItem[] {
  const source = kind === 'striker' ? STRIKERS : COIN_SETS;
  // Items unlocked by achievement or shop are earned, not dropped.
  return source.filter((i) => i.rarity === rarity && i.unlock.kind === 'crate');
}

/** Published drop rates, as percentages that sum to 100. */
export function dropTable(kind: CrateKind): Array<{ rarity: Rarity; percent: number }> {
  const weights = CRATE_TYPES[kind].rarityWeights;
  const total = Object.values(weights).reduce((sum, w) => sum + (w ?? 0), 0);
  return RARITY_ORDER.filter((r) => weights[r] !== undefined).map((rarity) => ({
    rarity,
    percent: Math.round(((weights[rarity] ?? 0) / total) * 1000) / 10,
  }));
}

/** Better rooms drop better crates. */
export function rollCrateKind(tierIndex: number, rng: Rng = Math.random): CrateKind {
  const weights: Partial<Record<CrateKind, number>> =
    tierIndex <= 1
      ? { rookie: 80, champion: 18, legendary: 2 }
      : tierIndex <= 3
        ? { rookie: 55, champion: 35, legendary: 10 }
        : { rookie: 30, champion: 45, legendary: 25 };
  return pickWeighted(weights, rng);
}

export function createCrate(kind: CrateKind, tierEntry: number, rng: Rng = Math.random): CrateInstance {
  const stamp = Date.now().toString(36);
  const salt = Math.floor(rng() * 1e9).toString(36);
  return { id: `crate_${stamp}_${salt}`, kind, tierEntry, wonAt: Date.now(), readyAt: null };
}

/**
 * Roll what is inside a crate. `owned` decides which pulls become duplicates,
 * so this stays a pure function: the server calls it, and tests can pin the rng.
 */
export function openCrate(
  crate: CrateInstance,
  owned: Set<string>,
  rng: Rng = Math.random,
): CrateReward {
  const type = CRATE_TYPES[crate.kind];
  const spread = 0.8 + rng() * 0.4;
  const baseCoins = Math.max(type.minCoins, Math.round(crate.tierEntry * type.coinFactor * spread));

  const drops: CrateDrop[] = [];
  const fragments: Record<string, number> = {};
  const claimed = new Set(owned);
  let dupCoins = 0;

  for (let i = 0; i < type.itemDrops; i++) {
    // The first drop honours the crate's guarantee.
    const rarity = i === 0 ? type.guaranteed : pickWeighted(type.rarityWeights, rng);
    const category: 'striker' | 'coin_set' = rng() < 0.5 ? 'striker' : 'coin_set';

    let pool = poolFor(category, rarity);
    if (pool.length === 0) pool = poolFor(category === 'striker' ? 'coin_set' : 'striker', rarity);
    if (pool.length === 0) continue;

    const unowned = pool.filter((item) => !claimed.has(item.id));
    if (unowned.length > 0) {
      const item = unowned[Math.floor(rng() * unowned.length)];
      claimed.add(item.id);
      drops.push({ item, duplicate: false, coins: 0, fragments: 0 });
    } else {
      const item = pool[Math.floor(rng() * pool.length)];
      const meta = RARITY[item.rarity];
      dupCoins += meta.duplicateValue;
      fragments[item.rarity] = (fragments[item.rarity] ?? 0) + meta.fragmentValue;
      drops.push({
        item,
        duplicate: true,
        coins: meta.duplicateValue,
        fragments: meta.fragmentValue,
      });
    }
  }

  return { kind: crate.kind, coins: baseCoins + dupCoins, xp: type.xp, drops, fragments };
}

export function unlockRemaining(crate: CrateInstance, now = Date.now()): number {
  if (crate.readyAt === null) return CRATE_TYPES[crate.kind].unlockMs;
  return Math.max(0, crate.readyAt - now);
}

export function isReady(crate: CrateInstance, now = Date.now()): boolean {
  return crate.readyAt !== null && now >= crate.readyAt;
}

export function speedUpCost(crate: CrateInstance, now = Date.now()): number {
  const remaining = unlockRemaining(crate, now);
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / 60_000) * CRATE_TYPES[crate.kind].speedUpPerMinute;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return 'Ready';
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
