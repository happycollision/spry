export interface CommitInfo {
  hash: string;
  subject: string;
  body: string;
  trailers: Record<string, string>;
}

export interface PRUnit {
  type: "single" | "group";
  id: string;
  title: string;
  commitIds: string[];
  commits: string[];
  subjects: string[];
}

export interface PRStatus {
  checks: "pending" | "passing" | "failing" | "none";
  review: "approved" | "changes_requested" | "review_required" | "none";
  comments: { total: number; resolved: number };
}

export interface EnrichedPRUnit extends PRUnit {
  pr?: {
    number: number;
    url: string;
    state: "OPEN" | "CLOSED" | "MERGED";
    status?: PRStatus;
  };
}

export interface GroupInfo {
  id: string;
  title: string;
  commits: string[];
}

export type StackParseResult =
  | { ok: true; units: PRUnit[] }
  | {
      ok: false;
      error: "split-group";
      /** The group that has non-contiguous commits */
      group: GroupInfo;
      /** Commits that appear between the split parts */
      interruptingCommits: string[];
    };
