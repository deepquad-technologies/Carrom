import { BOARDS, DEFAULT_BOARD_ID, STARTER_BOARDS, boardById } from './boards';
import { COIN_SETS, DEFAULT_COIN_SET_ID, STARTER_COIN_SETS } from './coinsets';
import { STRIKERS, DEFAULT_STRIKER_ID, STARTER_STRIKERS } from './strikers';
import type { CosmeticItem } from './items';
import type { Rarity } from './rarity';

/** One lookup surface over every cosmetic in the game. */
export const ALL_ITEMS: CosmeticItem[] = [...STRIKERS, ...COIN_SETS];

const ITEM_BY_ID = new Map(ALL_ITEMS.map((i) => [i.id, i]));

export function itemById(id: string | undefined | null): CosmeticItem | undefined {
  return id ? ITEM_BY_ID.get(id) : undefined;
}

export function strikerById(id: string | undefined | null): CosmeticItem {
  const found = itemById(id);
  return found && found.category === 'striker'
    ? found
    : ITEM_BY_ID.get(DEFAULT_STRIKER_ID)!;
}

export function coinSetById(id: string | undefined | null): CosmeticItem {
  const found = itemById(id);
  return found && found.category === 'coin_set'
    ? found
    : ITEM_BY_ID.get(DEFAULT_COIN_SET_ID)!;
}

export function itemsOfRarity(category: CosmeticItem['category'], rarity: Rarity): CosmeticItem[] {
  return ALL_ITEMS.filter((i) => i.category === category && i.rarity === rarity);
}

/** Everything a brand new account starts with. */
export const STARTER_LOADOUT = {
  strikers: STARTER_STRIKERS,
  coinSets: STARTER_COIN_SETS,
  boards: STARTER_BOARDS,
  equipped: {
    striker: DEFAULT_STRIKER_ID,
    coinSet: DEFAULT_COIN_SET_ID,
    board: DEFAULT_BOARD_ID,
  },
};

export const STARTER_ITEM_IDS = [...STARTER_STRIKERS, ...STARTER_COIN_SETS];

export const CATALOG_COUNTS = {
  strikers: STRIKERS.length,
  coinSets: COIN_SETS.length,
  boards: BOARDS.length,
  total: STRIKERS.length + COIN_SETS.length + BOARDS.length,
};

export { boardById };
