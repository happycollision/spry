import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPRTemplate } from "../../src/gh/pr-template.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "spry-tmpl-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

describe("findPRTemplate", () => {
  test("returns undefined when no template exists", async () => {
    const cwd = await tmp();
    expect(await findPRTemplate(cwd)).toBeUndefined();
  });

  test("finds .github/PULL_REQUEST_TEMPLATE.md and trims it", async () => {
    const cwd = await tmp();
    await mkdir(join(cwd, ".github"), { recursive: true });
    await writeFile(join(cwd, ".github/PULL_REQUEST_TEMPLATE.md"), "\n## Testing\n\n- [ ]\n\n");
    expect(await findPRTemplate(cwd)).toBe("## Testing\n\n- [ ]");
  });

  test("prefers .github over root location", async () => {
    const cwd = await tmp();
    await mkdir(join(cwd, ".github"), { recursive: true });
    await writeFile(join(cwd, ".github/pull_request_template.md"), "GITHUB DIR");
    await writeFile(join(cwd, "pull_request_template.md"), "ROOT");
    expect(await findPRTemplate(cwd)).toBe("GITHUB DIR");
  });

  test("returns undefined when a template file exists but is blank", async () => {
    const cwd = await tmp();
    await mkdir(join(cwd, ".github"), { recursive: true });
    await writeFile(join(cwd, ".github/PULL_REQUEST_TEMPLATE.md"), "   \n\n  ");
    expect(await findPRTemplate(cwd)).toBeUndefined();
  });
});
