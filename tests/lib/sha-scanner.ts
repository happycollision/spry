export const SHA_POOL: readonly string[] = [
  "3f8a2c91d4e6b0f7a5c2e8d1b9f3a7c4e0d6b2f8",
  "b47e1d05c9f2a8e3d7b0c4f1e6a2d8b5c3f9e1a7",
  "7c3d9e2f1a8b5c4d0e7f6a3b9c1d8e5f2a4b7c0d",
  "a1f4b8e2c7d3f9a5b0e6c4d1f8a3b7e9c2d5f0a6",
  "e5b0c3d8f2a7b4e1c9d6f3a0b8e4c2d7f5a1b9e3",
  "2d7f4a1b9e6c3d8f5a2b7e4c0d9f6a3b1e7c4d2f",
  "f1a9e4c2d7b5f0a8e3c6d1b9f4a2e7c5d0b3f8a1",
  "8e3b6f1c4d9a7e2b5f0c8d3a6b1e4f9c7d2a5b0e",
  "c5d2a9f6b3e0c7d4a1f8b5e2c9d6a3f0b7e4c1d8",
  "6a1e8b3d5f2c9a6e3b0d7f4c1a8e5b2d9f6c3a0e",
  "d9f3c0a7e4b1d8f5c2a9e6b3d0f7c4a1e8b5d2f9",
  "4b7e1d8f5c2a9b6e3d0f7c4b1e8d5f2c9a6e3b0d",
  "9c6a3f0e7d4b1c8f5a2e9d6c3b0f7a4e1d8c5b2f",
  "1e4d7b0c8f5a2e9d6c3a0f7b4e1d8c5b2f9a6e3d",
  "5f2a8d1e4b7c0f3a6d9e2b5c8f1d4a7e0b3c6f9d",
  "0b3c6f9d2a5e8b1d4c7f0a3e6d9c2b5f8a1d4c7e",
  "e7d4a1c8b5f2e9c6a3d0b7e4c1f8a5d2b9e6c3f0",
  "8c1f5a9d2e7b4c0f6a3e8d1b5c9f2a7e4d0b6c3f",
];

export const SPRY_ID_POOL: readonly string[] = [
  "aaaa1111",
  "bbbb2222",
  "cccc3333",
  "dddd4444",
  "eeee5555",
  "ffff6666",
  "aaaa7777",
  "bbbb8888",
  "cccc9999",
  "ddddaaaa",
  "eeeebbbb",
  "ffffcccc",
  "aaaadddd",
  "bbbbeeee",
  "ccccffff",
  "dddd5555",
  "eeee6666",
  "ffff7777",
];

export function buildShaMap(shas: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const sha of shas) {
    if (map.has(sha)) continue;
    if (map.size >= SHA_POOL.length) {
      throw new Error(
        `SHA_POOL exhausted — ${map.size + 1} unique SHAs needed but pool only has ${SHA_POOL.length} entries.\n` +
          `Add more 40-char entries to SHA_POOL in tests/lib/sha-scanner.ts.`,
      );
    }
    map.set(sha, SHA_POOL[map.size]);
  }
  return map;
}

export function buildSpryMap(spryIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of spryIds) {
    if (map.has(id)) continue;
    if (map.size >= SPRY_ID_POOL.length) {
      throw new Error(
        `SPRY_ID_POOL exhausted — ${map.size + 1} unique Spry-Commit-Ids needed but pool only has ${SPRY_ID_POOL.length} entries.\n` +
          `Add more 8-char entries to SPRY_ID_POOL in tests/lib/sha-scanner.ts.`,
      );
    }
    map.set(id, SPRY_ID_POOL[map.size]);
  }
  return map;
}

function isHexChar(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f");
}

export function scanAndReplace(
  content: string,
  shaMap: Map<string, string>,
  spryMap: Map<string, string>,
): string {
  if (shaMap.size === 0 && spryMap.size === 0) return content;

  const shas = [...shaMap.keys()];

  let result = "";
  let i = 0;

  while (i < content.length) {
    if (!isHexChar(content[i])) {
      result += content[i++];
      continue;
    }

    // Consume hex run greedily up to 40 chars
    let j = i;
    while (j < content.length && j - i < 40 && isHexChar(content[j])) j++;
    const runLen = j - i;

    if (runLen < 6) {
      result += content.slice(i, j);
      i = j;
      continue;
    }

    // Try longest match first, down to min 6
    let matched = false;
    for (let len = runLen; len >= 6; len--) {
      const candidate = content.slice(i, i + len);

      // Spry-Commit-Ids are always exactly 8 chars — check at len === 8 only
      if (len === 8) {
        const spryFake = spryMap.get(candidate);
        if (spryFake) {
          result += spryFake;
          i += len;
          matched = true;
          break;
        }
      }

      // SHA: any registered SHA that starts with this candidate
      const sha = shas.find((s) => s.startsWith(candidate));
      if (sha) {
        result += shaMap.get(sha)?.slice(0, len) ?? "";
        i += len;
        matched = true;
        break;
      }
    }

    if (!matched) {
      result += content[i];
      i++;
    }
  }

  return result;
}
