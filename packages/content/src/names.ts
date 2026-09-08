/**
 * Names for computer opponents.
 *
 * A bot called "Bot_07" tells a player the table is empty. A bot called
 * "Priya K." tells them somebody is sitting across from them — which is the
 * point of having one at all. They are still labelled as bots in the interface;
 * the name is atmosphere, not a disguise.
 *
 * The pool is deliberately broad. Carrom's heartland is South Asia, so the list
 * leans that way, but the game is played everywhere and the roster should look
 * like it. Names are common given names, nothing that reads as a real public
 * figure.
 */
export const BOT_FIRST_NAMES: string[] = [
  // South Asian
  'Aarav', 'Aditi', 'Ajay', 'Akash', 'Amara', 'Ameer', 'Ananya', 'Anil', 'Anita', 'Anjali',
  'Arjun', 'Asha', 'Ayesha', 'Bala', 'Bhavna', 'Chetan', 'Damini', 'Deepak', 'Devi', 'Dhruv',
  'Divya', 'Farah', 'Gaurav', 'Gita', 'Harsh', 'Imran', 'Indira', 'Ishaan', 'Jaya', 'Kabir',
  'Kalpana', 'Karan', 'Kavya', 'Kiran', 'Lakshmi', 'Lata', 'Madhav', 'Manish', 'Meera', 'Mohan',
  'Nadia', 'Naveen', 'Neha', 'Nikhil', 'Nisha', 'Omar', 'Pooja', 'Prakash', 'Priya', 'Rahul',
  'Rajesh', 'Rani', 'Ravi', 'Rekha', 'Rohit', 'Sameer', 'Sanjay', 'Saira', 'Shreya', 'Sunil',
  'Tara', 'Uma', 'Vikram', 'Vinod', 'Yash', 'Zara',

  // East and Southeast Asian
  'Aiko', 'Bao', 'Chen', 'Dae', 'Hana', 'Hiro', 'Jin', 'Kenji', 'Lin', 'Mei',
  'Minh', 'Nari', 'Ren', 'Siti', 'Wei', 'Yuki',

  // African
  'Amina', 'Chidi', 'Fatima', 'Kofi', 'Lerato', 'Nia', 'Sekou', 'Thabo', 'Yara', 'Zuri',

  // European
  'Alina', 'Bruno', 'Clara', 'Dimitri', 'Elena', 'Felix', 'Greta', 'Hugo', 'Ines', 'Jonas',
  'Katya', 'Lucia', 'Marek', 'Nadia', 'Oskar', 'Petra', 'Rafael', 'Sofia', 'Tomas', 'Vera',

  // Middle Eastern
  'Adel', 'Dalia', 'Hassan', 'Layla', 'Nour', 'Rami', 'Samira', 'Tarek',

  // Latin American
  'Camila', 'Diego', 'Elena', 'Javier', 'Lucia', 'Mateo', 'Paula', 'Rosa', 'Santiago', 'Valeria',

  // Anglophone
  'Alice', 'Ben', 'Chloe', 'Daniel', 'Ella', 'George', 'Hannah', 'Isaac', 'Julia', 'Liam',
  'Maya', 'Noah', 'Olivia', 'Ruby', 'Sam', 'Tessa',
];

/**
 * Surname initials. Roughly a third of bots get one, which is how a real
 * player list looks — some people use a full name, most do not.
 */
export const BOT_SURNAME_INITIALS = [
  'A', 'B', 'C', 'D', 'G', 'H', 'J', 'K', 'M', 'N', 'P', 'R', 'S', 'T', 'V',
];

/** Every distinct name available, after removing the duplicates above. */
export const BOT_NAME_POOL: string[] = [...new Set(BOT_FIRST_NAMES)];

/**
 * Build a roster of display names.
 *
 * Names are drawn without repetition, so no two bots share one. Once the pool
 * of bare first names runs out it starts adding initials, which is what makes
 * this scale past the size of the list.
 */
export function buildBotNames(count: number, random: () => number = Math.random): string[] {
  const pool = [...BOT_NAME_POOL];

  // Fisher-Yates, so the roster is not alphabetical.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }

  const names: string[] = [];
  const used = new Set<string>();

  for (const first of pool) {
    if (names.length >= count) break;
    // Most people go by a first name alone; some add an initial.
    const name = random() < 0.35
      ? `${first} ${BOT_SURNAME_INITIALS[Math.floor(random() * BOT_SURNAME_INITIALS.length)]}.`
      : first;
    if (used.has(name)) continue;
    used.add(name);
    names.push(name);
  }

  // Still short? Add initials to the names already used, rather than numbering
  // them — "Priya K." reads as a person, "Priya 2" does not.
  let letter = 0;
  while (names.length < count && letter < BOT_SURNAME_INITIALS.length * pool.length) {
    const first = pool[letter % pool.length]!;
    const initial = BOT_SURNAME_INITIALS[Math.floor(letter / pool.length) % BOT_SURNAME_INITIALS.length]!;
    const name = `${first} ${initial}.`;
    letter += 1;
    if (used.has(name)) continue;
    used.add(name);
    names.push(name);
  }

  return names;
}

/** A stable, URL-safe account name for a bot's display name. */
export function botUsername(displayName: string, index: number): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `bot_${slug}_${index}`;
}
