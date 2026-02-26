import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  createRealGitRunner,
  createRecordingClient,
  createReplayingClient,
  createRepo,
  createScreenBuffer,
  collectFragment,
  getDocFragments,
  clearDocFragments,
} from "./index.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/smoke");

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  clearDocFragments();
});

test("all four pillars work together", async () => {
  // Pillar 1: DI + Record/Replay
  const git = createRealGitRunner();
  const cassettePath = join(tmpDir, "smoke.json");
  const recorder = createRecordingClient(git, cassettePath);
  const versionResult = await recorder.run(["--version"]);
  await recorder.flush();

  const replayer = await createReplayingClient(cassettePath);
  const replayed = await replayer.run(["--version"]);
  expect(replayed.stdout).toBe(versionResult.stdout);

  // Pillar 2: RepoScenario
  const repo = await createRepo();
  await repo.commit("Test commit");
  const branch = await repo.branch("feature");
  expect(branch).toContain(repo.uniqueId);
  const currentBranch = await repo.currentBranch();
  expect(currentBranch).toBe(branch);
  await repo.cleanup();

  // Pillar 3: ScreenBuffer (ANSI parser)
  const screen = createScreenBuffer(40, 10);
  screen.write("\x1b[1;1HGroup Editor\x1b[2;1H→ [A] abc123 First commit");
  expect(screen.lineAt(0)).toBe("Group Editor");
  expect(screen.lineAt(1)).toContain("→ [A] abc123 First commit");

  // Pillar 4: DocEmitter
  collectFragment({
    title: "Smoke test",
    section: "meta/smoke",
    order: 1,
    entries: [
      { type: "prose", content: "All four pillars verified." },
      { type: "command", content: "sp sync" },
    ],
  });
  expect(getDocFragments()).toHaveLength(1);
});
