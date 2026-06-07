import kleur from "kleur";
import type { SpryContext } from "../lib/context.ts";
import {
  loadConfig,
  trunkRef,
  getCurrentBranch,
  getStackCommits,
  injectMissingIds,
  requireCleanWorkingTree,
  saveAllGroupRecords,
  fetchGroupRecords,
  loadGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
  rewriteCommitChain,
  finalizeRewrite,
  branchForUnit,
  getMergeBase,
} from "../git/index.ts";
import { parseCommitTrailers, parseStack } from "../parse/index.ts";
import { findPRsForBranches, classifyGhInfraError } from "../gh/index.ts";
import type { PRInfo } from "../gh/index.ts";
import { runGroupEditor } from "../tui/group-editor.ts";
import { selectUnits } from "../tui/index.ts";
import type { PRUnit } from "../parse/types.ts";
import type { GroupRecords } from "../parse/types.ts";
import type { SpryConfig } from "../git/config.ts";

export interface GroupOptions {
  cwd?: string;
}

export async function groupCommand(ctx: SpryContext, opts: GroupOptions = {}): Promise<void> {
  const cwd = opts.cwd;
  const config = await loadConfig(ctx.git, { cwd });
  const branch = await getCurrentBranch(ctx.git, { cwd });
  const ref = trunkRef(config);

  // Inject missing IDs so all commits are groupable
  const inject = await injectMissingIds(ctx.git, ref, { cwd });
  if (!inject.ok) {
    console.error("✗ Cannot run from a detached HEAD. Check out a branch and try again.");
    process.exit(1);
  }

  await requireCleanWorkingTree(ctx.git, { cwd });

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
      prsByBranch = await findPRsForBranches(ctx, branches);
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

  // Reorder commits if the stack order changed
  if (result.newOrder) {
    const oldTip = withTrailers.at(-1)?.hash;
    if (!oldTip) throw new Error("groupCommand: unexpected empty commit list");
    const mergeBase = await getMergeBase(ctx.git, ref, { cwd });
    const rewriteResult = await rewriteCommitChain(ctx.git, result.newOrder, new Map(), {
      cwd,
      base: mergeBase,
    });
    await finalizeRewrite(ctx.git, branch, oldTip, rewriteResult.newTip, { cwd });
    console.log(`✓ Reordered ${result.newOrder.length} commits`);
  }

  // Write all group records atomically
  await saveAllGroupRecords(ctx.git, resolvedRecords, { cwd });

  // Push refs/spry/groups best-effort
  const pushResult = await ctx.git.run(
    ["push", config.remote, "refs/spry/groups:refs/spry/groups"],
    { cwd },
  );
  if (pushResult.exitCode !== 0) {
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
