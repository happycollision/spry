const adjectives = [
  "happy",
  "swift",
  "brave",
  "calm",
  "eager",
  "fair",
  "glad",
  "keen",
  "bold",
  "warm",
  "wise",
  "cool",
  "pure",
  "kind",
  "free",
  "true",
  "rich",
  "safe",
  "dark",
  "deep",
  "firm",
  "flat",
  "full",
  "good",
  "hard",
  "high",
  "just",
  "late",
  "lean",
  "live",
  "long",
  "loud",
  "mild",
  "neat",
  "nice",
  "open",
  "pale",
  "pink",
  "rare",
  "real",
  "ripe",
  "slim",
  "soft",
  "sure",
  "tall",
  "thin",
  "tiny",
  "vast",
  "warm",
  "weak",
  "wild",
  "wiry",
  "young",
  "zany",
];

const nouns = [
  "penguin",
  "falcon",
  "tiger",
  "dolphin",
  "eagle",
  "panda",
  "otter",
  "whale",
  "hawk",
  "lynx",
  "wolf",
  "bear",
  "deer",
  "hare",
  "seal",
  "crow",
  "dove",
  "duck",
  "frog",
  "goat",
  "lamb",
  "lark",
  "lion",
  "mole",
  "moth",
  "newt",
  "puma",
  "quail",
  "robin",
  "slug",
  "swan",
  "toad",
  "vole",
  "wren",
  "yak",
  "fox",
  "owl",
  "elk",
  "ant",
  "bee",
  "cat",
  "dog",
  "emu",
  "gnu",
  "hen",
];

let rng: () => number = Math.random;

export function seedUniqueId(seed: string): void {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  rng = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resetUniqueIdSeed(): void {
  rng = Math.random;
}

export function generateUniqueId(): string {
  const adj = adjectives[Math.floor(rng() * adjectives.length)] ?? "happy";
  const noun = nouns[Math.floor(rng() * nouns.length)] ?? "penguin";
  const suffix = rng().toString(36).slice(2, 5);
  return `${adj}-${noun}-${suffix}`;
}
