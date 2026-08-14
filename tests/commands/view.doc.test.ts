// Doc-producing tests for `sp view`. Each docTest must:
//   1. Call doc.scrub(repo) immediately after repos.push(repo) so the random
//      unique-id suffix is stripped from captured fragments.
//   2. Pass an explicit branch name to repo.branch(...) — never rely on the
//      auto-generated default. Branch names appear in `Stack: <branch>` and
//      will leak through if not deterministic.
//   3. Set spry.trunk, spry.remote, AND spry.branchPrefix before invoking sp
//      (loadConfig requires all three).
import { describe, afterAll, test, expect } from "bun:test";
import { $ } from "bun";
import { join } from "node:path";
import { docTest, createRunner, createRepo, createRealGitRunner } from "../lib/index.ts";
import { savePRCache } from "../../src/gh/pr-cache.ts";
import type { PRCacheEntry } from "../../src/gh/pr-cache.ts";

const cliPath = join(import.meta.dir, "../../src/cli/index.ts");
const runSp = createRunner(cliPath);

const repos: Array<{ cleanup(): Promise<void> }> = [];

afterAll(async () => {
  for (const repo of repos) {
    await repo.cleanup();
  }
});

describe("sp view docs", () => {
  docTest(
    "Viewing a simple stack (offline)",
    { section: "commands/view", order: 10 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.branch("feature");
      await git.run(
        ["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"],
        { cwd: repo.path },
      );
      await git.run(
        ["commit", "--allow-empty", "-m", "Add signup form\n\nSpry-Commit-Id: bbb22222"],
        { cwd: repo.path },
      );

      doc.prose("View the current stack of commits on your feature branch:");

      const { command, result } = await runSp(repo.path, "view");
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Stack:");
      expect(result.stdout).toContain("2 commits");
      expect(result.stdout).toContain("Add login page");
      expect(result.stdout).toContain("Add signup form");
    },
  );

  docTest("Viewing an empty stack", { section: "commands/view", order: 20 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    doc.prose("When you're on a branch with no commits ahead of trunk:");

    const { command, result } = await runSp(repo.path, "view");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No commits ahead of");
  });

  docTest("PR status from local cache", { section: "commands/view", order: 30 }, async (doc) => {
    const repo = await createRepo();
    repos.push(repo);
    doc.scrub(repo);
    const git = createRealGitRunner();

    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

    await repo.branch("feature");
    await git.run(["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });

    // Seed the local PR cache (normally written by sp sync)
    const entry: PRCacheEntry = {
      branch: "spry/dondenton/aaa11111",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "OPEN",
      title: "Add login page",
      baseRefName: "main",
      checksStatus: "passing",
      reviewDecision: "none",
      reviewThreads: { resolved: 0, total: 2 },
      cachedAt: "2026-06-07T00:00:00.000Z",
    };
    await savePRCache(git, { aaa11111: entry }, { cwd: repo.path });

    doc.prose(
      "sp view reads PR status from a local git ref written by sp sync — no network call needed:",
    );

    // Scrub the full PR URL to a stable placeholder for docs
    doc.scrub("https://github.com/owner/repo/pull/42", "https://github.com/<owner>/<repo>/pull/42");

    const { command, result } = await runSp(repo.path, "view");
    doc.command(command);
    doc.output(result.stdout);

    const { expect } = await import("bun:test");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("pull/42");
  });

  docTest(
    "Drift markers: what changed since your last sync",
    { section: "commands/view", order: 40 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.branch("feature");
      // Unit A — will stay clean. Unit B — will be locally amended.
      await git.run(
        ["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"],
        {
          cwd: repo.path,
        },
      );
      await git.run(
        ["commit", "--allow-empty", "-m", "Add signup form\n\nSpry-Commit-Id: bbb22222"],
        {
          cwd: repo.path,
        },
      );

      // Push both unit branches to the local origin and fetch, so remote-tracking
      // refs (refs/remotes/origin/spry/dondenton/<id>) exist — the offline
      // reference point for the ↓ (remote-ahead) signal.
      const shaA = (await $`git -C ${repo.path} rev-parse HEAD~1`.quiet()).stdout.toString().trim();
      const shaB = (await $`git -C ${repo.path} rev-parse HEAD`.quiet()).stdout.toString().trim();
      await $`git -C ${repo.path} push origin ${shaA}:refs/heads/spry/dondenton/aaa11111`.quiet();
      await $`git -C ${repo.path} push origin ${shaB}:refs/heads/spry/dondenton/bbb22222`.quiet();
      await $`git -C ${repo.path} fetch origin`.quiet();

      // Seed the PR cache as sp sync would: syncedHeadSha = the pushed tips.
      const base = {
        baseRefName: "main",
        checksStatus: "passing" as const,
        reviewDecision: "none" as const,
        reviewThreads: { resolved: 0, total: 0 },
        cachedAt: "2026-06-07T00:00:00.000Z",
      };
      const cache: Record<string, PRCacheEntry> = {
        aaa11111: {
          ...base,
          branch: "spry/dondenton/aaa11111",
          number: 1,
          state: "OPEN",
          title: "Add login page",
          url: "https://github.com/owner/repo/pull/1",
          syncedHeadSha: shaA,
        },
        bbb22222: {
          ...base,
          branch: "spry/dondenton/bbb22222",
          number: 2,
          state: "OPEN",
          title: "Add signup form",
          url: "https://github.com/owner/repo/pull/2",
          syncedHeadSha: shaB,
        },
      };
      await savePRCache(git, cache, { cwd: repo.path });

      doc.prose(
        "`sp view` marks how each unit has drifted since your last sync, entirely offline. " +
          "Right after a sync, nothing is marked:",
      );
      doc.scrub("https://github.com/owner/repo/pull/1", "https://github.com/<owner>/<repo>/pull/1");
      doc.scrub("https://github.com/owner/repo/pull/2", "https://github.com/<owner>/<repo>/pull/2");

      let out = await runSp(repo.path, "view");
      doc.command(out.command);
      doc.output(out.result.stdout);

      expect(out.result.stdout).not.toContain("✎");
      expect(out.result.stdout).not.toContain("↓");

      // Amend unit B locally with a real content change so its tip SHA changes
      // (an --allow-empty amend keeps the same SHA under the fixture's pinned
      // commit dates, which would produce no drift). Its local tip now diverges
      // from syncedHeadSha (✎).
      doc.prose(
        "Amend the second commit. Its local tip no longer matches what you pushed, " +
          "so it is flagged with ✎ — a signal to run `sp sync`:",
      );
      await Bun.write(join(repo.path, "signup.txt"), "signup form markup");
      await git.run(["add", "signup.txt"], { cwd: repo.path });
      await git.run(
        ["commit", "--amend", "-m", "Add signup form (revised)\n\nSpry-Commit-Id: bbb22222"],
        { cwd: repo.path },
      );

      out = await runSp(repo.path, "view");
      doc.command(out.command);
      doc.output(out.result.stdout);
      expect(out.result.stdout).toContain("✎");
      expect(out.result.stdout).toContain("local edits, run sp sync");

      doc.prose(
        "The ↓ marker means the remote moved since your push (as of your last fetch), and " +
          "✎↓ together means both. Units with no recorded sync show no marker at all.",
      );
    },
  );

  docTest(
    "Viewing a materialized merge group",
    { section: "commands/view", order: 50 },
    async (doc) => {
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.branch("feature");
      await git.run(
        ["commit", "--allow-empty", "-m", "feat: base change\n\nSpry-Commit-Id: p1p1p1p1"],
        {
          cwd: repo.path,
        },
      );
      await git.run(
        ["commit", "--allow-empty", "-m", "feat: add model\n\nSpry-Commit-Id: m1m1m1m1"],
        {
          cwd: repo.path,
        },
      );
      await git.run(
        ["commit", "--allow-empty", "-m", "feat: add handler\n\nSpry-Commit-Id: m2m2m2m2"],
        {
          cwd: repo.path,
        },
      );

      // Materialize a merge group over the two feat commits (see the sp group
      // docs for the --apply merge-node form); sp view then renders it.
      const applyDoc = JSON.stringify({
        stack: [
          { type: "commit", id: "p1p1p1p1" },
          {
            type: "merge",
            id: "mgmgmgmg",
            commits: [
              { type: "commit", id: "m1m1m1m1" },
              { type: "commit", id: "m2m2m2m2" },
            ],
          },
        ],
      });
      await runSp(repo.path, "group", ["--apply", applyDoc]);

      doc.prose(
        "When a stack contains a materialized merge group, `sp view` shows the merge on its own row and indents its member commits beneath it with a ⑃ marker — the merge axis reads as depth:",
      );

      const { command, result } = await runSp(repo.path, "view");
      doc.command(command);
      doc.output(result.stdout);

      const { expect } = await import("bun:test");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("⑃");
      expect(result.stdout).toContain("feat: add model");
      expect(result.stdout).toContain("feat: add handler");
    },
  );
});

describe("sp view drift (json)", () => {
  test("view --json exposes localAhead/remoteAhead", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });
    await repo.branch("feature");
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    const sha = (await $`git -C ${repo.path} rev-parse HEAD`.quiet()).stdout.toString().trim();
    await $`git -C ${repo.path} push origin ${sha}:refs/heads/spry/dondenton/aaa11111`.quiet();
    await $`git -C ${repo.path} fetch origin`.quiet();
    await savePRCache(
      git,
      {
        aaa11111: {
          branch: "spry/dondenton/aaa11111",
          number: 1,
          url: "u",
          state: "OPEN",
          title: "C",
          baseRefName: "main",
          checksStatus: "none",
          reviewDecision: "none",
          reviewThreads: { resolved: 0, total: 0 },
          cachedAt: "2026-06-07T00:00:00.000Z",
          syncedHeadSha: sha,
        },
      },
      { cwd: repo.path },
    );
    // Amend with a real content change to force a new tip SHA (an --allow-empty
    // amend keeps the same SHA under the fixture's pinned commit dates). The tip
    // now differs from both syncedHeadSha and the remote-tracking ref.
    await Bun.write(join(repo.path, "c.txt"), "content");
    await git.run(["add", "c.txt"], { cwd: repo.path });
    await git.run(["commit", "--amend", "-m", "C revised\n\nSpry-Commit-Id: aaa11111"], {
      cwd: repo.path,
    });
    const { result } = await runSp(repo.path, "view", ["--json"]);
    const tree = JSON.parse(result.stdout);
    expect(tree.stack[0].localAhead).toBe(true);
    expect(tree.stack[0].remoteAhead).toBe(true);
  });
});
