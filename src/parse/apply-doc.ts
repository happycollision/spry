// src/parse/apply-doc.ts
//
// Pure schema validation for `sp group --apply` documents. No git, no IO —
// takes a JSON string and returns a parsed, validated document or an error.

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
