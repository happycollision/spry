export type { SpryConfig, ConfigOptions } from "./config.ts";
export { trunkRef, checkGitVersion, readConfig, loadConfig } from "./config.ts";

export { branchForUnit } from "./branch.ts";

export type { QueryOptions } from "./queries.ts";
export {
  getCurrentBranch,
  isDetachedHead,
  hasUncommittedChanges,
  getFullSha,
  getShortSha,
  getCommitMessage,
  getMergeBase,
  getStackCommits,
  getStackCommitsForBranch,
} from "./queries.ts";

export type {
  PlumbingOptions,
  MergeTreeResult,
  ChainRewriteResult,
  PlumbingRebaseResult,
} from "./plumbing.ts";
export {
  getTree,
  getParent,
  getParents,
  getAuthorEnv,
  getAuthorAndCommitterEnv,
  createCommit,
  mergeTree,
  updateRef,
  resetToCommit,
  rewriteCommitChain,
  rebasePlumbing,
  finalizeRewrite,
} from "./plumbing.ts";

export type { StatusOptions, WorkingTreeStatus } from "./status.ts";
export { getWorkingTreeStatus, requireCleanWorkingTree } from "./status.ts";

export type { ConflictOptions, ConflictResult } from "./conflict.ts";
export {
  getCommitFiles,
  checkFileOverlap,
  parseConflictOutput,
  simulateMerge,
  predictConflict,
  checkReorderConflicts,
} from "./conflict.ts";

export type { RebaseOptions, InjectIdsResult, RebaseResult, ConflictInfo } from "./rebase.ts";
export {
  injectMissingIds,
  injectMissingIdsForBranch,
  rebaseOntoTrunk,
  getConflictInfo,
  formatConflictError,
} from "./rebase.ts";

export type { BehindOptions, FetchResult } from "./behind.ts";
export { fetchRemote, isStackBehindTrunk, isStackBehindTrunkForBranch } from "./behind.ts";

export {
  loadGroupRecords,
  saveGroupRecord,
  saveAllGroupRecords,
  fetchGroupRecords,
  buildCommitGroupMap,
  extractGroupTitles,
} from "./group-titles.ts";
export type { GroupRecord } from "../parse/types.ts";

export {
  loadTrackedBranches,
  saveTrackedBranches,
  registerBranch,
  TRACKED_BRANCHES_REF,
} from "./tracked-branches.ts";
