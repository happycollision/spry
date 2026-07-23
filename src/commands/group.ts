import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import {
  loadConfig,
  trunkRef,
  getCurrentBranch,
  getStackCommits,
  injectMissingIds,
  getWorkingTreeStatus,
  saveAllGroupRecords,
  pushGroupRecords,
  fetchGroupRecords,
  loadGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
  rebasePlumbing,
  finalizeRewrite,
  branchForUnit,
  getMergeBase,
  registerBranch,
  getCommitMessage,
  rewriteCommitChain,
} from "../git/index.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { findPRsForBranches, classifyGhInfraError } from "../gh/index.ts";
import type { PRInfo } from "../gh/index.ts";
import { runGroupEditor } from "../tui/group-editor.ts";
import { selectUnits } from "../tui/index.ts";
import type { PRUnit } from "../parse/types.ts";
import type { GroupRecords } from "../parse/types.ts";
import type { SpryConfig } from "../git/config.ts";
import { parseApplyDoc, reconcile } from "../parse/apply-doc.ts";
import { loadPRCache, savePRCache } from "../gh/pr-cache.ts";
import { replaceCommitId } from "../parse/trailers.ts";
import { generateCommitId } from "../parse/id.ts";
import { readStdin } from "../lib/read-stdin.ts";

export interface GroupOptions {
  cwd?: string;
  apply?: string; // JSON string, or "-" to read stdin
  readStdin?: () => Promise<string>; // test seam; defaults to the real readStdin
}

export async function groupCommand(ctx: SpryContext, opts: GroupOptions = {}): Promise<void> {
  const cwd = opts.cwd;

  if (opts.apply !== undefined) {
    return applyGroupDoc(ctx, opts, cwd);
  }

  const config = await loadConfig(ctx.git, { cwd });
  const branch = await getCurrentBranch(ctx.git, { cwd });
  const ref = trunkRef(config);

  // Inject missing IDs so all commits are groupable
  const inject = await injectMissingIds(ctx.git, ref, { cwd });
  if (!inject.ok) {
    console.error("✗ Cannot run from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }

  const workingTreeStatus = await getWorkingTreeStatus(ctx.git, { cwd });

  await registerBranch(ctx.git, branch, { cwd });

  const commits = await getStackCommits(ctx.git, ref, { cwd });
  if (commits.length === 0) {
    console.log("No commits in stack.");
    return;
  }

  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });

  // Fetch + load group records
  const fetchResult = await fetchGroupRecords(ctx.git, config.remote, { cwd });
  if (!fetchResult.ok) {
    console.log(kleur.dim(`⚠ Could not fetch group records: ${fetchResult.warning}`));
  }
  const groupRecords = await loadGroupRecords(ctx.git, { cwd });
  const groupTitles = extractGroupTitles(groupRecords);
  const commitGroups = buildCommitGroupMap(groupRecords);

  // Build units for PR adoption detection (proceed even if stack has errors)
  const stackResult = parseStack(withTrailers, groupTitles, commitGroups);
  const units: PRUnit[] = stackResult.ok ? stackResult.units : [];

  // Fetch existing PRs (best-effort for adoption prompt)
  let prsByBranch = new Map<string, PRInfo | null>();
  if (units.length > 0) {
    try {
      const branches = units.map((u) => branchForUnit(u, config));
      prsByBranch = await findPRsForBranches(ctx, branches, {
        owner: config.owner,
        repo: config.repo,
      });
    } catch (err) {
      const kind = classifyGhInfraError(err);
      if (kind === "no-gh") {
        console.log(kleur.dim("PR adoption unavailable: gh not installed"));
      } else if (kind === "auth") {
        console.log(kleur.dim("PR adoption unavailable: gh not authenticated"));
      }
      // network/no-remote errors are silently ignored (best-effort)
    }
  }

  // Launch TUI
  const result = await runGroupEditor(ctx.git, withTrailers, groupRecords, {
    branch,
    trunkRef: ref,
    cwd,
    canReorder: !workingTreeStatus.isDirty,
  });

  if (result.cancelled) {
    console.log("Cancelled.");
    return;
  }

  // Resolve PR adoption for newly-created groups
  const resolvedRecords = await adoptPRs(
    result.updatedRecords,
    groupRecords,
    units,
    prsByBranch,
    config,
  );

  // Reorder commits if the stack order changed (diff-replay; bail on conflict)
  if (result.newOrder) {
    const oldTip = withTrailers.at(-1)?.hash;
    if (!oldTip) throw new Error("groupCommand: unexpected empty commit list");
    const mergeBase = await getMergeBase(ctx.git, ref, { cwd });
    const rebaseResult = await rebasePlumbing(ctx.git, mergeBase, result.newOrder, { cwd });
    if (!rebaseResult.ok) {
      console.error(
        `✗ Cannot reorder: commit ${rebaseResult.conflictCommit.slice(0, 8)} conflicts.\n${rebaseResult.conflictInfo}`,
      );
      process.exit(1);
    }
    await finalizeRewrite(ctx.git, branch, oldTip, rebaseResult.newTip, { cwd });
    console.log(`✓ Reordered ${result.newOrder.length} commits`);
  }

  // Write all group records atomically
  await saveAllGroupRecords(ctx.git, resolvedRecords, { cwd });

  // Push refs/spry/groups best-effort
  const pushResult = await pushGroupRecords(ctx.git, config.remote, { cwd });
  if (!pushResult.ok) {
    console.log(kleur.dim("⚠ Could not push group records to remote (local changes saved)"));
  }

  const groupCount = Object.keys(resolvedRecords).length;
  console.log(`✓ Groups updated (${groupCount} group${groupCount === 1 ? "" : "s"})`);
}

async function adoptPRs(
  updatedRecords: GroupRecords,
  originalRecords: GroupRecords,
  units: PRUnit[],
  prsByBranch: Map<string, PRInfo | null>,
  config: SpryConfig,
): Promise<GroupRecords> {
  const originalIds = new Set(Object.keys(originalRecords));
  const result: GroupRecords = {};

  for (const [groupId, record] of Object.entries(updatedRecords)) {
    if (originalIds.has(groupId)) {
      // Existing group — keep as-is
      result[groupId] = record;
      continue;
    }

    // New group — check if any member commits had open PRs
    const memberUnits = units.filter((u) => u.type === "single" && record.members.includes(u.id));
    const openPRUnits = memberUnits.filter((u) => {
      const br = branchForUnit(u, config);
      const pr = prsByBranch.get(br);
      return pr?.state === "OPEN";
    });

    if (openPRUnits.length === 0) {
      result[groupId] = record;
    } else if (openPRUnits.length === 1) {
      const adopted = openPRUnits[0];
      if (adopted) {
        console.log(kleur.dim(`↻ adopted PR for group (unit ${adopted.id.slice(0, 8)})`));
        result[adopted.id] = record;
      } else {
        result[groupId] = record;
      }
    } else {
      // Multiple open PRs — prompt user to pick one
      const options = openPRUnits.map((u) => ({
        id: u.id,
        label: `PR for ${u.id.slice(0, 8)}: ${u.title ?? "(untitled)"}`,
      }));
      const selection = await selectUnits(options, {
        title: "Multiple commits in this group have open PRs. Which PR should the group adopt?",
      });
      if (!selection.cancelled && selection.selectedIds.length > 0) {
        const adoptedId = selection.selectedIds[0];
        if (adoptedId) {
          console.log(kleur.dim(`↻ adopted PR for group (unit ${adoptedId.slice(0, 8)})`));
          result[adoptedId] = record;
        } else {
          result[groupId] = record;
        }
      } else {
        result[groupId] = record;
      }
    }
  }

  return result;
}

// Non-interactive `sp group --apply`. Reads a grouping doc (JSON string, or
// "-" for stdin), validates + reconciles it against live state, and applies
// the resulting plan. Fully offline: open-PR ids come only from the local
// `refs/spry/prs` cache, never from `gh` — the interactive path above is the
// one that talks to GitHub.
async function applyGroupDoc(
  ctx: SpryContext,
  opts: GroupOptions,
  cwd: string | undefined,
): Promise<void> {
  const config = await loadConfig(ctx.git, { cwd });
  const branch = await getCurrentBranch(ctx.git, { cwd });
  const ref = trunkRef(config);

  // Read the JSON (string arg, or "-" for stdin).
  const readStdinFn = opts.readStdin ?? readStdin;
  const json = opts.apply === "-" ? await readStdinFn() : (opts.apply ?? "");

  const parsed = parseApplyDoc(json);
  if (!parsed.ok) {
    console.error(`✗ ${parsed.error}`);
    process.exit(1);
  }

  // Ensure every live commit has an id (so ids are stable handles).
  const inject = await injectMissingIds(ctx.git, ref, { cwd });
  if (!inject.ok) {
    console.error("✗ Cannot run from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }
  await registerBranch(ctx.git, branch, { cwd });

  // Snapshot live state.
  const commits = await getStackCommits(ctx.git, ref, { cwd });
  const withTrailers = await parseCommitTrailers(commits, ctx.git, { cwd });
  const liveIds: string[] = [];
  const liveHashById: Record<string, string> = {};
  for (const c of withTrailers) {
    const id = c.trailers["Spry-Commit-Id"];
    if (!id) {
      console.error(`✗ Commit ${c.hash.slice(0, 8)} has no Spry-Commit-Id after inject; aborting.`);
      process.exit(1);
    }
    liveIds.push(id);
    liveHashById[id] = c.hash;
  }

  const liveGroups = await loadGroupRecords(ctx.git, { cwd });

  // Open-PR ids strictly from the local cache (offline; no gh).
  const prCache = await loadPRCache(ctx.git, { cwd });
  const openPrIds = new Set<string>();
  for (const [unitId, entry] of Object.entries(prCache)) {
    if (entry.state === "OPEN") openPrIds.add(unitId);
  }

  const rec = reconcile(parsed.doc, { liveIds, liveHashById, liveGroups, openPrIds });
  if (!rec.ok) {
    console.error(`✗ ${rec.error}`);
    process.exit(1);
  }
  const plan = rec.plan;

  // `reconcile` guarantees reissueIds and newOrder are never both set, so at
  // most one of the two rewrite branches below runs per apply. Group-identity
  // reissue is rejected by `reconcile` too, so every id in plan.reissueIds is
  // a top-level commit id — safe to treat as a trailer rewrite target here.
  const oldTip = withTrailers.at(-1)?.hash;
  if (!oldTip) throw new Error("applyGroupDoc: empty stack");
  const mergeBase = await getMergeBase(ctx.git, ref, { cwd });

  if (plan.reissueIds.length > 0) {
    // Reissue: rewrite the Spry-Commit-Id trailer on each targeted commit.
    // Message-only rewrite -> identical trees -> finalizeRewrite's reset is a
    // no-op, so this branch needs no working-tree guard (unlike reorder below).
    const reissueSet = new Set(plan.reissueIds);
    const messageRewrites = new Map<string, string>();
    for (const c of withTrailers) {
      const id = c.trailers["Spry-Commit-Id"];
      if (!id || !reissueSet.has(id)) continue;
      const fullMsg = await getCommitMessage(ctx.git, c.hash, { cwd });
      const newId = generateCommitId();
      messageRewrites.set(c.hash, await replaceCommitId(fullMsg, newId, ctx.git));
    }
    const rewritten = await rewriteCommitChain(
      ctx.git,
      withTrailers.map((c) => c.hash),
      messageRewrites,
      { cwd, base: mergeBase },
    );
    await finalizeRewrite(ctx.git, branch, oldTip, rewritten.newTip, { cwd });
    console.log(`✓ Reissued ${plan.reissueIds.length} id(s)`);
  } else if (plan.newOrder) {
    // Reorder: no reissue ran, so plan.newOrder's hashes are still live hashes.
    // A reorder changes the tip tree, so finalizeRewrite's reset is NOT a
    // no-op here — guard against clobbering uncommitted changes.
    const status = await getWorkingTreeStatus(ctx.git, { cwd });
    if (status.isDirty) {
      console.error(
        "✗ Cannot reorder with a dirty working tree. Commit or stash your changes first.",
      );
      process.exit(1);
    }
    const rebaseResult = await rebasePlumbing(ctx.git, mergeBase, plan.newOrder, { cwd });
    if (!rebaseResult.ok) {
      console.error(
        `✗ Cannot reorder: commit ${rebaseResult.conflictCommit.slice(0, 8)} conflicts.\n${rebaseResult.conflictInfo}`,
      );
      process.exit(1);
    }
    await finalizeRewrite(ctx.git, branch, oldTip, rebaseResult.newTip, { cwd });
    console.log(`✓ Reordered ${plan.newOrder.length} commits`);
  }

  // Save group records (full replace).
  await saveAllGroupRecords(ctx.git, plan.records, { cwd });

  // Record PR-close intent locally by marking the cached entry CLOSED. NOTE:
  // no command consumes this as a GitHub close yet — for now it only removes
  // the PR from local "open" tracking. A future sync-side executor will
  // action it. (Adoption needs no cache change: the adopted member's id
  // becomes the group record's own key, which reconcile already set.)
  if (plan.prCloses.length > 0) {
    for (const id of plan.prCloses) {
      const entry = prCache[id];
      if (entry) entry.state = "CLOSED";
    }
    await savePRCache(ctx.git, prCache, { cwd });
  }

  // Push refs/spry/groups best-effort.
  const pushResult = await pushGroupRecords(ctx.git, config.remote, { cwd });
  if (!pushResult.ok) {
    console.log(kleur.dim("⚠ Could not push group records to remote (local changes saved)"));
  }

  const groupCount = Object.keys(plan.records).length;
  console.log(`✓ Applied (${groupCount} group${groupCount === 1 ? "" : "s"})`);
}
