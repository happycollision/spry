import { describe, test, expect } from "bun:test";
import { fetchPRBody, updatePRBody } from "../../src/gh/pr.ts";
import type { SpryContext } from "../../src/lib/context.ts";
import type { CommandResult, CommandOptions } from "../../src/lib/context.ts";

function fakeCtx(handler: (args: string[], opts?: CommandOptions) => CommandResult): {
  ctx: SpryContext;
  calls: Array<{ args: string[]; opts?: CommandOptions }>;
} {
  const calls: Array<{ args: string[]; opts?: CommandOptions }> = [];
  const gh = {
    run: async (args: string[], opts?: CommandOptions): Promise<CommandResult> => {
      calls.push({ args, opts });
      return handler(args, opts);
    },
  };
  const ctx = { gh, git: {} as SpryContext["git"] } as SpryContext;
  return { ctx, calls };
}

const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): CommandResult => ({ exitCode: 1, stdout: "", stderr });

describe("fetchPRBody", () => {
  test("calls gh pr view --json body and returns the body string", async () => {
    const { ctx, calls } = fakeCtx(() => ok("Hello body\n"));
    const body = await fetchPRBody(ctx, 42, {});
    expect(body).toBe("Hello body");
    expect(calls[0]?.args).toEqual(["pr", "view", "42", "--json", "body", "--jq", ".body"]);
  });

  test("throws on gh failure", async () => {
    const { ctx } = fakeCtx(() => fail("boom"));
    await expect(fetchPRBody(ctx, 42, {})).rejects.toThrow(/boom/);
  });

  test("preserves the body's own trailing newline, stripping only gh's", () => {
    // gh --jq emits the body then one newline; a body that itself ends in "\n"
    // arrives as "...\n\n". We must strip exactly one, keeping the body's own.
    const { ctx } = fakeCtx(() => ok("Hello\n\n"));
    return fetchPRBody(ctx, 42, {}).then((body) => {
      expect(body).toBe("Hello\n");
    });
  });
});

describe("updatePRBody", () => {
  test("calls gh pr edit --body-file - with the body on stdin", async () => {
    const { ctx, calls } = fakeCtx(() => ok("edited"));
    await updatePRBody(ctx, 42, "NEW BODY", {});
    expect(calls[0]?.args).toEqual(["pr", "edit", "42", "--body-file", "-"]);
    expect(calls[0]?.opts?.stdin).toBe("NEW BODY");
  });

  test("throws on gh failure", async () => {
    const { ctx } = fakeCtx(() => fail("nope"));
    await expect(updatePRBody(ctx, 42, "x", {})).rejects.toThrow(/nope/);
  });
});
