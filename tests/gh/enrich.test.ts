import { describe, test, expect } from "bun:test";
import { enrichUnits, enrichFromCache } from "../../src/gh/enrich.ts";
import type { CommandResult, GhClient, GitRunner, SpryContext } from "../../src/lib/context.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import type { PRCache, PRCacheEntry } from "../../src/gh/pr-cache.ts";
import type { SpryConfig } from "../../src/git/config.ts";

const config: SpryConfig = {
  trunk: "main",
  remote: "origin",
  branchPrefix: "spry/test",
  autoDeleteOnLand: false,
};

function unit(id: string): PRUnit {
  return {
    type: "single",
    id,
    title: "T",
    commitIds: [id],
    commits: [id.repeat(5)],
    subjects: ["T"],
  };
}

/**
 * Batched (aliased) gh response. `table` maps a unit's branch
 * (`spry/test/<id>`) to its PR JSON (or null). The stub reads the `bK=<branch>`
 * args to emit the matching alias fields (data.repository.bK), mirroring the
 * real batched query.
 */
function ghBatch(table: Record<string, object | null>): (args: string[]) => CommandResult {
  return (args) => {
    const repository: Record<string, { nodes: object[] }> = {};
    for (const a of args) {
      const m = /^(b\d+)=(.*)$/.exec(a);
      if (!m) continue;
      const branch = m[2]!;
      const pr = branch in table ? table[branch]! : null;
      repository[m[1]!] = { nodes: pr === null ? [] : [pr] };
    }
    return { stdout: JSON.stringify({ data: { repository } }), stderr: "", exitCode: 0 };
  };
}

const samplePR = {
  number: 1,
  url: "https://github.com/owner/repo/pull/1",
  state: "OPEN",
  title: "T",
  baseRefName: "main",
  reviewDecision: null,
  reviewThreads: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
};

/**
 * ctx whose gh is driven by a per-call handler (args, attempt) → result. The
 * batched lookup issues one call per chunk, so responses derive from the call's
 * args (branches) rather than a fixed positional list; `attempt` enables retry
 * sequences.
 */
function makeCtx(handler: (args: string[], attempt: number) => CommandResult): SpryContext {
  let attempt = 0;
  const gh: GhClient = {
    async run(args) {
      return handler(args, attempt++);
    },
  };
  const git: GitRunner = {
    async run() {
      throw new Error("enrichUnits should not call git");
    },
  };
  return { git, gh };
}

/** A handler that returns the same error result for every call. */
function ghError(stderr: string, exitCode = 1): (args: string[]) => CommandResult {
  return () => ({ stdout: "", stderr, exitCode });
}

describe("enrichUnits", () => {
  test("empty units array returns empty array, no gh call", async () => {
    const ctx = makeCtx(() => {
      throw new Error("should not call gh");
    });
    const result = await enrichUnits(ctx, [], config);
    expect(result).toEqual([]);
  });

  test("populates pr field for each unit on success", async () => {
    // Branch names are `${branchPrefix}/${id}` = spry/test/<id>.
    const ctx = makeCtx(ghBatch({ "spry/test/aaa11111": samplePR, "spry/test/bbb22222": null }));
    const result = await enrichUnits(ctx, [unit("aaa11111"), unit("bbb22222")], config);

    expect(result).toHaveLength(2);
    expect(result[0]!.unit.id).toBe("aaa11111");
    expect(result[0]!.pr?.number).toBe(1);
    expect(result[1]!.unit.id).toBe("bbb22222");
    expect(result[1]!.pr).toBeNull();
    expect(result.every((r) => r.error === undefined)).toBe(true);
  });

  test("returns error: 'no-gh' when gh is not installed", async () => {
    const ctx = makeCtx(ghError("/bin/sh: gh: command not found", 127));
    const result = await enrichUnits(ctx, [unit("aaa11111"), unit("bbb22222")], config);

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.error === "no-gh")).toBe(true);
    expect(result.every((r) => r.pr === null)).toBe(true);
  });

  test("returns error: 'auth' when gh is not authenticated", async () => {
    const ctx = makeCtx(ghError("You are not logged into any GitHub hosts.", 4));
    const result = await enrichUnits(ctx, [unit("aaa11111")], config);
    expect(result[0]!.error).toBe("auth");
  });

  test("returns error: 'no-remote' when repo is not a GitHub repo", async () => {
    const ctx = makeCtx(ghError("no GitHub remotes found in the current directory", 1));
    const result = await enrichUnits(ctx, [unit("aaa11111")], config);
    expect(result[0]!.error).toBe("no-remote");
  });

  test("returns error: 'network' for other post-retry failures", async () => {
    // Every attempt is transient → the retry budget is exhausted → network.
    const ctx = makeCtx(ghError("HTTP 503: Service Unavailable", 1));
    const result = await enrichUnits(ctx, [unit("aaa11111")], config);
    expect(result[0]!.error).toBe("network");
  });
});

function makeCacheEntry(overrides: Partial<PRCacheEntry> = {}): PRCacheEntry {
  return {
    branch: "spry/test/aaa11111",
    number: 42,
    url: "https://github.com/owner/repo/pull/42",
    state: "OPEN",
    title: "T",
    baseRefName: "main",
    checksStatus: "passing",
    reviewDecision: "approved",
    reviewThreads: { resolved: 1, total: 1 },
    cachedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("enrichFromCache", () => {
  test("returns null pr for units with no cache entry", () => {
    const result = enrichFromCache([unit("aaa11111"), unit("bbb22222")], {});
    expect(result).toHaveLength(2);
    expect(result[0]!.pr).toBeNull();
    expect(result[1]!.pr).toBeNull();
    expect(result.every((r) => r.error === undefined)).toBe(true);
  });

  test("populates pr from cache for known unit IDs", () => {
    const cache: PRCache = {
      aaa11111: makeCacheEntry({ number: 42 }),
    };
    const result = enrichFromCache([unit("aaa11111"), unit("bbb22222")], cache);
    expect(result[0]!.pr?.number).toBe(42);
    expect(result[1]!.pr).toBeNull();
  });

  test("strips cachedAt and branch before returning PRInfo shape", () => {
    const cache: PRCache = {
      aaa11111: makeCacheEntry({ number: 42 }),
    };
    const result = enrichFromCache([unit("aaa11111")], cache);
    const pr = result[0]!.pr as Record<string, unknown> | null;
    expect(pr).not.toBeNull();
    expect(pr?.number).toBe(42);
    expect(pr?.state).toBe("OPEN");
    expect(pr?.cachedAt).toBeUndefined();
    expect(pr?.branch).toBeUndefined();
  });
});
