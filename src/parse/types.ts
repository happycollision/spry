// src/parse/types.ts

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
  trailers: Record<string, string>;
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
  pr?: PrStateInfo | null | "CLOSE" | "ADOPT"; // output: state object|null; input: directive
  reissueId?: boolean; // input only
}

// A group node nesting an ordered array of commit nodes.
export interface StackTreeGroup {
  type: "group";
  id: string | null; // output: real id; input: real id (keep/adopt) or null (mint new group)
  title?: string | null; // output: current title|null; input: tri-state (see spec)
  pr?: PrStateInfo | null | "CLOSE" | "ADOPT";
  reissueId?: boolean; // input only
  commits: StackTreeCommit[];
}

export type StackTreeNode = StackTreeCommit | StackTreeGroup;

export interface StackTree {
  stack: StackTreeNode[];
}
