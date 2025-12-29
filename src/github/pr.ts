import { $ } from "bun";
import { ensureGhInstalled } from "./api.ts";

export interface PRInfo {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  title: string;
}

export interface CreatePROptions {
  title: string;
  head: string;
  base: string;
  body?: string;
}

/**
 * Find an existing PR for a branch.
 * Returns null if no PR exists for the branch.
 */
export async function findPRByBranch(branchName: string): Promise<PRInfo | null> {
  await ensureGhInstalled();

  const result = await $`gh pr list --head ${branchName} --json number,url,state,title`
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    return null;
  }

  const prs = JSON.parse(result.stdout.toString()) as PRInfo[];

  if (prs.length === 0) {
    return null;
  }

  // Return first open PR, or first PR if none are open
  const openPR = prs.find((pr) => pr.state === "OPEN");
  return openPR || prs[0] || null;
}

/**
 * Create a new PR.
 */
export async function createPR(options: CreatePROptions): Promise<{ number: number; url: string }> {
  await ensureGhInstalled();

  const args = [
    "gh",
    "pr",
    "create",
    "--title",
    options.title,
    "--head",
    options.head,
    "--base",
    options.base,
  ];

  // Use --body="" syntax for empty body to avoid shell parsing issues
  if (options.body) {
    args.push("--body", options.body);
  } else {
    args.push("--body=");
  }

  const result = await $`${args}`;
  // gh pr create outputs the PR URL on success
  const url = result.stdout.toString().trim();

  // Extract PR number from URL (e.g., https://github.com/owner/repo/pull/123)
  const match = url.match(/\/pull\/(\d+)$/);
  if (!match?.[1]) {
    throw new Error(`Failed to parse PR URL: ${url}`);
  }

  return {
    number: parseInt(match[1], 10),
    url,
  };
}
