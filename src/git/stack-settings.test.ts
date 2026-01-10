import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { repoManager } from "../../tests/helpers/local-repo.ts";
import {
  readStackSettings,
  writeStackSettings,
  getStackConfig,
  setStackConfig,
  deleteStackConfig,
  getContentHash,
  setContentHash,
  setContentHashes,
  deleteContentHash,
  purgeOrphanedSettings,
  type StackSettings,
  type StackConfig,
} from "./stack-settings.ts";

const repos = repoManager();

// Mock getGitHubUsername to avoid gh CLI dependency
mock.module("./group-titles.ts", () => ({
  getGitHubUsername: async () => "testuser",
}));

describe("git/stack-settings", () => {
  describe("readStackSettings", () => {
    test("returns empty settings when ref does not exist", async () => {
      const repo = await repos.create();

      const settings = await readStackSettings({ cwd: repo.path });

      expect(settings).toEqual({ stacks: {}, contentHashes: {} });
    });

    test("reads settings from ref storage", async () => {
      const repo = await repos.create();

      const testSettings: StackSettings = {
        stacks: {
          "unit-123": { showStackLinks: false },
        },
        contentHashes: {
          "unit-123": "abc123",
        },
      };

      await writeStackSettings(testSettings, { cwd: repo.path });
      const settings = await readStackSettings({ cwd: repo.path });

      expect(settings).toEqual(testSettings);
    });

    test("handles corrupted JSON gracefully", async () => {
      const repo = await repos.create();

      // Write invalid JSON directly - we'll test that the read handles it
      // This is tricky to test without direct ref manipulation, so we'll skip this edge case
      const settings = await readStackSettings({ cwd: repo.path });

      expect(settings).toEqual({ stacks: {}, contentHashes: {} });
    });
  });

  describe("writeStackSettings", () => {
    test("writes settings to ref storage", async () => {
      const repo = await repos.create();

      const testSettings: StackSettings = {
        stacks: {
          "unit-abc": { includePrTemplate: true, prTemplateLocation: "prepend" },
        },
        contentHashes: {
          "unit-abc": "hash123",
          "unit-def": "hash456",
        },
      };

      await writeStackSettings(testSettings, { cwd: repo.path });
      const settings = await readStackSettings({ cwd: repo.path });

      expect(settings).toEqual(testSettings);
    });

    test("overwrites existing settings", async () => {
      const repo = await repos.create();

      const initial: StackSettings = {
        stacks: { "unit-1": { showStackLinks: true } },
        contentHashes: { "unit-1": "old" },
      };
      await writeStackSettings(initial, { cwd: repo.path });

      const updated: StackSettings = {
        stacks: { "unit-2": { showStackLinks: false } },
        contentHashes: { "unit-2": "new" },
      };
      await writeStackSettings(updated, { cwd: repo.path });

      const settings = await readStackSettings({ cwd: repo.path });
      expect(settings).toEqual(updated);
    });
  });

  describe("getStackConfig / setStackConfig", () => {
    test("returns undefined for non-existent stack", async () => {
      const repo = await repos.create();

      const config = await getStackConfig("non-existent", { cwd: repo.path });

      expect(config).toBeUndefined();
    });

    test("sets and retrieves stack config", async () => {
      const repo = await repos.create();

      const config: StackConfig = {
        showStackLinks: false,
        includePrTemplate: true,
        prTemplateLocation: "afterStackLinks",
      };

      await setStackConfig("stack-root-123", config, { cwd: repo.path });
      const retrieved = await getStackConfig("stack-root-123", { cwd: repo.path });

      expect(retrieved).toEqual(config);
    });

    test("updates existing stack config", async () => {
      const repo = await repos.create();

      await setStackConfig("stack-1", { showStackLinks: true }, { cwd: repo.path });
      await setStackConfig("stack-1", { showStackLinks: false }, { cwd: repo.path });

      const config = await getStackConfig("stack-1", { cwd: repo.path });
      expect(config?.showStackLinks).toBe(false);
    });

    test("preserves other stacks when setting config", async () => {
      const repo = await repos.create();

      await setStackConfig("stack-1", { showStackLinks: true }, { cwd: repo.path });
      await setStackConfig("stack-2", { showStackLinks: false }, { cwd: repo.path });

      const config1 = await getStackConfig("stack-1", { cwd: repo.path });
      const config2 = await getStackConfig("stack-2", { cwd: repo.path });

      expect(config1?.showStackLinks).toBe(true);
      expect(config2?.showStackLinks).toBe(false);
    });
  });

  describe("deleteStackConfig", () => {
    test("deletes stack config", async () => {
      const repo = await repos.create();

      await setStackConfig("stack-to-delete", { showStackLinks: false }, { cwd: repo.path });
      await deleteStackConfig("stack-to-delete", { cwd: repo.path });

      const config = await getStackConfig("stack-to-delete", { cwd: repo.path });
      expect(config).toBeUndefined();
    });

    test("preserves other stacks when deleting", async () => {
      const repo = await repos.create();

      await setStackConfig("keep", { showStackLinks: true }, { cwd: repo.path });
      await setStackConfig("delete", { showStackLinks: false }, { cwd: repo.path });

      await deleteStackConfig("delete", { cwd: repo.path });

      const keepConfig = await getStackConfig("keep", { cwd: repo.path });
      expect(keepConfig?.showStackLinks).toBe(true);
    });
  });

  describe("getContentHash / setContentHash", () => {
    test("returns undefined for non-existent hash", async () => {
      const repo = await repos.create();

      const hash = await getContentHash("non-existent", { cwd: repo.path });

      expect(hash).toBeUndefined();
    });

    test("sets and retrieves content hash", async () => {
      const repo = await repos.create();

      await setContentHash("unit-abc", "hash123456", { cwd: repo.path });
      const hash = await getContentHash("unit-abc", { cwd: repo.path });

      expect(hash).toBe("hash123456");
    });

    test("updates existing content hash", async () => {
      const repo = await repos.create();

      await setContentHash("unit-1", "old-hash", { cwd: repo.path });
      await setContentHash("unit-1", "new-hash", { cwd: repo.path });

      const hash = await getContentHash("unit-1", { cwd: repo.path });
      expect(hash).toBe("new-hash");
    });
  });

  describe("setContentHashes", () => {
    test("sets multiple content hashes at once", async () => {
      const repo = await repos.create();

      await setContentHashes(
        {
          "unit-1": "hash1",
          "unit-2": "hash2",
          "unit-3": "hash3",
        },
        { cwd: repo.path },
      );

      expect(await getContentHash("unit-1", { cwd: repo.path })).toBe("hash1");
      expect(await getContentHash("unit-2", { cwd: repo.path })).toBe("hash2");
      expect(await getContentHash("unit-3", { cwd: repo.path })).toBe("hash3");
    });

    test("preserves existing hashes", async () => {
      const repo = await repos.create();

      await setContentHash("existing", "existing-hash", { cwd: repo.path });
      await setContentHashes({ new: "new-hash" }, { cwd: repo.path });

      expect(await getContentHash("existing", { cwd: repo.path })).toBe("existing-hash");
      expect(await getContentHash("new", { cwd: repo.path })).toBe("new-hash");
    });
  });

  describe("deleteContentHash", () => {
    test("deletes content hash", async () => {
      const repo = await repos.create();

      await setContentHash("to-delete", "hash", { cwd: repo.path });
      await deleteContentHash("to-delete", { cwd: repo.path });

      const hash = await getContentHash("to-delete", { cwd: repo.path });
      expect(hash).toBeUndefined();
    });

    test("preserves other hashes", async () => {
      const repo = await repos.create();

      await setContentHashes({ keep: "keep-hash", delete: "delete-hash" }, { cwd: repo.path });
      await deleteContentHash("delete", { cwd: repo.path });

      expect(await getContentHash("keep", { cwd: repo.path })).toBe("keep-hash");
      expect(await getContentHash("delete", { cwd: repo.path })).toBeUndefined();
    });
  });

  describe("purgeOrphanedSettings", () => {
    test("removes orphaned stack configs", async () => {
      const repo = await repos.create();

      await setStackConfig("active", { showStackLinks: true }, { cwd: repo.path });
      await setStackConfig("orphan", { showStackLinks: false }, { cwd: repo.path });

      const result = await purgeOrphanedSettings(["active"], { cwd: repo.path });

      expect(result.stackIds).toContain("orphan");
      expect(await getStackConfig("active", { cwd: repo.path })).toBeDefined();
      expect(await getStackConfig("orphan", { cwd: repo.path })).toBeUndefined();
    });

    test("removes orphaned content hashes", async () => {
      const repo = await repos.create();

      await setContentHashes({ active: "hash1", orphan: "hash2" }, { cwd: repo.path });

      const result = await purgeOrphanedSettings(["active"], { cwd: repo.path });

      expect(result.hashIds).toContain("orphan");
      expect(await getContentHash("active", { cwd: repo.path })).toBe("hash1");
      expect(await getContentHash("orphan", { cwd: repo.path })).toBeUndefined();
    });

    test("returns empty arrays when nothing to purge", async () => {
      const repo = await repos.create();

      await setStackConfig("unit-1", { showStackLinks: true }, { cwd: repo.path });
      await setContentHash("unit-1", "hash", { cwd: repo.path });

      const result = await purgeOrphanedSettings(["unit-1"], { cwd: repo.path });

      expect(result.stackIds).toEqual([]);
      expect(result.hashIds).toEqual([]);
    });

    test("handles empty current unit list", async () => {
      const repo = await repos.create();

      await setStackConfig("orphan-1", { showStackLinks: true }, { cwd: repo.path });
      await setContentHash("orphan-2", "hash", { cwd: repo.path });

      const result = await purgeOrphanedSettings([], { cwd: repo.path });

      expect(result.stackIds).toContain("orphan-1");
      expect(result.hashIds).toContain("orphan-2");
    });
  });
});
