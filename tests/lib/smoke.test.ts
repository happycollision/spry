import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  createRealGitRunner,
  createRecordingClient,
  createReplayingClient,
  createRepo,
  createScreenBuffer,
  fragmentPath,
} from "./index.ts";

const tmpDir = join(import.meta.dir, "../../.test-tmp/smoke");

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  await rm(fragmentPath({ section: "meta/smoke", order: 1 }), { force: true });
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

  // Pillar 3 extension: ANSI color tracking
  const colorScreen = createScreenBuffer(20, 3);
  colorScreen.write("\x1b[32mhello\x1b[0m world");
  const colorSnap = colorScreen.capture();
  expect(colorSnap.ansi).toContain("\x1b[32mhello\x1b[0m");
  expect(colorSnap.ansi).toContain(" world");
  expect(colorSnap.text).toBe("hello world"); // plain text unchanged

  // Pillar 4: DocEmitter (disk write)
  // Using Bun.write directly to avoid registering a bun test inside a bun test.
  const smokeFragment = {
    title: "Smoke test",
    section: "meta/smoke",
    order: 1,
    entries: [{ type: "prose", content: "All four pillars verified." }],
  };
  const smokePath = fragmentPath(smokeFragment);
  await Bun.write(smokePath, JSON.stringify(smokeFragment));
  expect(await Bun.file(smokePath).exists()).toBe(true);
});
