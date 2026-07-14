import { test, expect } from "bun:test";
import { remoteSpryRef } from "../../src/lib/refs-seam.ts";

// The env is passed explicitly (never mutated) so these run safely under
// `bun test --concurrent`.

test("identity when SPRY_REMOTE_REFS_PREFIX is unset (production behavior)", () => {
  expect(remoteSpryRef("refs/spry/prs", {})).toBe("refs/spry/prs");
  expect(remoteSpryRef("refs/spry/groups", {})).toBe("refs/spry/groups");
});

test("remaps only the refs/spry prefix when set", () => {
  const env = { SPRY_REMOTE_REFS_PREFIX: "refs/spry/t-sync-020" };
  expect(remoteSpryRef("refs/spry/prs", env)).toBe("refs/spry/t-sync-020/prs");
  expect(remoteSpryRef("refs/spry/groups", env)).toBe("refs/spry/t-sync-020/groups");
  // A ref outside refs/spry is left alone (the seam is scoped to spry's
  // bookkeeping refs, never branches).
  expect(remoteSpryRef("refs/heads/main", env)).toBe("refs/heads/main");
});
