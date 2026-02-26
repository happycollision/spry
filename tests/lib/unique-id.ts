const adjectives = [
  "happy", "swift", "brave", "calm", "eager", "fair", "glad", "keen",
  "bold", "warm", "wise", "cool", "pure", "kind", "free", "true",
  "rich", "safe", "dark", "deep", "firm", "flat", "full", "good",
  "hard", "high", "just", "late", "lean", "live", "long", "loud",
  "mild", "neat", "nice", "open", "pale", "pink", "rare", "real",
  "ripe", "slim", "soft", "sure", "tall", "thin", "tiny", "vast",
  "warm", "weak", "wild", "wiry", "young", "zany",
];

const nouns = [
  "penguin", "falcon", "tiger", "dolphin", "eagle", "panda", "otter",
  "whale", "hawk", "lynx", "wolf", "bear", "deer", "hare", "seal",
  "crow", "dove", "duck", "frog", "goat", "lamb", "lark", "lion",
  "mole", "moth", "newt", "puma", "quail", "robin", "slug", "swan",
  "toad", "vole", "wren", "yak", "fox", "owl", "elk", "ant", "bee",
  "cat", "dog", "emu", "gnu", "hen",
];

export function generateUniqueId(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]!;
  const noun = nouns[Math.floor(Math.random() * nouns.length)]!;
  const suffix = Math.random().toString(36).slice(2, 5);
  return `${adj}-${noun}-${suffix}`;
}
