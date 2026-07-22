// src/parse/apply-doc.ts
//
// Pure schema validation and reconciliation for `sp group --apply` documents.
// No git, no IO — `parseApplyDoc` takes a JSON string and returns a parsed,
// validated document or an error; `reconcile` takes that document plus a
// snapshot of live state and produces a plan or a typed error.

import type { GroupRecords } from "./types.ts";
import { generateCommitId } from "./id.ts";

export interface ParsedCommit {
  kind: "commit";
  id: string;
  reissueId: boolean;
  pr?: "CLOSE" | "ADOPT";
}
export interface ParsedGroup {
  kind: "group";
  id: string | null;
  reissueId: boolean;
  pr?: "CLOSE" | "ADOPT";
  titleField: { set: false } | { set: true; value: string | null };
  members: ParsedCommit[];
}
export type ParsedNode = ParsedCommit | ParsedGroup;
export interface ParsedDoc {
  stack: ParsedNode[];
}
export type ParseResult = { ok: true; doc: ParsedDoc } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type PrParseResult = { ok: true; pr: "CLOSE" | "ADOPT" | undefined } | { ok: false; error: string };

function parsePr(raw: Record<string, unknown>, where: string): PrParseResult {
  if (!("pr" in raw)) return { ok: true, pr: undefined };
  const pr = raw.pr;
  if (pr === "CLOSE" || pr === "ADOPT") return { ok: true, pr };
  return { ok: false, error: `Invalid pr directive on ${where}: expected "CLOSE" or "ADOPT"` };
}

function parseCommit(raw: unknown, where: string): ParsedCommit | string {
  if (!isObj(raw)) return `${where}: expected an object`;
  if (raw.type !== "commit") return `${where}: expected type "commit"`;
  if ("sha" in raw) return `${where}: "sha" is not an input field`;
  if (!("id" in raw)) return `${where}: missing required "id" (omission is not null)`;
  if (raw.id === null)
    return `${where}: commit id may not be null (only a new group may use id:null)`;
  if (typeof raw.id !== "string") return `${where}: "id" must be a string`;
  if ("reissueId" in raw && typeof raw.reissueId !== "boolean")
    return `${where}: "reissueId" must be a boolean`;
  const reissueId = "reissueId" in raw ? raw.reissueId === true : false;
  const prResult = parsePr(raw, where);
  if (!prResult.ok) return prResult.error;
  return { kind: "commit", id: raw.id, reissueId, ...(prResult.pr ? { pr: prResult.pr } : {}) };
}

function parseGroup(raw: Record<string, unknown>, where: string): ParsedGroup | string {
  if ("sha" in raw) return `${where}: "sha" is not an input field`;
  if (!("id" in raw)) return `${where}: missing required "id" (use null to mint a new group)`;
  const id = raw.id;
  if (id !== null && typeof id !== "string") return `${where}: group "id" must be a string or null`;
  if ("reissueId" in raw && typeof raw.reissueId !== "boolean")
    return `${where}: "reissueId" must be a boolean`;
  const reissueId = "reissueId" in raw ? raw.reissueId === true : false;
  if (reissueId && id === null)
    return `${where}: reissueId:true cannot combine with id:null (contradiction)`;

  // title tri-state via key presence (PUT/PATCH "omission != null" rule):
  //   key absent           -> { set: false }              (leave title untouched)
  //   key present, null|"" -> { set: true, value: null }   (wipe title)
  //   key present, string  -> { set: true, value: string } (set title)
  let titleField: ParsedGroup["titleField"];
  if (!("title" in raw)) {
    titleField = { set: false };
  } else if (raw.title === null || raw.title === "") {
    titleField = { set: true, value: null };
  } else if (typeof raw.title === "string") {
    titleField = { set: true, value: raw.title };
  } else {
    return `${where}: "title" must be a string, null, or omitted`;
  }

  if (!("commits" in raw)) return `${where}: group missing required "commits"`;
  if (!Array.isArray(raw.commits)) return `${where}: "commits" must be an array`;
  if (raw.commits.length === 0) return `${where}: group has no members (empty group)`;
  const members: ParsedCommit[] = [];
  for (let i = 0; i < raw.commits.length; i++) {
    const m = parseCommit(raw.commits[i], `${where}.commits[${i}]`);
    if (typeof m === "string") return m;
    members.push(m);
  }
  const prResult = parsePr(raw, where);
  if (!prResult.ok) return prResult.error;
  return {
    kind: "group",
    id,
    reissueId,
    titleField,
    members,
    ...(prResult.pr ? { pr: prResult.pr } : {}),
  };
}

export function parseApplyDoc(json: string): ParseResult {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (!isObj(root) || !Array.isArray(root.stack))
    return { ok: false, error: `Document must be an object with a "stack" array` };

  const stack: ParsedNode[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < root.stack.length; i++) {
    const raw = root.stack[i];
    if (!isObj(raw)) return { ok: false, error: `stack[${i}]: expected an object` };
    let node: ParsedNode | string;
    if (raw.type === "commit") node = parseCommit(raw, `stack[${i}]`);
    else if (raw.type === "group") node = parseGroup(raw, `stack[${i}]`);
    else
      return {
        ok: false,
        error: `stack[${i}]: missing or unknown "type" (expected "commit" or "group")`,
      };
    if (typeof node === "string") return { ok: false, error: node };

    // duplicate-id detection across all commit ids (top-level + members)
    const ids = node.kind === "commit" ? [node.id] : node.members.map((m) => m.id);
    for (const id of ids) {
      if (seenIds.has(id)) return { ok: false, error: `Duplicate commit id: ${id}` };
      seenIds.add(id);
    }
    stack.push(node);
  }
  return { ok: true, doc: { stack } };
}

export interface ReconcilePlan {
  records: GroupRecords;
  reissueIds: string[];
  newOrder: string[] | null;
  prCloses: string[];
  prAdopts: string[];
}
export type ReconcileResult = { ok: true; plan: ReconcilePlan } | { ok: false; error: string };

export interface LiveState {
  liveIds: string[];
  liveHashById: Record<string, string>;
  liveGroups: GroupRecords;
  openPrIds: Set<string>;
}

export function reconcile(doc: ParsedDoc, live: LiveState): ReconcileResult {
  const liveSet = new Set(live.liveIds);

  // Flatten doc into ordered member ids + collect nodes.
  const docOrder: string[] = [];
  const docIds = new Set<string>();
  for (const node of doc.stack) {
    const ids = node.kind === "commit" ? [node.id] : node.members.map((m) => m.id);
    for (const id of ids) {
      docOrder.push(id);
      docIds.add(id);
    }
  }

  // Unknown id: any doc id not live.
  for (const id of docOrder) {
    if (!liveSet.has(id)) return { ok: false, error: `Unknown id (not in live stack): ${id}` };
  }
  // Missing id: any live id the doc omits (strict completeness).
  const missing = live.liveIds.filter((id) => !docIds.has(id));
  if (missing.length > 0)
    return { ok: false, error: `Doc does not account for live commit(s): ${missing.join(", ")}` };

  const records: GroupRecords = {};
  const reissueIds: string[] = [];
  const prCloses: string[] = [];
  const prAdopts: string[] = [];

  // Per-node validation + record building.
  for (const node of doc.stack) {
    if (node.kind === "commit") {
      handleReissueAndClose(node, live, reissueIds, prCloses);
      const err = checkPr(node, live);
      if (err) return { ok: false, error: err };
      continue;
    }

    // group
    const memberIds = node.members.map((m) => m.id);

    // member-level reissue/close directives (directives attach to identity, incl. nested).
    // v1: reissuing a GROUPED member is forbidden — the trailer rewrite would mint a new
    // id that the group record's member list (built from old ids) can't track. Ungroup,
    // reissue, then regroup across separate applies if truly needed.
    for (const m of node.members) {
      if (m.reissueId) {
        return {
          ok: false,
          error: `Cannot reissue ${m.id}: it is a member of a group. Ungroup it first (reissuing a grouped member is not supported).`,
        };
      }
      const err = checkPr(m, live);
      if (err) return { ok: false, error: err };
    }

    // resolve group id + adoption
    //
    // A group id can be legitimate in three ways:
    //   1. id:null            -> a brand-new group; mint a fresh id.
    //   2. id in liveGroups   -> an EXISTING group (its id may be a minted
    //                            non-member id from a prior `id:null` create,
    //                            OR a member id it adopted earlier). Editing an
    //                            existing group is always allowed regardless of
    //                            membership — this is the steady-state edit path.
    //   3. id is a live commit id that is one of this group's own members
    //                          -> a NEW adoption of that member's identity/PR.
    // Anything else (a real id that is neither an existing group nor a member)
    // is a foreign-identity error.
    let groupId: string;
    if (node.id === null) {
      // new group, fresh mint. pr must not be ADOPT (nothing to adopt).
      if (node.pr === "ADOPT")
        return { ok: false, error: `New group (id:null) cannot pr:ADOPT — it inherits no PR` };
      groupId = generateCommitId();
    } else if (node.id in live.liveGroups) {
      // (2) existing group — steady-state edit. Identity already held; no
      // adoption transition occurs, so pr:ADOPT is forbidden here.
      groupId = node.id;
      if (node.pr === "ADOPT")
        return { ok: false, error: `Group ${node.id} already holds its PR; remove pr:ADOPT` };
    } else if (memberIds.includes(node.id)) {
      // (3) new adoption of a member's identity. Requires an actual open PR to
      // adopt AND explicit pr:ADOPT acknowledgment (adoption transition).
      groupId = node.id;
      if (!live.openPrIds.has(node.id))
        return { ok: false, error: `Group id ${node.id} has no open PR to adopt` };
      if (node.pr !== "ADOPT")
        return {
          ok: false,
          error: `Group adopts PR of ${node.id}; add "pr":"ADOPT" to acknowledge`,
        };
      prAdopts.push(groupId);
    } else {
      // real id that is neither an existing group nor one of its own members.
      return {
        ok: false,
        error: `Group id ${node.id} is not a member of its own group (foreign identity)`,
      };
    }

    // group reissue
    if (node.reissueId) {
      // reissuing the group's identity closes its PR (if held) — needs pr:CLOSE.
      if (live.openPrIds.has(groupId) && node.pr !== "CLOSE")
        return { ok: false, error: `Reissuing group ${groupId} closes its PR; add "pr":"CLOSE"` };
      reissueIds.push(groupId);
      if (live.openPrIds.has(groupId)) prCloses.push(groupId);
    }

    // title tri-state
    let title: string;
    if (node.titleField.set) {
      title = node.titleField.value ?? "";
    } else {
      title = live.liveGroups[node.id ?? ""]?.title ?? "";
    }

    records[groupId] = { title, members: memberIds };
  }

  // Build newOrder if the flattened order differs from live.
  const sameOrder =
    docOrder.length === live.liveIds.length && docOrder.every((id, i) => id === live.liveIds[i]);
  const newOrder = sameOrder ? null : docOrder.map((id) => live.liveHashById[id] ?? id);

  // v1: reissuing ids and reordering commits cannot happen in the same apply.
  // A reissue rewrites commit hashes via a trailer change, which would make
  // newOrder's captured (pre-reissue) hashes stale. Keep the two rewrites in
  // separate applies so the command layer only ever runs one of them.
  if (reissueIds.length > 0 && newOrder !== null) {
    return {
      ok: false,
      error: `An apply cannot both reissue ids and reorder commits in one pass; do them in separate applies`,
    };
  }

  return { ok: true, plan: { records, reissueIds, newOrder, prCloses, prAdopts } };
}

function handleReissueAndClose(
  node: ParsedCommit,
  live: LiveState,
  reissueIds: string[],
  prCloses: string[],
): void {
  if (node.reissueId) {
    reissueIds.push(node.id);
    if (live.openPrIds.has(node.id) && node.pr === "CLOSE") prCloses.push(node.id);
  }
}

// Validate a unit's pr directive against whether a transition actually occurs.
function checkPr(node: ParsedCommit, live: LiveState): string | null {
  const hasOpen = live.openPrIds.has(node.id);
  if (node.pr === "CLOSE") {
    // CLOSE is only valid if this apply would close an open PR: i.e. reissue of a unit with an open PR.
    const wouldClose = node.reissueId && hasOpen;
    if (!wouldClose) return `pr:"CLOSE" on ${node.id} but nothing would close`;
  }
  if (node.reissueId && hasOpen && node.pr !== "CLOSE") {
    return `Reissuing ${node.id} closes its open PR; add "pr":"CLOSE"`;
  }
  // ADOPT is not valid on a commit unit.
  if (node.pr === "ADOPT") return `pr:"ADOPT" is only valid on a group that adopts a member's PR`;
  return null;
}
