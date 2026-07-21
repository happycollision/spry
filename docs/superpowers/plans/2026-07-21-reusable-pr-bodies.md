# Reusable PR Bodies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give spry-generated PR bodies a stable structure of spry-owned marked regions interleaved with free-form user regions, so `sp sync` can re-derive and rewrite the spry regions on every sync while preserving everything the user wrote outside the markers.

**Architecture:** Spry owns exactly the `spry:info` comment line plus the bytes _between_ each `begin`/`end` marker pair (`body`, `stack-links`, `footer`). On PR creation, generate the full structure and seed the user region under the body with the repo's PR template (if any). On subsequent syncs, fetch each open PR's body, splice fresh spry content into the existing markers in place (appending any missing sections in canonical order at the end), and push via `gh pr edit --body-file -` only when the spliced body differs byte-for-byte from the existing one.

**Tech Stack:** TypeScript + Bun. `gh` CLI for PR reads/writes (via `ctx.gh.run`). Pure functions for body assembly/splicing (unit tested). Sync integration validated by doc tests + gh cassettes.

---

## Critical constraints (read before starting)

1. **Determinism for cassettes.** Cassette replay matches on `args` and `stdin` (`src/lib/recording-client.ts`). `gh pr edit --body-file -` sends the body on **stdin**, so the generated body MUST be byte-for-byte deterministic across record/replay. **Never put a timestamp, hash, or any nondeterministic value in the PR body.** Recorded PR numbers are normalized to `1001, 1002, ...`; the body embeds `#<num>` in stack-links, which is fine because those get normalized in stdin too.
2. **`git -C` is banned** (see AGENTS.md). Subagents must `cd` into the repo dir and run plain git. Pass this rule to any sub-subagents.
3. **Beads is currently broken** on this machine (nook redirect misconfig). Track plan progress via this committed doc + git commits, NOT `br`. Do not run `br sync`.
4. **Bun, not Node.** `bun test` to run tests. Git is 2.52 (>= 2.40) so NO `:docker` aliases needed.
5. **Best-effort, never abort.** All body fetch/edit failures must warn and flip a `hadFailure` flag, exactly like the existing `retargetMismatched` pass. They must never `process.exit` or throw out of the sync.

## File structure

- **Modify** `src/gh/pr-body.ts` — add `MARKERS`, `BETA_WARNING`, `generateBodyContent`, `generateStackLinks`, `generateFooter`, `buildInitialBody`, `spliceBody`. Keep existing `stripTrailers`, `formatPRTitle`, `formatPRBody` (the latter stays exported for back-compat; sync stops using it).
- **Create** `src/gh/pr-template.ts` — `findPRTemplate(cwd?)`, checks standard repo template locations. Create-time only.
- **Modify** `src/gh/pr.ts` — add `fetchPRBody(ctx, prNumber, opts)` and `updatePRBody(ctx, prNumber, body, opts)`.
- **Modify** `src/gh/index.ts` — re-export the new symbols.
- **Modify** `src/commands/sync.ts` — swap create-time body to `buildInitialBody`; add `updateStackBodies` pass to `syncCommand` and per-stack in `syncAllCommand`.
- **Create** `tests/gh/pr-body-markers.test.ts` — unit tests for marker generation + splicing.
- **Create** `tests/gh/pr-template.test.ts` — unit tests for template discovery.
- **Modify** `tests/commands/sync.doc.test.ts` — doc test proving edit-preservation round-trip (cassette).
- **Modify** `CHANGELOG.md` — record the runtime change before committing.

---

## Task 1: Markers, footer, and body-content generation (pure)

**Files:**

- Modify: `src/gh/pr-body.ts`
- Test: `tests/gh/pr-body-markers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/gh/pr-body-markers.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import {
  MARKERS,
  BETA_WARNING,
  generateBodyContent,
  generateFooter,
} from "../../src/gh/pr-body.ts";
import type { CommitInfo, PRUnit } from "../../src/parse/types.ts";

function commit(hash: string, subject: string, body: string): CommitInfo {
  return { hash, subject, body, trailers: {} };
}
function singleUnit(id: string, hash: string, subject: string): PRUnit {
  return { type: "single", id, title: subject, commitIds: [id], commits: [hash], subjects: [subject] };
}

describe("MARKERS", () => {
  test("info marker matches the spec string exactly", () => {
    expect(MARKERS.INFO).toBe(
      "<!-- spry:info - Your edits outside of spry markers will be preserved on sync. -->",
    );
  });
});

describe("generateBodyContent", () => {
  test("single: drops the subject line and trailers, keeps prose", () => {
    const unit = singleUnit("aaa11111", "abc", "Add login page");
    const commits = [
      commit("abc", "Add login page", "Add login page\n\nImplements OAuth.\n\nSpry-Commit-Id: aaa11111"),
    ];
    expect(generateBodyContent(unit, commits)).toBe("Implements OAuth.");
  });

  test("single: empty when body is only subject + trailers", () => {
    const unit = singleUnit("aaa11111", "abc", "Subject");
    const commits = [commit("abc", "Subject", "Subject\n\nSpry-Commit-Id: aaa11111")];
    expect(generateBodyContent(unit, commits)).toBe("");
  });

  test("group: bulleted list of subjects", () => {
    const groupUnit: PRUnit = {
      type: "group", id: "grp1", title: "G",
      commitIds: ["a", "b"], commits: ["aaa", "bbb"], subjects: ["Add A", "Add B"],
    };
    expect(generateBodyContent(groupUnit, [])).toBe("- Add A\n- Add B");
  });
});

describe("generateFooter", () => {
  test("returns the beta warning", () => {
    expect(generateFooter()).toBe(BETA_WARNING);
    expect(BETA_WARNING).toContain("Do not manually merge stacked PRs.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gh/pr-body-markers.test.ts`
Expected: FAIL — `MARKERS`, `BETA_WARNING`, `generateBodyContent`, `generateFooter` not exported.

- [ ] **Step 3: Implement in `src/gh/pr-body.ts`**

Add near the top (after the existing `import` and `TRAILER_LINE`):

```ts
export const MARKERS = {
  INFO: "<!-- spry:info - Your edits outside of spry markers will be preserved on sync. -->",
  BODY_BEGIN: "<!-- spry:body:begin -->",
  BODY_END: "<!-- spry:body:end -->",
  STACK_LINKS_BEGIN: "<!-- spry:stack-links:begin -->",
  STACK_LINKS_END: "<!-- spry:stack-links:end -->",
  FOOTER_BEGIN: "<!-- spry:footer:begin -->",
  FOOTER_END: "<!-- spry:footer:end -->",
} as const;

export const BETA_WARNING =
  "<sub>Created with [Spry](https://github.com/happycollision/spry) (beta). Do not manually merge stacked PRs.</sub>";
```

Add these functions (keep `formatPRBody` untouched):

```ts
/**
 * Body content for the spry:body region.
 * Single unit: the commit body with its subject line (first line) and trailers
 * removed. Group unit: a bulleted list of the commit subjects.
 */
export function generateBodyContent(unit: PRUnit, commits: CommitInfo[]): string {
  if (unit.type === "single") {
    const commit = commits.find((c) => c.hash === unit.commits[0]);
    if (!commit) return "";
    const withoutSubject = commit.body.split("\n").slice(1).join("\n");
    return stripTrailers(withoutSubject).trim();
  }
  return unit.subjects.map((s) => `- ${s}`).join("\n");
}

export function generateFooter(): string {
  return BETA_WARNING;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gh/pr-body-markers.test.ts`
Expected: PASS (the `generateStackLinks`/`buildInitialBody`/`spliceBody` describe blocks don't exist yet).

- [ ] **Step 5: Commit**

```bash
git add src/gh/pr-body.ts tests/gh/pr-body-markers.test.ts
git commit -m "feat(pr-body): add markers, footer, and body-content generation"
```

---

## Task 2: Stack-links generation (pure, newest-first, descending manual numbers)

**Files:**

- Modify: `src/gh/pr-body.ts`
- Test: `tests/gh/pr-body-markers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/gh/pr-body-markers.test.ts`:

```ts
import { generateStackLinks } from "../../src/gh/pr-body.ts";

describe("generateStackLinks", () => {
  // stackUnitIds are oldest -> newest (same order sp uses internally).
  // prNumbers maps unitId -> PR number for units that HAVE an open PR.
  test("newest-first with descending manual numbers and this-PR marker", () => {
    const stackUnitIds = ["u1", "u2", "u3"]; // oldest -> newest
    const prNumbers = new Map([["u1", 1428], ["u2", 1433], ["u3", 1440]]);
    const out = generateStackLinks(stackUnitIds, prNumbers, "u2", "main");
    expect(out).toBe(
      "**Stack** (newest → oldest, targeting `main`):\n" +
        "3. #1440\n" +
        "2. #1433 ← this PR\n" +
        "1. #1428",
    );
  });

  test("only units with an open PR are listed; numbering counts listed PRs", () => {
    const stackUnitIds = ["u1", "u2", "u3"];
    const prNumbers = new Map([["u1", 1428], ["u3", 1440]]); // u2 has no PR
    const out = generateStackLinks(stackUnitIds, prNumbers, "u3", "main");
    expect(out).toBe(
      "**Stack** (newest → oldest, targeting `main`):\n" +
        "2. #1440 ← this PR\n" +
        "1. #1428",
    );
  });

  test("empty when no unit has a PR", () => {
    expect(generateStackLinks(["u1"], new Map(), "u1", "main")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gh/pr-body-markers.test.ts`
Expected: FAIL — `generateStackLinks` not exported.

- [ ] **Step 3: Implement in `src/gh/pr-body.ts`**

```ts
/**
 * Stack-links block for the spry:stack-links region.
 *
 * @param stackUnitIds unit IDs in stack order, oldest -> newest.
 * @param prNumbers    unitId -> PR number, ONLY for units with an open PR.
 * @param currentUnitId the unit whose PR this body belongs to.
 * @param trunk        the target branch name, shown in the header.
 *
 * Renders newest-at-top with MANUAL descending ordinals (Markdown cannot count
 * down), matching the convention of a popular stacking tool. Only units that
 * have a PR are listed; ordinals count the LISTED PRs, top = count, bottom = 1.
 * Returns "" when no unit has a PR.
 */
export function generateStackLinks(
  stackUnitIds: string[],
  prNumbers: ReadonlyMap<string, number>,
  currentUnitId: string,
  trunk: string,
): string {
  // Oldest -> newest, keeping only units that actually have a PR.
  const listed = stackUnitIds.filter((id) => prNumbers.has(id));
  if (listed.length === 0) return "";

  const lines = [`**Stack** (newest → oldest, targeting \`${trunk}\`):`];
  // Emit newest-first (reverse). Ordinal = position from the bottom, so the
  // newest (top of the printed list) gets the highest number.
  for (let i = listed.length - 1; i >= 0; i--) {
    const id = listed[i]!;
    const ordinal = i + 1;
    const marker = id === currentUnitId ? " ← this PR" : "";
    lines.push(`${ordinal}. #${prNumbers.get(id)!}${marker}`);
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gh/pr-body-markers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gh/pr-body.ts tests/gh/pr-body-markers.test.ts
git commit -m "feat(pr-body): add newest-first stack-links generation"
```

---

## Task 3: `buildInitialBody` (full structure for new PRs)

**Files:**

- Modify: `src/gh/pr-body.ts`
- Test: `tests/gh/pr-body-markers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/gh/pr-body-markers.test.ts`:

```ts
import { buildInitialBody } from "../../src/gh/pr-body.ts";

describe("buildInitialBody", () => {
  const unit = singleUnit("u1", "abc", "Add login page");
  const commits = [commit("abc", "Add login page", "Add login page\n\nImplements OAuth.\n\nSpry-Commit-Id: u1")];

  test("assembles info, body, stack-links, footer in canonical order", () => {
    const body = buildInitialBody({
      unit,
      commits,
      stackLinks: "**Stack** (newest → oldest, targeting `main`):\n1. #1001 ← this PR",
    });
    expect(body).toBe(
      [
        MARKERS.INFO,
        "",
        MARKERS.BODY_BEGIN,
        "Implements OAuth.",
        MARKERS.BODY_END,
        "",
        MARKERS.STACK_LINKS_BEGIN,
        "**Stack** (newest → oldest, targeting `main`):\n1. #1001 ← this PR",
        MARKERS.STACK_LINKS_END,
        "",
        MARKERS.FOOTER_BEGIN,
        BETA_WARNING,
        MARKERS.FOOTER_END,
      ].join("\n"),
    );
  });

  test("seeds the PR template in the user region under the body when provided", () => {
    const body = buildInitialBody({ unit, commits, stackLinks: "", prTemplate: "## Testing\n\n- [ ]" });
    // Template sits between body:end and stack-links (which is omitted when empty).
    expect(body).toContain(`${MARKERS.BODY_END}\n\n## Testing\n\n- [ ]\n`);
    // No empty stack-links markers when there are no links.
    expect(body).not.toContain(MARKERS.STACK_LINKS_BEGIN);
    // Footer still present.
    expect(body).toContain(MARKERS.FOOTER_BEGIN);
  });

  test("omits stack-links markers entirely when stackLinks is empty", () => {
    const body = buildInitialBody({ unit, commits, stackLinks: "" });
    expect(body).not.toContain(MARKERS.STACK_LINKS_BEGIN);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gh/pr-body-markers.test.ts`
Expected: FAIL — `buildInitialBody` not exported.

- [ ] **Step 3: Implement in `src/gh/pr-body.ts`**

```ts
export interface BuildInitialBodyOptions {
  unit: PRUnit;
  commits: CommitInfo[];
  /** Rendered stack-links block (from generateStackLinks); "" to omit. */
  stackLinks: string;
  /** Repo PR template, seeded ONCE into the user region under the body. */
  prTemplate?: string;
}

/**
 * Full PR body for a brand-new PR: info line, spry:body, optional PR template
 * (user region, seeded only here), optional spry:stack-links, spry:footer.
 * Sections with no content (empty stack-links) omit their markers entirely so
 * spliceBody can append them later if they gain content.
 */
export function buildInitialBody(opts: BuildInitialBodyOptions): string {
  const { unit, commits, stackLinks, prTemplate } = opts;
  const parts: string[] = [MARKERS.INFO, ""];

  const bodyContent = generateBodyContent(unit, commits);
  parts.push(MARKERS.BODY_BEGIN);
  if (bodyContent) parts.push(bodyContent);
  parts.push(MARKERS.BODY_END, "");

  if (prTemplate && prTemplate.trim().length > 0) {
    parts.push(prTemplate.trim(), "");
  }

  if (stackLinks) {
    parts.push(MARKERS.STACK_LINKS_BEGIN, stackLinks, MARKERS.STACK_LINKS_END, "");
  }

  parts.push(MARKERS.FOOTER_BEGIN, generateFooter(), MARKERS.FOOTER_END);
  return parts.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gh/pr-body-markers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gh/pr-body.ts tests/gh/pr-body-markers.test.ts
git commit -m "feat(pr-body): add buildInitialBody for new PRs"
```

---

## Task 4: `spliceBody` (in-place rewrite, append missing sections)

**Files:**

- Modify: `src/gh/pr-body.ts`
- Test: `tests/gh/pr-body-markers.test.ts`

This is the core reuse function. Spry owns ONLY the bytes between each begin/end
pair. Everything else (user text before/between/after markers) is preserved
byte-for-byte. Sections whose markers are absent are appended in canonical order.

- [ ] **Step 1: Write the failing test**

Append to `tests/gh/pr-body-markers.test.ts`:

```ts
import { spliceBody } from "../../src/gh/pr-body.ts";

describe("spliceBody", () => {
  const links = "**Stack** (newest → oldest, targeting `main`):\n1. #1001 ← this PR";

  test("replaces content inside each marker pair, preserves everything else verbatim", () => {
    const existing = [
      "User preamble kept.",
      "",
      MARKERS.INFO,
      "",
      MARKERS.BODY_BEGIN,
      "OLD body",
      MARKERS.BODY_END,
      "",
      "User middle text kept exactly.",
      "",
      MARKERS.STACK_LINKS_BEGIN,
      "OLD links",
      MARKERS.STACK_LINKS_END,
      "",
      MARKERS.FOOTER_BEGIN,
      "OLD footer",
      MARKERS.FOOTER_END,
      "",
      "User trailing text kept.",
    ].join("\n");

    const out = spliceBody(existing, { bodyContent: "NEW body", stackLinks: links });

    expect(out).toContain("User preamble kept.");
    expect(out).toContain("User middle text kept exactly.");
    expect(out).toContain("User trailing text kept.");
    expect(out).toContain(`${MARKERS.BODY_BEGIN}\nNEW body\n${MARKERS.BODY_END}`);
    expect(out).toContain(`${MARKERS.STACK_LINKS_BEGIN}\n${links}\n${MARKERS.STACK_LINKS_END}`);
    expect(out).toContain(`${MARKERS.FOOTER_BEGIN}\n${BETA_WARNING}\n${MARKERS.FOOTER_END}`);
    expect(out).not.toContain("OLD body");
    expect(out).not.toContain("OLD links");
    expect(out).not.toContain("OLD footer");
  });

  test("is idempotent: splicing the same content twice yields identical output", () => {
    const existing = [
      MARKERS.INFO, "",
      MARKERS.BODY_BEGIN, "NEW body", MARKERS.BODY_END, "",
      MARKERS.STACK_LINKS_BEGIN, links, MARKERS.STACK_LINKS_END, "",
      MARKERS.FOOTER_BEGIN, BETA_WARNING, MARKERS.FOOTER_END,
    ].join("\n");
    const once = spliceBody(existing, { bodyContent: "NEW body", stackLinks: links });
    const twice = spliceBody(once, { bodyContent: "NEW body", stackLinks: links });
    expect(twice).toBe(once);
    expect(once).toBe(existing);
  });

  test("appends missing sections in canonical order without clobbering user text", () => {
    // A pre-feature PR body: pure user content, no spry markers.
    const existing = "Just my hand-written PR description.\n\n## Testing\n- [x] done";
    const out = spliceBody(existing, { bodyContent: "NEW body", stackLinks: links });

    // Original user text preserved at the top, verbatim.
    expect(out.startsWith("Just my hand-written PR description.\n\n## Testing\n- [x] done")).toBe(true);
    // All spry sections appended, in order: info, body, stack-links, footer.
    const iInfo = out.indexOf(MARKERS.INFO);
    const iBody = out.indexOf(MARKERS.BODY_BEGIN);
    const iLinks = out.indexOf(MARKERS.STACK_LINKS_BEGIN);
    const iFooter = out.indexOf(MARKERS.FOOTER_BEGIN);
    expect(iInfo).toBeGreaterThan(-1);
    expect(iInfo).toBeLessThan(iBody);
    expect(iBody).toBeLessThan(iLinks);
    expect(iLinks).toBeLessThan(iFooter);
    expect(out).toContain(`${MARKERS.BODY_BEGIN}\nNEW body\n${MARKERS.BODY_END}`);
  });

  test("appends only the missing section when some markers are present", () => {
    // Body markers present; stack-links + footer absent.
    const existing = [MARKERS.INFO, "", MARKERS.BODY_BEGIN, "OLD", MARKERS.BODY_END].join("\n");
    const out = spliceBody(existing, { bodyContent: "NEW body", stackLinks: links });
    expect(out).toContain(`${MARKERS.BODY_BEGIN}\nNEW body\n${MARKERS.BODY_END}`);
    expect(out).toContain(MARKERS.STACK_LINKS_BEGIN); // appended
    expect(out).toContain(MARKERS.FOOTER_BEGIN); // appended
    // info not duplicated
    expect(out.split(MARKERS.INFO).length - 1).toBe(1);
  });

  test("empty stackLinks removes an existing stack-links region's content but keeps markers", () => {
    const existing = [
      MARKERS.STACK_LINKS_BEGIN, "OLD links", MARKERS.STACK_LINKS_END,
    ].join("\n");
    const out = spliceBody(existing, { bodyContent: "b", stackLinks: "" });
    expect(out).toContain(`${MARKERS.STACK_LINKS_BEGIN}\n${MARKERS.STACK_LINKS_END}`);
    expect(out).not.toContain("OLD links");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gh/pr-body-markers.test.ts`
Expected: FAIL — `spliceBody` not exported.

- [ ] **Step 3: Implement in `src/gh/pr-body.ts`**

```ts
export interface SpliceBodyOptions {
  bodyContent: string;
  /** Rendered stack-links block; "" replaces an existing region's content with empty. */
  stackLinks: string;
}

/**
 * Replace the content between a single begin/end marker pair, in place, leaving
 * every other byte of `body` untouched. Returns null when the pair is absent or
 * malformed (end before begin), so the caller can decide to append.
 */
function replaceRegion(body: string, begin: string, end: string, content: string): string | null {
  const b = body.indexOf(begin);
  if (b === -1) return null;
  const e = body.indexOf(end, b + begin.length);
  if (e === -1) return null;
  const before = body.slice(0, b + begin.length);
  const after = body.slice(e);
  const inner = content ? `\n${content}\n` : "\n";
  return `${before}${inner}${after}`;
}

/**
 * Splice fresh spry content into an existing PR body IN PLACE.
 *
 * Spry owns only the info line and the bytes between each begin/end pair. For
 * each spry region present in `existing`, its inner content is replaced; user
 * bytes outside the markers are preserved verbatim. Any spry region whose
 * markers are absent is APPENDED in canonical order (info, body, stack-links,
 * footer) at the end — self-healing for pre-feature or hand-edited bodies.
 */
export function spliceBody(existing: string, opts: SpliceBodyOptions): string {
  let out = existing;

  // 1. In-place replacements for regions that exist.
  const bodyReplaced = replaceRegion(out, MARKERS.BODY_BEGIN, MARKERS.BODY_END, opts.bodyContent);
  if (bodyReplaced !== null) out = bodyReplaced;

  const linksReplaced = replaceRegion(
    out, MARKERS.STACK_LINKS_BEGIN, MARKERS.STACK_LINKS_END, opts.stackLinks,
  );
  if (linksReplaced !== null) out = linksReplaced;

  const footerReplaced = replaceRegion(
    out, MARKERS.FOOTER_BEGIN, MARKERS.FOOTER_END, generateFooter(),
  );
  if (footerReplaced !== null) out = footerReplaced;

  // 2. Append missing sections in canonical order.
  const appends: string[] = [];
  const hasInfo = out.includes(MARKERS.INFO);
  const hasBody = bodyReplaced !== null;
  const hasLinks = linksReplaced !== null;
  const hasFooter = footerReplaced !== null;

  if (!hasInfo) appends.push(MARKERS.INFO);
  if (!hasBody) {
    appends.push(MARKERS.BODY_BEGIN);
    if (opts.bodyContent) appends.push(opts.bodyContent);
    appends.push(MARKERS.BODY_END);
  }
  if (!hasLinks) {
    appends.push(MARKERS.STACK_LINKS_BEGIN);
    if (opts.stackLinks) appends.push(opts.stackLinks);
    appends.push(MARKERS.STACK_LINKS_END);
  }
  if (!hasFooter) {
    appends.push(MARKERS.FOOTER_BEGIN, generateFooter(), MARKERS.FOOTER_END);
  }

  if (appends.length === 0) return out;

  // Separate appended block from existing content with a blank line, unless the
  // body was empty to begin with.
  const sep = out.trim().length > 0 ? `${out.replace(/\s+$/, "")}\n\n` : "";
  return `${sep}${appends.join("\n")}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gh/pr-body-markers.test.ts`
Expected: PASS. If the "append missing sections in canonical order" test fails on the info/body ordering when NO markers exist, note the append order is info, body, links, footer — verify the test's index assertions match.

- [ ] **Step 5: Commit**

```bash
git add src/gh/pr-body.ts tests/gh/pr-body-markers.test.ts
git commit -m "feat(pr-body): add spliceBody for in-place reuse with append-missing"
```

---

## Task 5: `findPRTemplate` (repo template discovery, create-time only)

**Files:**

- Create: `src/gh/pr-template.ts`
- Test: `tests/gh/pr-template.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/gh/pr-template.test.ts`:

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPRTemplate } from "../../src/gh/pr-template.ts";

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "spry-tmpl-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("findPRTemplate", () => {
  test("returns undefined when no template exists", async () => {
    const cwd = await tmp();
    expect(await findPRTemplate(cwd)).toBeUndefined();
  });

  test("finds .github/PULL_REQUEST_TEMPLATE.md and trims it", async () => {
    const cwd = await tmp();
    await mkdir(join(cwd, ".github"), { recursive: true });
    await writeFile(join(cwd, ".github/PULL_REQUEST_TEMPLATE.md"), "\n## Testing\n\n- [ ]\n\n");
    expect(await findPRTemplate(cwd)).toBe("## Testing\n\n- [ ]");
  });

  test("prefers .github over root location", async () => {
    const cwd = await tmp();
    await mkdir(join(cwd, ".github"), { recursive: true });
    await writeFile(join(cwd, ".github/pull_request_template.md"), "GITHUB DIR");
    await writeFile(join(cwd, "pull_request_template.md"), "ROOT");
    expect(await findPRTemplate(cwd)).toBe("GITHUB DIR");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gh/pr-template.test.ts`
Expected: FAIL — module `src/gh/pr-template.ts` not found.

- [ ] **Step 3: Implement `src/gh/pr-template.ts`**

```ts
/**
 * Standard PR-template locations, checked in order. GitHub itself honors these
 * (plus a `.github/PULL_REQUEST_TEMPLATE/` directory for multiple templates,
 * which we intentionally do not support — single template only).
 */
const PR_TEMPLATE_LOCATIONS = [
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
];

/**
 * Find the repo's PR template, returning its trimmed content or undefined.
 * Used ONLY at PR-creation time to seed the user region under the body.
 */
export async function findPRTemplate(cwd?: string): Promise<string | undefined> {
  for (const loc of PR_TEMPLATE_LOCATIONS) {
    const path = cwd ? `${cwd}/${loc}` : loc;
    const file = Bun.file(path);
    if (await file.exists()) {
      const content = (await file.text()).trim();
      if (content.length > 0) return content;
    }
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gh/pr-template.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gh/pr-template.ts tests/gh/pr-template.test.ts
git commit -m "feat(pr-body): add PR template discovery for create-time seeding"
```

---

## Task 6: `fetchPRBody` + `updatePRBody` gh helpers

**Files:**

- Modify: `src/gh/pr.ts`
- Test: `tests/gh/pr-edit.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/gh/pr-edit.test.ts`. Use a fake `SpryContext` with a stub `gh` runner that records calls:

```ts
import { describe, test, expect } from "bun:test";
import { fetchPRBody, updatePRBody } from "../../src/gh/pr.ts";
import type { SpryContext } from "../../src/lib/context.ts";
import type { CommandResult, CommandOptions } from "../../src/lib/context.ts";

function fakeCtx(handler: (args: string[], opts?: CommandOptions) => CommandResult): {
  ctx: SpryContext;
  calls: Array<{ args: string[]; opts?: CommandOptions }>;
} {
  const calls: Array<{ args: string[]; opts?: CommandOptions }> = [];
  const gh = {
    run: async (args: string[], opts?: CommandOptions): Promise<CommandResult> => {
      calls.push({ args, opts });
      return handler(args, opts);
    },
  };
  // git is unused by these helpers.
  const ctx = { gh, git: {} as SpryContext["git"] } as SpryContext;
  return { ctx, calls };
}

const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (stderr: string): CommandResult => ({ exitCode: 1, stdout: "", stderr });

describe("fetchPRBody", () => {
  test("calls gh pr view --json body and returns the body string", async () => {
    const { ctx, calls } = fakeCtx(() => ok(JSON.stringify({ body: "Hello body" })));
    const body = await fetchPRBody(ctx, 42, {});
    expect(body).toBe("Hello body");
    expect(calls[0]!.args).toEqual(["pr", "view", "42", "--json", "body", "--jq", ".body"]);
  });

  test("throws on gh failure", async () => {
    const { ctx } = fakeCtx(() => fail("boom"));
    await expect(fetchPRBody(ctx, 42, {})).rejects.toThrow();
  });
});

describe("updatePRBody", () => {
  test("calls gh pr edit --body-file - with the body on stdin", async () => {
    const { ctx, calls } = fakeCtx(() => ok("edited"));
    await updatePRBody(ctx, 42, "NEW BODY", {});
    expect(calls[0]!.args).toEqual(["pr", "edit", "42", "--body-file", "-"]);
    expect(calls[0]!.opts?.stdin).toBe("NEW BODY");
  });

  test("throws on gh failure", async () => {
    const { ctx } = fakeCtx(() => fail("nope"));
    await expect(updatePRBody(ctx, 42, "x", {})).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gh/pr-edit.test.ts`
Expected: FAIL — `fetchPRBody`, `updatePRBody` not exported.

- [ ] **Step 3: Implement in `src/gh/pr.ts`**

Add at the end of the file (they reuse the existing `withRetry`, `ghRetryPredicate`, `throwForFailure`):

```ts
/**
 * Fetch a single PR's current body text. Uses `--jq .body` so gh emits the raw
 * body string (not wrapped in JSON), giving us exactly what GitHub stored.
 */
export async function fetchPRBody(
  ctx: SpryContext,
  prNumber: number,
  options?: { cwd?: string },
): Promise<string> {
  const args = ["pr", "view", String(prNumber), "--json", "body", "--jq", ".body"];
  const result = await withRetry(() => ctx.gh.run(args, { cwd: options?.cwd }), ghRetryPredicate);
  if (result.exitCode !== 0) throwForFailure(result);
  // gh --jq emits the value followed by a trailing newline; strip exactly one.
  return result.stdout.replace(/\n$/, "");
}

/**
 * Replace a PR's body. Sends the new body on stdin via `--body-file -` so bodies
 * with any content (quotes, markdown, newlines) are passed safely.
 */
export async function updatePRBody(
  ctx: SpryContext,
  prNumber: number,
  body: string,
  options?: { cwd?: string },
): Promise<void> {
  const args = ["pr", "edit", String(prNumber), "--body-file", "-"];
  const result = await withRetry(
    () => ctx.gh.run(args, { cwd: options?.cwd, stdin: body }),
    ghRetryPredicate,
  );
  if (result.exitCode !== 0) throwForFailure(result);
}
```

> **Determinism note for the implementer:** `fetchPRBody` strips one trailing
> newline. `spliceBody` must produce output whose only difference from a
> re-fetch is the intended change, so the round-trip is stable. Do NOT add a
> trailing newline in body generation.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gh/pr-edit.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-export from `src/gh/index.ts`**

In `src/gh/index.ts`, add to the `./pr.ts` export block: `fetchPRBody, updatePRBody`. Add to the `./pr-body.ts` export line: `MARKERS, BETA_WARNING, generateBodyContent, generateStackLinks, generateFooter, buildInitialBody, spliceBody` and the types `BuildInitialBodyOptions, SpliceBodyOptions`. Add a new export line for the template module:

```ts
export { findPRTemplate } from "./pr-template.ts";
```

- [ ] **Step 6: Typecheck + commit**

Run: `bun run types` (or `bunx tsc --noEmit` if no script) — expect no errors.

```bash
git add src/gh/pr.ts src/gh/index.ts tests/gh/pr-edit.test.ts
git commit -m "feat(gh): add fetchPRBody and updatePRBody helpers"
```

---

## Task 7: Wire create-time body to `buildInitialBody`

**Files:**

- Modify: `src/commands/sync.ts:435-507` (the `openPRs` function)
- Test: covered by existing + Task 8 doc test

- [ ] **Step 1: Modify imports in `src/commands/sync.ts`**

Change the `../gh/index.ts` import block: remove `formatPRBody`, add
`buildInitialBody, spliceBody, generateBodyContent, generateStackLinks, findPRTemplate, fetchPRBody, updatePRBody`. Keep `formatPRTitle`.

- [ ] **Step 2: Replace body generation in `openPRs`**

In `openPRs`, before the loop, discover the template once:

```ts
  const prTemplate = await findPRTemplate(cwd);
```

Replace the two lines:

```ts
    const title = formatPRTitle(unit, commitInfos);
    const body = formatPRBody(unit, commitInfos);
```

with:

```ts
    const title = formatPRTitle(unit, commitInfos);
    // Stack-links at create time may be incomplete (siblings opened later in
    // this same run); the updateStackBodies pass at the end of sync corrects
    // every sibling body, so the run converges.
    const prNumbers = collectOpenPRNumbers(units, prMap, config);
    const stackLinks = generateStackLinks(
      units.map((u) => u.id), prNumbers, unit.id, config.trunk,
    );
    const body = buildInitialBody({ unit, commits: commitInfos, stackLinks, prTemplate });
```

`openPRs` needs `prMap` — add a `prMap: Map<string, PRInfo | null> | undefined`
parameter to `openPRs` and pass `checked.prMap` at both call sites in
`syncCommand`. (For freshly-opened PRs whose number isn't in `prMap` yet, they
simply won't appear in their own stack-links until the update pass — acceptable
and self-correcting.)

- [ ] **Step 3: Add the `collectOpenPRNumbers` helper**

Add near the other helpers in `src/commands/sync.ts`:

```ts
/** unitId -> PR number, for units whose PR is currently OPEN. */
function collectOpenPRNumbers(
  units: PRUnit[],
  prMap: Map<string, PRInfo | null> | undefined,
  config: SpryConfig,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!prMap) return out;
  for (const unit of units) {
    const pr = prMap.get(branchForUnit(unit, config));
    if (pr && pr.state === "OPEN") out.set(unit.id, pr.number);
  }
  return out;
}
```

- [ ] **Step 4: Typecheck**

Run: `bun run types`
Expected: no errors. Fix signature mismatches at the two `openPRs` call sites.

- [ ] **Step 5: Run existing sync tests (playback)**

Run: `bun test tests/commands/sync.test.ts`
Expected: PASS. Body changes don't hit gh in unit tests; cassettes still replay because create-time `createPR` already sent a body on stdin — BUT the body content changed, so **the create cassettes will mismatch on stdin**. If `sync.doc.test.ts` cassettes fail here, that is expected and handled in Task 8 (re-record). For now run only `sync.test.ts` (non-cassette unit tests).

- [ ] **Step 6: Commit**

```bash
git add src/commands/sync.ts
git commit -m "feat(sync): generate marked PR bodies with stack-links on create"
```

---

## Task 8: `updateStackBodies` pass + doc test round-trip

**Files:**

- Modify: `src/commands/sync.ts` (add pass, call from `syncCommand` and `finishSyncAll`)
- Modify: `tests/commands/sync.doc.test.ts` (add edit-preservation doc test)

- [ ] **Step 1: Add the `updateStackBodies` function to `src/commands/sync.ts`**

```ts
/**
 * Rewrite the spry-owned regions of every OPEN PR's body in the stack. For each
 * open PR: fetch its current body, splice fresh body-content + stack-links in
 * place (preserving user regions), and push via updatePRBody ONLY when the
 * result differs byte-for-byte. Best-effort: failures warn and flip the return
 * flag; they never abort the sync. Runs over ALL open PRs (not just pushed
 * ones) because opening/moving any PR changes sibling stack-links.
 */
async function updateStackBodies(
  ctx: SpryContext,
  config: SpryConfig,
  units: PRUnit[],
  commits: CommitWithTrailers[],
  prMap: Map<string, PRInfo | null> | undefined,
  cwd: string | undefined,
): Promise<boolean> {
  if (!prMap) return false;
  const prNumbers = collectOpenPRNumbers(units, prMap, config);
  let hadFailure = false;

  for (const unit of units) {
    const pr = prMap.get(branchForUnit(unit, config));
    if (!pr || pr.state !== "OPEN") continue;
    try {
      const existing = await fetchPRBody(ctx, pr.number, { cwd });
      const stackLinks = generateStackLinks(
        units.map((u) => u.id), prNumbers, unit.id, config.trunk,
      );
      const next = spliceBody(existing, {
        bodyContent: generateBodyContent(unit, commits),
        stackLinks,
      });
      if (next !== existing) {
        await updatePRBody(ctx, pr.number, next, { cwd });
        console.log(`✎ updated PR #${pr.number} body`);
      }
    } catch (err) {
      hadFailure = true;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`⚠ Could not update PR #${pr.number} body: ${message}`);
    }
  }
  return hadFailure;
}
```

Note: `generateBodyContent` takes `CommitInfo[]`; `CommitWithTrailers` extends
`CommitInfo`, so passing `commits` (the `withTrailers` array) is type-safe.

- [ ] **Step 2: Call it from `syncCommand`**

In `syncCommand`, after the `retargetMismatched` / `writePRCache` block and
BEFORE the `hadFailure` aggregation, add:

```ts
  const bodyHadFailure = await updateStackBodies(
    ctx, config, units, withTrailers, prMap, cwd,
  );
```

Then fold `bodyHadFailure` into the `hadFailure` OR-chain:

```ts
  const hadFailure =
    pushResult.hadFailure || openHadFailure || retargetHadFailure ||
    parkFailed.size > 0 || bodyHadFailure;
```

- [ ] **Step 3: Call it from `finishSyncAll` (for `--all`)**

In `finishSyncAll`, after the retarget loop and the combined `writePRCache`,
add a per-stack body pass. `finishSyncAll` returns void today; body failures in
`--all` are logged (self-explanatory) — to keep it simple, log but do not thread
a return value (the existing `--all` retarget failures are already non-fatal).
Add after the `writePRCache` call:

```ts
  for (const stack of stacks) {
    await updateStackBodies(ctx, config, stack.units, /* commits */ [], prMap, cwd);
  }
```

> **Implementer decision required:** `finishSyncAll` does not currently carry the
> per-stack `CommitWithTrailers`. `generateBodyContent` needs them for the body
> section (single-commit prose). Two options — pick the simpler that keeps types
> honest: (a) extend `StackState` with a `commits: CommitWithTrailers[]` field,
> populated where the stack is parsed in `syncAllCommand` (search for
> `stacks.push({ branch, units: result.units, pushed: [] })` and add
> `commits: withTrailers`), then pass `stack.commits` here; OR (b) if that is
> more churn than wanted, ship `--all` body updates as stack-links-only by
> passing `[]` (body region still splices, but single-commit prose would be
> re-derived as empty — NOT acceptable, it would wipe body content). **Use option
> (a).** Update this call to `stack.commits` accordingly.

Implement option (a): add `commits: CommitWithTrailers[]` to the `StackState`
interface, set it at the `stacks.push(...)` site, and pass `stack.commits` here.

- [ ] **Step 4: Typecheck**

Run: `bun run types`
Expected: no errors.

- [ ] **Step 5: Add the edit-preservation doc test**

In `tests/commands/sync.doc.test.ts`, add a new `docTest` (follow the existing
file's cassette pattern with `setupDocRepo` + `withGitHubFixture`; copy the
scaffolding from an existing `--open` doc test in that file). The test must:

1. Create a single-commit stack and `sp sync --open` it (records create cassette).
2. Simulate a user edit: `gh pr edit <n> --body` (or via the fixture) inserting
   user text in a gap, e.g. append `\n\nCUSTOM USER NOTE\n` after the body-end
   region. In record mode this is a real `gh` call; ensure it goes through the
   same recording client so it's captured.
3. Amend the commit body (changes the spry body content) and `sp sync` again.
4. Assert stdout shows `✎ updated PR #1001 body`.
5. Fetch the PR body and assert BOTH: the new spry body content is present AND
   `CUSTOM USER NOTE` survived.

Use `doc.prose(...)` to document the reusable-body behavior for generated docs.
Keep all fixture PR numbers referenced as their normalized form (1001, ...).

> If wiring a real user-edit through the fixture is awkward, an acceptable
> alternative for the DOC test is: assert the create-time body contains the four
> marker regions and the template, then amend + re-sync and assert the body
> region updated. Cover the user-preservation guarantee thoroughly in the Task 4
> unit tests (already done) and keep the doc test focused on the observable
> `sp sync` behavior. Prefer the full round-trip if the fixture supports it.

- [ ] **Step 6: Record the affected cassettes**

Because create-time and update-time bodies now hit gh with new stdin, the sync
doc cassettes must be re-recorded. `gh auth status` is green and recording is
authorized (AGENTS.md). Run ONLY the sync doc test in record mode:

Run: `SPRY_RECORD=1 bun test tests/commands/sync.doc.test.ts`
Expected: PASS, cassettes rewritten under `tests/fixtures/cassettes/`.

- [ ] **Step 7: Play back twice + rebuild docs (determinism gate)**

```bash
bun test tests/commands/sync.doc.test.ts
bun run docs:build
bun test tests/commands/sync.doc.test.ts
bun run docs:build
```

Expected: both playbacks PASS; `git status` shows no diff in `docs/generated/`
beyond the intended new fragment, and no cassette churn beyond the intended new
entries. Drop any `statusCheckRollup` CI-state noise:
`git checkout -- tests/fixtures/cassettes/` for files whose ONLY diff is
check-run state (per AGENTS.md).

- [ ] **Step 8: Update CHANGELOG.md**

Add under the unreleased section:

```markdown
### Added
- `sp sync` now writes structured PR bodies with spry-owned marker regions
  (info, body, stack-links, footer) and rewrites those regions on every sync
  while preserving user edits outside the markers. New PRs seed the user region
  under the body with the repo's PR template when one exists. Stack-links render
  newest-first with descending manual numbering.
```

- [ ] **Step 9: Commit**

```bash
git add src/commands/sync.ts tests/commands/sync.doc.test.ts tests/fixtures/cassettes docs/generated CHANGELOG.md
git commit -m "feat(sync): rewrite spry-owned PR body regions on every sync, preserving user edits"
```

---

## Task 9: Full-suite verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite (playback)**

Run: `bun run test:concurrent`
Expected: PASS. Investigate any failure before proceeding — do NOT commit churn.

- [ ] **Step 2: Typecheck + lint**

Run: `bun run types` and (if present) `bun run lint`
Expected: clean.

- [ ] **Step 3: Confirm no unintended diffs**

Run: `git status` and `git diff --stat`
Expected: only the files this plan touched. `docs/generated` changes limited to
the new/updated sync fragment.

- [ ] **Step 4: Final commit if anything outstanding**

```bash
git add -A && git commit -m "chore: reusable PR bodies — verification pass" || echo "nothing to commit"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** info + body + stack-links + footer (Tasks 1–3), template seed
  on create only (Task 5, Task 7), splice-in-place with append-missing (Task 4),
  update only when body differs (Task 8 `next !== existing`), fetch body per-PR
  before edit (Task 6), pass over ALL open PRs in stack (Task 8), newest-first
  descending numbers (Task 2). All covered.
- **Determinism:** no timestamps/hashes in body — enforced by design; the only
  variable content is PR numbers (normalized) and commit prose (stable).
- **Back-compat:** `formatPRBody` kept + still exported/tested; only its sync
  caller is swapped.

```

```
