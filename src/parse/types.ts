// src/parse/types.ts

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
  trailers: Record<string, string>;
  // Parent SHAs (from `%P`), populated by the first-parent stack walk. A commit
  // with 2+ parents is a merge commit. Optional so existing constructors/tests
  // that don't care about topology stay valid (absent = unknown / not a merge).
  parents?: string[];
  // For a merge commit: its side-branch member commits, oldest-first (as returned
  // by getMergeMembers). Absent on non-merge commits.
  mergeMembers?: CommitInfo[];
}

export type CommitTrailers = Record<string, string>;

export interface PRUnit {
  type: "single" | "group";
  id: string;
  title: string | undefined;
  commitIds: string[];
  commits: string[];
  subjects: string[];
}

export interface GroupInfo {
  id: string;
  title: string;
  commits: string[];
}

export type GroupTitles = Record<string, string>;

export interface GroupRecord {
  title: string;
  members: string[]; // Spry-Commit-Id values
}

export type GroupRecords = Record<string, GroupRecord>;

// Maps Spry-Commit-Id → group ID — built from GroupRecords, passed to parseStack
export type CommitGroupMap = Record<string, string>;

// A merge group: a contiguous run of commits that materializes as a real merge
// commit in branch history. This is a SEPARATE axis from PR grouping
// (GroupRecord) — a PR unit may contain zero or more merge groups. Stored in
// refs/spry/merge-groups, keyed by merge-group id. The merge commit's subject
// and body live ON the materialized merge commit itself, not here — the record
// only identifies which commits form the merge.
export interface MergeGroupRecord {
  members: string[]; // Spry-Commit-Id values, contiguous, in stack order
}

export type MergeGroupRecords = Record<string, MergeGroupRecord>;

// Maps Spry-Commit-Id → merge-group ID — built from MergeGroupRecords, the merge
// analogue of CommitGroupMap. Passed to parseStack so it can recognize which
// commits belong to a materialized merge.
export type CommitMergeGroupMap = Record<string, string>;

export type StackParseResult =
  | { ok: true; units: PRUnit[] }
  | {
      ok: false;
      error: "split-group";
      group: GroupInfo;
      interruptingCommits: string[];
    };

export type ValidationResult = { ok: true } | { ok: false; error: string };

export type IdentifierResolution =
  | { ok: true; unit: PRUnit }
  | { ok: false; error: "not-found"; identifier: string }
  | { ok: false; error: "ambiguous"; identifier: string; matches: string[] };

export type UpToResolution =
  | { ok: true; unitIds: Set<string> }
  | { ok: false; error: IdentifierResolution };

// --- Nested stack tree (sp view --json output; sp group --apply input) ---

// Output-only PR state object emitted by `view --json`.
export interface PrStateInfo {
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
}

// A commit node. On output all fields are present; on input only `id`
// (real Spry-Commit-Id) is required, `reissueId`/`pr` are optional directives.
export interface StackTreeCommit {
  type: "commit";
  id: string;
  sha?: string; // output only
  subject?: string; // output only
  localAhead?: boolean; // output only
  remoteAhead?: boolean; // output only
  pr?: PrStateInfo | null | "CLOSE" | "ADOPT"; // output: state object|null; input: directive
  reissueId?: boolean; // input only
}

// A group node nesting an ordered array of commit nodes.
export interface StackTreeGroup {
  type: "group";
  id: string | null; // output: real id; input: real id (keep/adopt) or null (mint new group)
  title?: string | null; // output: current title|null; input: tri-state (see spec)
  localAhead?: boolean; // output only
  remoteAhead?: boolean; // output only
  pr?: PrStateInfo | null | "CLOSE" | "ADOPT";
  reissueId?: boolean; // input only
  // May contain plain commits and/or merge nodes (StackTreeGroupChild, declared
  // below — type aliases hoist, so the forward reference is fine).
  commits: StackTreeGroupChild[];
}

// A merge node: a set of commits that materialize as one merge commit. It nests
// its member commits, and may appear at the top level or inside a group's
// `commits` (a merge group is always fully contained within a PR unit). Distinct
// axis from StackTreeGroup (PR grouping) — a merge node is about branch history
// shape, not PR boundaries.
export interface StackTreeMerge {
  type: "merge";
  id: string | null; // output: real merge-group id; input: id (keep) or null (mint)
  sha?: string; // output only: the materialized merge commit's SHA
  subject?: string; // output only: the merge commit's subject
  reissueId?: boolean; // input only
  commits: StackTreeCommit[];
}

export type StackTreeNode = StackTreeCommit | StackTreeGroup | StackTreeMerge;

// A node allowed inside a group's `commits`: a plain commit or a merge node.
export type StackTreeGroupChild = StackTreeCommit | StackTreeMerge;

export interface StackTree {
  stack: StackTreeNode[];
}
