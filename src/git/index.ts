export type { SpryConfig, ConfigOptions } from "./config.ts";
export { trunkRef, checkGitVersion, readConfig, loadConfig } from "./config.ts";

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
  rebaseOntoTrunk,
  getConflictInfo,
  formatConflictError,
} from "./rebase.ts";
