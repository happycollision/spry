import { describe, test, expect, afterAll } from "bun:test";
import { $ } from "bun";
import { branchForUnit, resolveRemoteTrackingTip } from "../../src/git/branch.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { PRUnit } from "../../src/parse/types.ts";
import type { SpryConfig } from "../../src/git/config.ts";

const config: SpryConfig = {
  trunk: "main",
  remote: "origin",
  branchPrefix: "spry/test",
  autoDeleteOnLand: false,
};

function singleUnit(id: string): PRUnit {
  return {
    type: "single",
    id,
    title: "T",
    commitIds: [id],
    commits: [id.repeat(5)],
    subjects: ["T"],
  };
}

function groupUnit(id: string): PRUnit {
  return {
    type: "group",
    id,
    title: "G",
    commitIds: [id],
    commits: [id.repeat(5)],
    subjects: ["T"],
  };
}

describe("branchForUnit", () => {
  test("returns <prefix>/<unit-id> for single units", () => {
    expect(branchForUnit(singleUnit("a1b2c3d4"), config)).toBe("spry/test/a1b2c3d4");
  });

  test("returns <prefix>/<unit-id> for group units", () => {
    expect(branchForUnit(groupUnit("grp00001"), config)).toBe("spry/test/grp00001");
  });

  test("works with prefixes containing slashes", () => {
    const prefixed: SpryConfig = { ...config, branchPrefix: "spry/dondenton" };
    expect(branchForUnit(singleUnit("a1"), prefixed)).toBe("spry/dondenton/a1");
  });

  test("throws on prefix that produces invalid branch names", () => {
    const bad: SpryConfig = { ...config, branchPrefix: "with spaces" };
    expect(() => branchForUnit(singleUnit("a1"), bad)).toThrow(/Invalid derived branch name/);
  });
});

describe("resolveRemoteTrackingTip", () => {
  const repos: Array<{ cleanup(): Promise<void> }> = [];
  afterAll(async () => {
    for (const r of repos) await r.cleanup();
  });

  const trackingConfig: SpryConfig = {
    trunk: "main",
    remote: "origin",
    branchPrefix: "spry/dondenton",
    autoDeleteOnLand: false,
  };

  function unit(id: string, tip: string): PRUnit {
    return {
      type: "single",
      id,
      title: undefined,
      commitIds: [id],
      commits: [tip],
      subjects: ["x"],
    };
  }

  test("returns undefined when the tracking ref is absent", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const git = createRealGitRunner();
    const tip = await resolveRemoteTrackingTip(git, unit("aaa11111", "deadbeef"), trackingConfig, {
      cwd: repo.path,
    });
    expect(tip).toBeUndefined();
  });

  test("returns the SHA when the tracking ref exists", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const git = createRealGitRunner();
    // Push a spry branch, then fetch so refs/remotes/origin/spry/dondenton/aaa11111 exists.
    await repo.branch("feature");
    await $`git -C ${repo.path} commit --allow-empty -m ${"c\n\nSpry-Commit-Id: aaa11111"}`.quiet();
    const sha = (await $`git -C ${repo.path} rev-parse HEAD`.quiet()).stdout.toString().trim();
    await $`git -C ${repo.path} push origin HEAD:refs/heads/spry/dondenton/aaa11111`.quiet();
    await $`git -C ${repo.path} fetch origin`.quiet();
    const tip = await resolveRemoteTrackingTip(git, unit("aaa11111", sha), trackingConfig, {
      cwd: repo.path,
    });
    expect(tip).toBe(sha);
  });
});
