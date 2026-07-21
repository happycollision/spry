import { describe, test, expect } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPRTemplate } from "../../src/gh/pr-template.ts";

// Each test owns its own temp dir and removes only that dir, so the suite is
// safe under `bun test --concurrent`: a shared dir list + blanket afterEach
// cleanup would let one test delete another's dir mid-run (ENOENT).
async function withTmp(fn: (cwd: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "spry-tmpl-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("findPRTemplate", () => {
  test("returns undefined when no template exists", async () => {
    await withTmp(async (cwd) => {
      expect(await findPRTemplate(cwd)).toBeUndefined();
    });
  });

  test("finds .github/PULL_REQUEST_TEMPLATE.md and trims it", async () => {
    await withTmp(async (cwd) => {
      await mkdir(join(cwd, ".github"), { recursive: true });
      await writeFile(join(cwd, ".github/PULL_REQUEST_TEMPLATE.md"), "\n## Testing\n\n- [ ]\n\n");
      expect(await findPRTemplate(cwd)).toBe("## Testing\n\n- [ ]");
    });
  });

  test("prefers .github over root location", async () => {
    await withTmp(async (cwd) => {
      await mkdir(join(cwd, ".github"), { recursive: true });
      await writeFile(join(cwd, ".github/pull_request_template.md"), "GITHUB DIR");
      await writeFile(join(cwd, "pull_request_template.md"), "ROOT");
      expect(await findPRTemplate(cwd)).toBe("GITHUB DIR");
    });
  });

  test("returns undefined when a template file exists but is blank", async () => {
    await withTmp(async (cwd) => {
      await mkdir(join(cwd, ".github"), { recursive: true });
      await writeFile(join(cwd, ".github/PULL_REQUEST_TEMPLATE.md"), "   \n\n  ");
      expect(await findPRTemplate(cwd)).toBeUndefined();
    });
  });
});
