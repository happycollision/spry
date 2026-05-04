import { describe, test, expect } from "bun:test";
import { createPR, retargetPR } from "../../src/gh/pr.ts";
import { GhAuthError, GhNotInstalledError } from "../../src/gh/errors.ts";
import type {
  CommandOptions,
  CommandResult,
  GhClient,
  GitRunner,
  SpryContext,
} from "../../src/lib/context.ts";

interface Call {
  args: string[];
  stdin?: string;
  cwd?: string;
}

function makeCtx(responses: CommandResult[]): { ctx: SpryContext; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const gh: GhClient = {
    async run(args: string[], options?: CommandOptions): Promise<CommandResult> {
      calls.push({ args, stdin: options?.stdin, cwd: options?.cwd });
      const r = responses[i++];
      if (!r) throw new Error("stub gh: no more responses");
      return r;
    },
  };
  const git: GitRunner = {
    async run() {
      throw new Error("createPR/retargetPR should not call git");
    },
  };
  return { ctx: { git, gh }, calls };
}

describe("createPR", () => {
  test("returns parsed PR number and url on success", async () => {
    const { ctx, calls } = makeCtx([
      { stdout: "https://github.com/owner/repo/pull/42\n", stderr: "", exitCode: 0 },
    ]);

    const result = await createPR(ctx, {
      title: "Add login",
      head: "spry/test/aaa",
      base: "main",
      body: "Body content",
    });
    expect(result).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "pr",
      "create",
      "--title",
      "Add login",
      "--head",
      "spry/test/aaa",
      "--base",
      "main",
      "--body-file",
      "-",
    ]);
    expect(calls[0]?.stdin).toBe("Body content");
  });

  test("retries on transient stderr, succeeds on second attempt", async () => {
    const { ctx, calls } = makeCtx([
      { stdout: "", stderr: "HTTP 503: Service Unavailable", exitCode: 1 },
      { stdout: "https://github.com/owner/repo/pull/7\n", stderr: "", exitCode: 0 },
    ]);
    const result = await createPR(ctx, {
      title: "T",
      head: "h",
      base: "b",
      body: "",
    });
    expect(result.number).toBe(7);
    expect(calls).toHaveLength(2);
  });

  test("throws GhAuthError when stderr indicates auth failure", async () => {
    const { ctx } = makeCtx([
      { stdout: "", stderr: "You are not logged into any GitHub hosts.", exitCode: 4 },
    ]);
    await expect(
      createPR(ctx, { title: "T", head: "h", base: "b", body: "" }),
    ).rejects.toBeInstanceOf(GhAuthError);
  });

  test("throws GhNotInstalledError when gh is missing", async () => {
    const { ctx } = makeCtx([
      { stdout: "", stderr: "/bin/sh: gh: command not found", exitCode: 127 },
    ]);
    await expect(
      createPR(ctx, { title: "T", head: "h", base: "b", body: "" }),
    ).rejects.toBeInstanceOf(GhNotInstalledError);
  });

  test("throws plain Error after retry exhaustion on transient failures", async () => {
    const transient: CommandResult = {
      stdout: "",
      stderr: "HTTP 503: Service Unavailable",
      exitCode: 1,
    };
    const { ctx } = makeCtx([transient, transient, transient]);
    await expect(createPR(ctx, { title: "T", head: "h", base: "b", body: "" })).rejects.toThrow(
      /gh failed/,
    );
  });

  test("does not retry on non-transient failures", async () => {
    const { ctx, calls } = makeCtx([
      { stdout: "", stderr: "validation error: branch already has open PR", exitCode: 1 },
    ]);
    await expect(createPR(ctx, { title: "T", head: "h", base: "b", body: "" })).rejects.toThrow(
      /gh failed/,
    );
    expect(calls).toHaveLength(1);
  });

  test("parses URL from stdout even with preamble lines", async () => {
    const { ctx } = makeCtx([
      {
        stdout:
          "Creating pull request for spry/test/aaa into main in owner/repo\nhttps://github.com/owner/repo/pull/99\n",
        stderr: "",
        exitCode: 0,
      },
    ]);
    const result = await createPR(ctx, { title: "T", head: "h", base: "b", body: "" });
    expect(result.number).toBe(99);
    expect(result.url).toBe("https://github.com/owner/repo/pull/99");
  });

  test("body with shell-special characters reaches stdin verbatim", async () => {
    const body = "Line 1\n--flag-looking\n$VAR `cmd` \"quoted\" 'apostrophes'";
    const { ctx, calls } = makeCtx([
      { stdout: "https://github.com/owner/repo/pull/1\n", stderr: "", exitCode: 0 },
    ]);
    await createPR(ctx, { title: "T", head: "h", base: "b", body });
    expect(calls[0]?.stdin).toBe(body);
  });

  test("throws helpful error when stdout has no PR URL", async () => {
    const { ctx } = makeCtx([{ stdout: "ok\n", stderr: "", exitCode: 0 }]);
    await expect(createPR(ctx, { title: "T", head: "h", base: "b", body: "" })).rejects.toThrow(
      /could not parse PR URL.*ok/,
    );
  });
});

describe("retargetPR", () => {
  test("calls gh pr edit <number> --base <newBase>", async () => {
    const { ctx, calls } = makeCtx([{ stdout: "", stderr: "", exitCode: 0 }]);
    await retargetPR(ctx, 123, "spry/test/aaa");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["pr", "edit", "123", "--base", "spry/test/aaa"]);
  });

  test("retries on transient failures", async () => {
    const { ctx, calls } = makeCtx([
      { stdout: "", stderr: "HTTP 502: Bad Gateway", exitCode: 1 },
      { stdout: "", stderr: "", exitCode: 0 },
    ]);
    await retargetPR(ctx, 1, "main");
    expect(calls).toHaveLength(2);
  });

  test("throws on auth failure", async () => {
    const { ctx } = makeCtx([{ stdout: "", stderr: "authentication required", exitCode: 4 }]);
    await expect(retargetPR(ctx, 1, "main")).rejects.toBeInstanceOf(GhAuthError);
  });

  test("retargetPR throws plain Error after retry exhaustion", async () => {
    const transient: CommandResult = {
      stdout: "",
      stderr: "HTTP 503: Service Unavailable",
      exitCode: 1,
    };
    const { ctx, calls } = makeCtx([transient, transient, transient]);
    await expect(retargetPR(ctx, 1, "main")).rejects.toThrow(/gh failed/);
    expect(calls).toHaveLength(3);
  });
});
