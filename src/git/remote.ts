import { $ } from "bun";
import type { PRUnit } from "../types.ts";
import type { BranchNameConfig } from "../github/branches.ts";
import { getBranchName } from "../github/branches.ts";
import type { GitOptions } from "./commands.ts";
import { asserted } from "../utils/assert.ts";

export interface SyncStatus {
  branchName: string;
  localCommit: string;
  remoteCommit: string | null;
  needsUpdate: boolean;
  needsCreate: boolean;
}

/**
 * Get the commit hash of a remote branch.
 * Returns null if the branch doesn't exist on the remote.
 */
export async function getRemoteBranchCommit(
  branchName: string,
  options: GitOptions = {},
): Promise<string | null> {
  const { cwd } = options;
  const cwdArgs = cwd ? ["-C", cwd] : [];

  const result = await $`git ${cwdArgs} rev-parse origin/${branchName}`.nothrow().quiet();

  if (result.exitCode !== 0) {
    return null; // Branch doesn't exist on remote
  }

  return result.stdout.toString().trim();
}

/**
 * Get the sync status for a single PRUnit.
 * Determines if the branch needs to be created, updated, or is already in sync.
 */
export async function getSyncStatus(
  unit: PRUnit,
  config: BranchNameConfig,
  options: GitOptions = {},
): Promise<SyncStatus> {
  const branchName = getBranchName(unit.id, config);
  const localCommit = asserted(unit.commits.at(-1));
  const remoteCommit = await getRemoteBranchCommit(branchName, options);

  return {
    branchName,
    localCommit,
    remoteCommit,
    needsUpdate: remoteCommit !== null && remoteCommit !== localCommit,
    needsCreate: remoteCommit === null,
  };
}

/**
 * Get sync status for all PRUnits in a stack.
 * Returns a map from unit ID to its sync status.
 */
export async function getAllSyncStatuses(
  units: PRUnit[],
  config: BranchNameConfig,
  options: GitOptions = {},
): Promise<Map<string, SyncStatus>> {
  const statuses = new Map<string, SyncStatus>();

  // Fetch remote refs once to ensure we have latest state
  const { cwd } = options;
  const cwdArgs = cwd ? ["-C", cwd] : [];
  await $`git ${cwdArgs} fetch origin`.nothrow().quiet();

  for (const unit of units) {
    const status = await getSyncStatus(unit, config, options);
    statuses.set(unit.id, status);
  }

  return statuses;
}

/**
 * Check if any units need syncing (create or update).
 */
export function hasChanges(statuses: Map<string, SyncStatus>): boolean {
  for (const status of statuses.values()) {
    if (status.needsCreate || status.needsUpdate) {
      return true;
    }
  }
  return false;
}

/**
 * Get summary counts of sync statuses.
 */
export function getSyncSummary(statuses: Map<string, SyncStatus>): {
  toCreate: number;
  toUpdate: number;
  upToDate: number;
} {
  let toCreate = 0;
  let toUpdate = 0;
  let upToDate = 0;

  for (const status of statuses.values()) {
    if (status.needsCreate) {
      toCreate++;
    } else if (status.needsUpdate) {
      toUpdate++;
    } else {
      upToDate++;
    }
  }

  return { toCreate, toUpdate, upToDate };
}
