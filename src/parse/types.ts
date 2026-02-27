// src/parse/types.ts

export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
  trailers: Record<string, string>;
}

export interface CommitTrailers {
  "Spry-Commit-Id"?: string;
  "Spry-Group"?: string;
  [key: string]: string | undefined;
}

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

/** Type alias — storage/retrieval deferred to Git operations phase */
export type GroupTitles = Record<string, string>;

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
