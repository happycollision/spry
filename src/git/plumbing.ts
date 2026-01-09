import { $ } from "bun";
import type { GitOptions } from "./commands.ts";
import { asserted } from "../utils/assert.ts";

/**
 * Git plumbing operations that work directly on the object database.
 *
 * These functions operate on .git/objects directly without touching the working
 * directory, preventing issues with untracked files and providing significant
 * performance improvements.
 *
 * Key benefits:
 * - No "untracked working tree files would be overwritten" errors
 * - 10-150x performance improvement for message-only operations
 * - Conflict detection without modifying working directory
 * - Single reset at end only when tree actually changes
 *
 * Requirements:
 * - Git 2.38+ for `git merge-tree --write-tree`
 */

/**
 * Minimum Git version required for plumbing operations.
 * Git 2.38 introduced `git merge-tree --write-tree`.
 */
export const MIN_GIT_VERSION = "2.38.0";

export interface GitVersionResult {
  ok: true;
  version: string;
}

export interface GitVersionError {
  ok: false;
  version: string;
  minRequired: string;
}

/**
 * Check if Git version supports plumbing operations.
 * Requires Git 2.38+ for `git merge-tree --write-tree`.
 */
export async function checkGitVersion(
  options: GitOptions = {},
): Promise<GitVersionResult | GitVersionError> {
  const { cwd } = options;

  const result = cwd ? await $`git -C ${cwd} --version`.text() : await $`git --version`.text();

  // Parse "git version X.Y.Z" or "git version X.Y.Z.windows.N"
  const match = result.match(/git version (\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { ok: false, version: result.trim(), minRequired: MIN_GIT_VERSION };
  }

  const major = parseInt(asserted(match[1]), 10);
  const minor = parseInt(asserted(match[2]), 10);
  const version = `${major}.${minor}.${asserted(match[3])}`;

  // Check version >= 2.38
  if (major < 2 || (major === 2 && minor < 38)) {
    return { ok: false, version, minRequired: MIN_GIT_VERSION };
  }

  return { ok: true, version };
}

/**
 * Get the tree SHA from a commit.
 *
 * @param commit - Commit reference (SHA, HEAD, branch name, etc.)
 * @returns Tree SHA
 */
export async function getTree(commit: string, options: GitOptions = {}): Promise<string> {
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} rev-parse ${commit}^{tree}`.text()
    : await $`git rev-parse ${commit}^{tree}`.text();

  return result.trim();
}

/**
 * Get all parent SHAs of a commit.
 *
 * @param commit - Commit reference
 * @returns Array of parent SHAs (empty for root commit, one for normal, multiple for merge)
 */
export async function getParents(commit: string, options: GitOptions = {}): Promise<string[]> {
  const { cwd } = options;

  // git rev-parse commit^@ outputs all parents, one per line
  // For a root commit with no parents, this outputs nothing
  const result = cwd
    ? await $`git -C ${cwd} rev-parse ${commit}^@`.nothrow().text()
    : await $`git rev-parse ${commit}^@`.nothrow().text();

  const trimmed = result.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed.split("\n").map((line) => line.trim());
}

/**
 * Get the first parent of a commit.
 * Throws if the commit has no parents (root commit).
 */
export async function getParent(commit: string, options: GitOptions = {}): Promise<string> {
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} rev-parse ${commit}^`.text()
    : await $`git rev-parse ${commit}^`.text();

  return result.trim();
}

/**
 * Get author information from a commit as environment variables.
 * Use this when creating a new commit that should preserve the original author.
 *
 * @returns Environment variables for GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_AUTHOR_DATE
 */
export async function getAuthorEnv(
  commit: string,
  options: GitOptions = {},
): Promise<Record<string, string>> {
  const { cwd } = options;

  // Get author info in a parseable format
  // %an = author name, %ae = author email, %ai = author date ISO format
  const result = cwd
    ? await $`git -C ${cwd} log -1 --format=%an%x00%ae%x00%ai ${commit}`.text()
    : await $`git log -1 --format=%an%x00%ae%x00%ai ${commit}`.text();

  const [name = "", email = "", date = ""] = result.trim().split("\x00");

  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
  };
}

/**
 * Get both author and committer information from a commit as environment variables.
 * Use this for message-only changes where both timestamps should be preserved.
 *
 * @returns Environment variables for all author and committer fields
 */
export async function getAuthorAndCommitterEnv(
  commit: string,
  options: GitOptions = {},
): Promise<Record<string, string>> {
  const { cwd } = options;

  // Get author and committer info
  // %an/%ae/%ai = author name/email/date
  // %cn/%ce/%ci = committer name/email/date
  const result = cwd
    ? await $`git -C ${cwd} log -1 --format=%an%x00%ae%x00%ai%x00%cn%x00%ce%x00%ci ${commit}`.text()
    : await $`git log -1 --format=%an%x00%ae%x00%ai%x00%cn%x00%ce%x00%ci ${commit}`.text();

  const [
    authorName = "",
    authorEmail = "",
    authorDate = "",
    committerName = "",
    committerEmail = "",
    committerDate = "",
  ] = result.trim().split("\x00");

  return {
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_AUTHOR_DATE: authorDate,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
    GIT_COMMITTER_DATE: committerDate,
  };
}

/**
 * Get the full commit message for a commit.
 */
export async function getCommitMessage(commit: string, options: GitOptions = {}): Promise<string> {
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} log -1 --format=%B ${commit}`.text()
    : await $`git log -1 --format=%B ${commit}`.text();

  // Trim trailing newlines but preserve internal formatting
  return result.replace(/\n+$/, "");
}

/**
 * Create a new commit using git commit-tree.
 *
 * This is the core plumbing primitive. It creates a commit object
 * directly in .git/objects without touching the working directory or index.
 *
 * @param tree - Tree SHA for the commit's contents
 * @param parents - Array of parent commit SHAs
 * @param message - Commit message
 * @param env - Environment variables (author/committer info)
 * @returns SHA of the new commit
 */
export async function createCommit(
  tree: string,
  parents: string[],
  message: string,
  env: Record<string, string>,
  options: GitOptions = {},
): Promise<string> {
  const { cwd } = options;

  // Build parent flags
  const parentFlags = parents.flatMap((p) => ["-p", p]);

  // Use stdin for message to handle special characters properly
  const messageBuffer = Buffer.from(message);

  const proc = cwd
    ? $`git -C ${cwd} commit-tree ${tree} ${parentFlags} < ${messageBuffer}`.env(env)
    : $`git commit-tree ${tree} ${parentFlags} < ${messageBuffer}`.env(env);

  const result = await proc.text();
  return result.trim();
}

export interface MergeTreeSuccess {
  ok: true;
  tree: string;
}

export interface MergeTreeConflict {
  ok: false;
  conflictInfo: string;
}

/**
 * Perform a three-way merge using git merge-tree --write-tree.
 *
 * This computes the merge result without touching the working directory.
 * Requires Git 2.38+.
 *
 * @param base - The merge base (common ancestor)
 * @param ours - "Our" side of the merge (typically the branch being merged into)
 * @param theirs - "Their" side of the merge (typically the commit being cherry-picked)
 * @returns Success with tree SHA, or failure with conflict info
 */
export async function mergeTree(
  base: string,
  ours: string,
  theirs: string,
  options: GitOptions = {},
): Promise<MergeTreeSuccess | MergeTreeConflict> {
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} merge-tree --write-tree --merge-base=${base} ${ours} ${theirs}`
        .nothrow()
        .quiet()
    : await $`git merge-tree --write-tree --merge-base=${base} ${ours} ${theirs}`.nothrow().quiet();

  if (result.exitCode !== 0) {
    return {
      ok: false,
      conflictInfo: result.stdout.toString() + result.stderr.toString(),
    };
  }

  // Success: first line is the tree SHA
  const output = result.stdout.toString().trim();
  const tree = asserted(output.split("\n")[0]);

  return { ok: true, tree };
}

/**
 * Update a git ref atomically.
 *
 * @param ref - The ref to update (e.g., "refs/heads/main")
 * @param newSha - The new SHA to point to
 * @param oldSha - Optional: expected current SHA (for compare-and-swap)
 */
export async function updateRef(
  ref: string,
  newSha: string,
  oldSha?: string,
  options: GitOptions = {},
): Promise<void> {
  const { cwd } = options;

  if (oldSha) {
    // Compare-and-swap: only update if current value matches oldSha
    if (cwd) {
      await $`git -C ${cwd} update-ref ${ref} ${newSha} ${oldSha}`;
    } else {
      await $`git update-ref ${ref} ${newSha} ${oldSha}`;
    }
  } else {
    // Unconditional update
    if (cwd) {
      await $`git -C ${cwd} update-ref ${ref} ${newSha}`;
    } else {
      await $`git update-ref ${ref} ${newSha}`;
    }
  }
}

/**
 * Reset the working directory to match a commit's tree.
 *
 * This is the only operation that touches the working directory.
 * Should only be called when the tree has actually changed.
 */
export async function resetToCommit(commit: string, options: GitOptions = {}): Promise<void> {
  const { cwd } = options;

  if (cwd) {
    await $`git -C ${cwd} reset --hard ${commit}`.quiet();
  } else {
    await $`git reset --hard ${commit}`.quiet();
  }
}

/**
 * Get the short SHA of a commit (for display purposes).
 */
export async function getShortSha(commit: string, options: GitOptions = {}): Promise<string> {
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} rev-parse --short ${commit}`.text()
    : await $`git rev-parse --short ${commit}`.text();

  return result.trim();
}

/**
 * Get the full SHA of a commit.
 */
export async function getFullSha(commit: string, options: GitOptions = {}): Promise<string> {
  const { cwd } = options;

  const result = cwd
    ? await $`git -C ${cwd} rev-parse ${commit}`.text()
    : await $`git rev-parse ${commit}`.text();

  return result.trim();
}

// ============================================================================
// Higher-level operations
// ============================================================================

/**
 * Rewrite a single commit's message without touching the working directory.
 *
 * This preserves:
 * - The tree (file contents) - unchanged
 * - The parent(s) - unchanged
 * - Author info (name, email, date) - unchanged
 * - Committer info (name, email, date) - unchanged (message-only = no timestamp update)
 *
 * @param commit - The commit to rewrite
 * @param newMessage - The new commit message
 * @returns SHA of the new commit
 */
export async function rewriteCommitMessage(
  commit: string,
  newMessage: string,
  options: GitOptions = {},
): Promise<string> {
  // Get everything we need from the original commit
  const tree = await getTree(commit, options);
  const parents = await getParents(commit, options);
  const env = await getAuthorAndCommitterEnv(commit, options);

  // Create new commit with same tree/parents but new message
  return createCommit(tree, parents, newMessage, env, options);
}

/**
 * Specification for rewriting a commit in a chain.
 */
export interface CommitRewrite {
  /** Original commit hash */
  originalHash: string;
  /** New message for this commit (undefined = keep original) */
  newMessage?: string;
}

/**
 * Result of a commit chain rewrite operation.
 */
export interface ChainRewriteResult {
  /** New tip SHA after the rewrite */
  newTip: string;
  /** Mapping from old commit SHAs to new commit SHAs */
  mapping: Map<string, string>;
}

/**
 * Rewrite a chain of commits with new messages.
 *
 * This is used for operations like:
 * - Adding Spry-Commit-Id trailers to commits missing them
 * - Adding/removing Spry-Group trailers
 * - Any other message-only modifications
 *
 * The algorithm:
 * 1. Find the base commit (parent of the first commit in the chain)
 * 2. For each commit from oldest to newest:
 *    - If commit needs rewriting: use new message
 *    - Else: preserve original message
 *    - Create new commit with updated parent chain
 * 3. Return the new tip SHA
 *
 * @param commits - Array of commits in oldest-to-newest order
 * @param rewrites - Map of original hash -> new message (commits not in map keep original message)
 * @returns New tip SHA after the rewrite
 */
export async function rewriteCommitChain(
  commits: string[],
  rewrites: Map<string, string>,
  options: GitOptions = {},
): Promise<ChainRewriteResult> {
  if (commits.length === 0) {
    throw new Error("Cannot rewrite empty commit chain");
  }

  // Build the new chain
  const mapping = new Map<string, string>();

  // Get the base (parent of first commit)
  const firstCommit = asserted(commits[0]);
  let currentParent = await getParent(firstCommit, options);

  for (const originalHash of commits) {
    const tree = await getTree(originalHash, options);
    const env = await getAuthorAndCommitterEnv(originalHash, options);

    // Use new message if provided, otherwise keep original
    const newMessage =
      rewrites.get(originalHash) ?? (await getCommitMessage(originalHash, options));

    // Create new commit with updated parent
    const newHash = await createCommit(tree, [currentParent], newMessage, env, options);

    mapping.set(originalHash, newHash);
    currentParent = newHash;
  }

  return {
    newTip: currentParent,
    mapping,
  };
}

/**
 * Result of a plumbing rebase operation.
 */
export interface PlumbingRebaseSuccess {
  ok: true;
  /** New tip SHA after the rebase */
  newTip: string;
  /** Mapping from old commit SHAs to new commit SHAs */
  mapping: Map<string, string>;
}

export interface PlumbingRebaseConflict {
  ok: false;
  /** The commit that caused the conflict */
  conflictCommit: string;
  /** Information about the conflict */
  conflictInfo: string;
}

export type PlumbingRebaseResult = PlumbingRebaseSuccess | PlumbingRebaseConflict;

/**
 * Rebase commits onto a new base using git merge-tree.
 *
 * This is the equivalent of `git rebase --onto <onto> <upstream>` but performed
 * entirely using plumbing commands without touching the working directory.
 *
 * The algorithm for each commit:
 * 1. Get the commit's original parent
 * 2. Three-way merge: base=original_parent, ours=current_tip, theirs=commit
 * 3. Create new commit with the merged tree
 * 4. Move to next commit
 *
 * On conflict: Returns immediately with conflict info. Nothing is modified.
 * On success: Returns new tip SHA. Caller must finalize with updateRef + optional reset.
 *
 * @param onto - The commit to rebase onto
 * @param commits - Commits to replay (oldest first)
 * @returns Success with new tip, or conflict info
 */
export async function rebasePlumbing(
  onto: string,
  commits: string[],
  options: GitOptions = {},
): Promise<PlumbingRebaseResult> {
  if (commits.length === 0) {
    return { ok: true, newTip: onto, mapping: new Map() };
  }

  const mapping = new Map<string, string>();
  let currentTip = onto;

  for (const commit of commits) {
    // Get the original parent of this commit
    const originalParent = await getParent(commit, options);

    // Three-way merge:
    // - base: original parent (the context the commit was made against)
    // - ours: current tip (what we're building on)
    // - theirs: the commit we're cherry-picking
    const mergeResult = await mergeTree(originalParent, currentTip, commit, options);

    if (!mergeResult.ok) {
      return {
        ok: false,
        conflictCommit: commit,
        conflictInfo: mergeResult.conflictInfo,
      };
    }

    // Get the original commit's message and author info
    // For rebase, we preserve author but update committer (standard git behavior)
    const message = await getCommitMessage(commit, options);
    const env = await getAuthorEnv(commit, options);

    // Create the new commit
    const newHash = await createCommit(mergeResult.tree, [currentTip], message, env, options);

    mapping.set(commit, newHash);
    currentTip = newHash;
  }

  return { ok: true, newTip: currentTip, mapping };
}

/**
 * Finalize a plumbing rewrite operation.
 *
 * This updates the branch ref and optionally resets the working directory.
 * The key optimization: if the tree hasn't changed (message-only changes),
 * no reset is needed at all.
 *
 * @param branch - Branch name (without refs/heads/)
 * @param oldTip - Expected current tip (for compare-and-swap safety)
 * @param newTip - New tip to set
 */
export async function finalizeRewrite(
  branch: string,
  oldTip: string,
  newTip: string,
  options: GitOptions = {},
): Promise<void> {
  const oldTree = await getTree(oldTip, options);
  const newTree = await getTree(newTip, options);

  // Update branch ref atomically with compare-and-swap
  await updateRef(`refs/heads/${branch}`, newTip, oldTip, options);

  // Only reset working directory if tree changed
  // This is the key optimization: message-only changes don't need a reset
  if (oldTree !== newTree) {
    await resetToCommit(newTip, options);
  }
}
