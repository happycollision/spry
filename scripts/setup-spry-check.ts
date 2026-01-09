#!/usr/bin/env bun

import { $ } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Safety marker - this comment must be present in the README for us to force push
const SAFETY_MARKER = "<!-- spry-test-repo:v1 -->";

// Configurable via environment variables
const REPO_NAME = process.env.SPRY_TEST_REPO_NAME || "spry-check";
const REPO_OWNER = process.env.SPRY_TEST_REPO_OWNER; // If not set, uses authenticated user
const SKIP_CONFIRMATION = process.env.SPRY_TEST_REPO_SETUP_SKIP_CONFIRM === "1";

const README_CONTENT = `# ${REPO_NAME}

${SAFETY_MARKER}

This repository is used for integration testing of [spry](https://github.com/happycollision/spry).

## Purpose

- Tests PR creation, updates, and merging workflows
- Tests branch protection rule interactions
- Provides deterministic CI pass/fail via commit message markers

## CI Behavior

The CI workflow in this repository:
- **PASSES** for commits without special markers
- **FAILS** for commits containing \`[FAIL_CI]\` in the subject line

## Do Not

- Do not create manual PRs or branches in this repository
- Do not modify the CI workflow without updating spry's test expectations
- Do not add branch protection rules manually (tests manage this programmatically)

---
*This repository is automatically managed by spry integration tests.*
`;

const WORKFLOW_CONTENT = `name: CI Check

on:
  pull_request:
    branches: ["**"]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check for FAIL_CI marker
        run: |
          echo "Checking commits for [FAIL_CI] marker..."

          BASE_SHA=\${{ github.event.pull_request.base.sha }}
          HEAD_SHA=\${{ github.event.pull_request.head.sha }}

          FAIL_COMMITS=$(git log --format="%H %s" \${BASE_SHA}..\${HEAD_SHA} | grep -i "\\[FAIL_CI\\]" || true)

          if [ -n "$FAIL_COMMITS" ]; then
            echo "::error::Found commits with [FAIL_CI] marker:"
            echo "$FAIL_COMMITS"
            exit 1
          fi

          echo "All commits passed CI check."
`;

async function confirm(message: string): Promise<boolean> {
  if (SKIP_CONFIRMATION) {
    return true;
  }

  process.stdout.write(`${message} [y/N] `);

  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }

  return false;
}

async function verifyTestRepo(owner: string, repo: string): Promise<boolean> {
  // Try to fetch the README and check for safety marker
  const result = await $`gh api repos/${owner}/${repo}/contents/README.md --jq .content`.nothrow();

  if (result.exitCode !== 0) {
    // Repo exists but no README - could be empty, that's okay for new repos
    return false;
  }

  const content = Buffer.from(result.stdout.toString().trim(), "base64").toString("utf-8");
  return content.includes(SAFETY_MARKER);
}

async function main() {
  console.log("Setting up spry test repository...\n");

  // Get current user (or use provided owner)
  let owner: string;
  if (REPO_OWNER) {
    owner = REPO_OWNER;
    console.log(`Using configured owner: ${owner}`);
  } else {
    const ownerResult = await $`gh api user --jq .login`.nothrow();
    if (ownerResult.exitCode !== 0) {
      console.error("Failed to get GitHub username. Ensure gh CLI is authenticated.");
      console.error("Run: gh auth login");
      process.exit(1);
    }
    owner = ownerResult.stdout.toString().trim();
    console.log(`GitHub user: ${owner}`);
  }

  const fullRepoName = `${owner}/${REPO_NAME}`;
  console.log(`Target repository: ${fullRepoName}`);

  // Check if repo exists
  const repoCheck = await $`gh repo view ${fullRepoName} --json name`.nothrow();
  const repoExists = repoCheck.exitCode === 0;

  if (repoExists) {
    console.log(`Repository ${fullRepoName} already exists.`);

    // Safety check: verify this is a spry test repo before force pushing
    const isTestRepo = await verifyTestRepo(owner, REPO_NAME);

    if (!isTestRepo) {
      console.error("\n⚠️  SAFETY CHECK FAILED ⚠️");
      console.error(
        `Repository ${fullRepoName} exists but does not appear to be a spry test repo.`,
      );
      console.error(`The README is missing the safety marker: ${SAFETY_MARKER}`);
      console.error("\nThis script will FORCE PUSH and WIPE ALL BRANCHES.");
      console.error("If this is a real repository, you could lose data!\n");

      const proceed = await confirm("Are you SURE you want to continue?");
      if (!proceed) {
        console.log("Aborted.");
        process.exit(1);
      }

      console.log("\nProceeding despite safety check failure...");
    }
  } else {
    console.log(`Creating repository ${fullRepoName}...`);

    // Confirm before creating
    if (!SKIP_CONFIRMATION) {
      const proceed = await confirm(`Create new public repository ${fullRepoName}?`);
      if (!proceed) {
        console.log("Aborted.");
        process.exit(1);
      }
    }

    const createResult =
      await $`gh repo create ${REPO_NAME} --public --description "Test repository for spry integration tests"`.nothrow();
    if (createResult.exitCode !== 0) {
      console.error("Failed to create repository:");
      console.error(createResult.stderr.toString());
      process.exit(1);
    }
    console.log("Repository created.");
  }

  // Create a temp directory for the fresh repo
  const tmpDir = await mkdtemp(join(tmpdir(), "spry-check-setup-"));
  console.log(`Initializing in ${tmpDir}...`);

  try {
    // Initialize a fresh git repo (don't clone - we want to rewrite history)
    await $`git init ${tmpDir}`.quiet();
    await $`git -C ${tmpDir} remote add origin https://github.com/${fullRepoName}.git`.quiet();

    // Configure git
    await $`git -C ${tmpDir} config user.email "spry-tests@example.com"`.quiet();
    await $`git -C ${tmpDir} config user.name "spry-tests"`.quiet();

    // Write README
    await Bun.write(join(tmpDir, "README.md"), README_CONTENT);

    // Create .github/workflows directory and write workflow
    const workflowDir = join(tmpDir, ".github", "workflows");
    await $`mkdir -p ${workflowDir}`.quiet();
    await Bun.write(join(workflowDir, "ci.yml"), WORKFLOW_CONTENT);

    // Always create a fresh initial commit and force push
    // This ensures the repo always has exactly one commit
    console.log("Creating initial commit...");
    await $`git -C ${tmpDir} add -A`.quiet();
    await $`git -C ${tmpDir} commit -m "Initialize spry-check repository"`.quiet();
    await $`git -C ${tmpDir} branch -M main`.quiet();
    await $`git -C ${tmpDir} push --force origin main`.quiet();
    console.log("Force pushed to main (single commit).");
  } finally {
    // Cleanup temp directory
    await rm(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nSetup complete!`);
  console.log(`Repository: https://github.com/${fullRepoName}`);
  console.log(`\nYou can now run GitHub integration tests with:`);
  console.log(`  GITHUB_INTEGRATION_TESTS=1 bun test tests/integration/`);
  console.log(`\nEnvironment variables:`);
  console.log(`  SPRY_TEST_REPO_NAME   - Repository name (default: spry-check)`);
  console.log(`  SPRY_TEST_REPO_OWNER  - Repository owner (default: authenticated user)`);
  console.log(`  SPRY_TEST_REPO_SETUP_SKIP_CONFIRM=1 - Skip confirmation prompts (for CI)`);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
