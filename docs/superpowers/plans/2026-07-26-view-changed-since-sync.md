# `sp view` Drift Markers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sp view` show two independent, offline drift markers per unit — `✎` (local edits since last push) and `↓` (remote moved since last fetch) — in both human and `--json` output.

**Architecture:** `sp sync` records the pushed tip SHA as `syncedHeadSha` in each PR-cache entry. `sp view` reads three offline inputs per unit — the unit's local tip SHA, the cached `syncedHeadSha`, and the remote-tracking tip (`refs/remotes/<remote>/<prefix>/<id>`) — and a pure classifier turns them into `{ localAhead, remoteAhead }`. Unknown reference points yield `false` (no false positives). The formatter appends glyphs and a conditional legend; `buildStackTree` emits two booleans.

**Tech Stack:** TypeScript, Bun, `bun test`, git plumbing via the `GitRunner` seam, `kleur` for color.

**Spec:** `docs/superpowers/specs/2026-07-26-view-changed-since-sync-design.md`

---

## File Structure

- `src/git/drift.ts` **(new)** — pure `classifyDrift(inputs)` → `Drift`, and `Drift`/`DriftInputs` types. One responsibility: the offline comparison logic, unit-testable with no git.
- `src/git/branch.ts` **(modify)** — add `resolveRemoteTrackingTip(git, unit, config, opts)`: resolves `refs/remotes/<remote>/<prefix>/<id>` → SHA or `undefined`. Lives next to `branchForUnit`, which already owns the `<prefix>/<id>` naming.
- `src/gh/pr-cache.ts` **(modify)** — add optional `syncedHeadSha?: string` to `PRCacheEntry`.
- `src/commands/sync.ts` **(modify)** — set `syncedHeadSha` when building a cache entry for a pushed unit.
- `src/gh/enrich.ts` **(modify)** — strip `syncedHeadSha` (alongside `branch`/`cachedAt`) so it never leaks into `EnrichedUnit.pr` (a pure `PRInfo`).
- `src/commands/view.ts` **(modify)** — gather the three inputs per unit, run `classifyDrift`, thread a `Drift[]` (aligned to `enriched`) into formatter and tree builder.
- `src/ui/format.ts` **(modify)** — `formatStackView` gains a `drift: Drift[]` param; append glyphs; conditional legend.
- `src/parse/stack-tree.ts` + `src/parse/types.ts` **(modify)** — `buildStackTree` gains a `drift: Drift[]` param; add `localAhead`/`remoteAhead` to `StackTreeCommit` and `StackTreeGroup`.
- `tests/git/drift.test.ts` **(new)** — pure classifier unit tests.
- `tests/commands/view.doc.test.ts` **(modify)** — one narrative doc fragment + mechanical `test()` cases.

**Local tip SHA:** a unit's tip is `unit.commits[unit.commits.length - 1]` (commits are SHAs in stack order; the last is the top of the unit). No extra git call — `view.ts` already has the units.

---

## Task 1: Pure drift classifier

**Files:**

- Create: `src/git/drift.ts`
- Test: `tests/git/drift.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/git/drift.test.ts
import { test, expect, describe } from "bun:test";
import { classifyDrift } from "../../src/git/drift.ts";

describe("classifyDrift", () => {
  test("clean: local matches both references", () => {
    const d = classifyDrift({ localTip: "aaa", syncedHeadSha: "aaa", remoteTrackingTip: "aaa" });
    expect(d).toEqual({ localAhead: false, remoteAhead: false });
  });

  test("local-ahead: local differs from synced only", () => {
    const d = classifyDrift({ localTip: "bbb", syncedHeadSha: "aaa", remoteTrackingTip: "bbb" });
    expect(d).toEqual({ localAhead: true, remoteAhead: false });
  });

  test("remote-ahead: local differs from tracking only", () => {
    const d = classifyDrift({ localTip: "aaa", syncedHeadSha: "aaa", remoteTrackingTip: "zzz" });
    expect(d).toEqual({ localAhead: false, remoteAhead: true });
  });

  test("diverged: local differs from both", () => {
    const d = classifyDrift({ localTip: "bbb", syncedHeadSha: "aaa", remoteTrackingTip: "zzz" });
    expect(d).toEqual({ localAhead: true, remoteAhead: true });
  });

  test("unknown syncedHeadSha suppresses localAhead", () => {
    const d = classifyDrift({ localTip: "bbb", syncedHeadSha: undefined, remoteTrackingTip: "zzz" });
    expect(d).toEqual({ localAhead: false, remoteAhead: true });
  });

  test("unknown remoteTrackingTip suppresses remoteAhead", () => {
    const d = classifyDrift({ localTip: "bbb", syncedHeadSha: "aaa", remoteTrackingTip: undefined });
    expect(d).toEqual({ localAhead: true, remoteAhead: false });
  });

  test("both references unknown: nothing", () => {
    const d = classifyDrift({ localTip: "bbb", syncedHeadSha: undefined, remoteTrackingTip: undefined });
    expect(d).toEqual({ localAhead: false, remoteAhead: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/git/drift.test.ts`
Expected: FAIL — `Cannot find module '../../src/git/drift.ts'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/git/drift.ts

/** Offline inputs for classifying a single unit's drift. */
export interface DriftInputs {
  /** The unit's current local tip SHA. */
  localTip: string;
  /** SHA sp sync last pushed for this unit (PR cache); undefined if unknown. */
  syncedHeadSha?: string;
  /** Remote-tracking tip SHA; undefined if the tracking ref is absent. */
  remoteTrackingTip?: string;
}

/** Two independent, orthogonal drift signals. */
export interface Drift {
  /** Local tip differs from the last pushed SHA (only when that SHA is known). */
  localAhead: boolean;
  /** Local tip differs from the remote-tracking tip (only when it is known). */
  remoteAhead: boolean;
}

/**
 * Pure: classify a unit's drift from offline inputs. An unknown reference point
 * (undefined) yields `false` for its signal — we never render a marker we can't
 * justify.
 */
export function classifyDrift(inputs: DriftInputs): Drift {
  const { localTip, syncedHeadSha, remoteTrackingTip } = inputs;
  return {
    localAhead: syncedHeadSha !== undefined && localTip !== syncedHeadSha,
    remoteAhead: remoteTrackingTip !== undefined && localTip !== remoteTrackingTip,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/git/drift.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/git/drift.ts tests/git/drift.test.ts
git commit -m "feat(view): pure drift classifier (spry-ywa8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: PR-cache `syncedHeadSha` field + enrich strip

**Files:**

- Modify: `src/gh/pr-cache.ts:6-9` (`PRCacheEntry`)
- Modify: `src/gh/enrich.ts:21` (`enrichFromCache` destructure)
- Test: `tests/git/drift.test.ts` covers the classifier; the field itself is a type change verified by the view doc tests in Task 6. No standalone test here.

- [ ] **Step 1: Add the field**

In `src/gh/pr-cache.ts`, extend the interface:

```ts
export interface PRCacheEntry extends PRInfo {
  branch: string;
  cachedAt: string; // ISO 8601
  syncedHeadSha?: string; // local tip SHA that sync last pushed for this unit
}
```

- [ ] **Step 2: Prevent leak into `EnrichedUnit.pr`**

In `src/gh/enrich.ts`, `enrichFromCache` currently does:

```ts
    const { branch: _branch, cachedAt: _cachedAt, ...prInfo } = entry;
```

Change it to also strip the new field so `prInfo` stays a clean `PRInfo`:

```ts
    const { branch: _branch, cachedAt: _cachedAt, syncedHeadSha: _syncedHeadSha, ...prInfo } = entry;
```

- [ ] **Step 3: Run the type check / existing suites**

Run: `bun test tests/git/ tests/commands/view.doc.test.ts`
Expected: PASS (unchanged behavior; the field is optional and now stripped).

- [ ] **Step 4: Commit**

```bash
git add src/gh/pr-cache.ts src/gh/enrich.ts
git commit -m "feat(view): add optional syncedHeadSha to PRCacheEntry (spry-ywa8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Record `syncedHeadSha` on sync push

**Files:**

- Modify: `src/commands/sync.ts:748` (inside `writePRCache`)
- Test: covered end-to-end by the view doc tests (Task 6), which seed then re-sync. No new sync test — the write is one line and the existing sync tests must stay green.

- [ ] **Step 1: Set the field when building the entry**

In `writePRCache` (`src/commands/sync.ts`), the loop over `units` currently builds:

```ts
    if (pr && pr.state === "OPEN") cache[unit.id] = { ...pr, branch, cachedAt: now };
```

The unit's tip SHA is the last commit in `unit.commits`. Change to:

```ts
    if (pr && pr.state === "OPEN") {
      const syncedHeadSha = unit.commits[unit.commits.length - 1];
      cache[unit.id] = { ...pr, branch, cachedAt: now, syncedHeadSha };
    }
```

Note: `savePRCache` replaces the whole cache tree from the units passed in this run, so units not in `units` are not touched here — that is fine; sync always passes the full current stack. Do not add clearing logic.

- [ ] **Step 2: Run the sync suite**

Run: `bun test tests/commands/sync.test.ts tests/commands/sync.doc.test.ts`
Expected: PASS. Cassettes unaffected (no new `gh` calls; only cache-blob content changes, which is not asserted byte-for-byte by sync docs — if a sync doc fragment changes, inspect it: the only legitimate change is an added `syncedHeadSha` in a shown cache blob, which sync docs do not print. Any other change is a real failure.)

- [ ] **Step 3: Commit**

```bash
git add src/commands/sync.ts
git commit -m "feat(sync): record syncedHeadSha when caching a pushed PR (spry-ywa8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Remote-tracking-tip resolver

**Files:**

- Modify: `src/git/branch.ts`
- Test: `tests/git/branch.test.ts` (create if absent; otherwise append)

- [ ] **Step 1: Write the failing test**

Check whether `tests/git/branch.test.ts` exists. If not, create it with this content; if it exists, append the `describe` block.

```ts
// tests/git/branch.test.ts
import { test, expect, describe, afterAll } from "bun:test";
import { $ } from "bun";
import { resolveRemoteTrackingTip } from "../../src/git/branch.ts";
import { createRealGitRunner, createRepo } from "../lib/index.ts";
import type { SpryConfig } from "../../src/git/config.ts";
import type { PRUnit } from "../../src/parse/types.ts";

const repos: Array<{ cleanup(): Promise<void> }> = [];
afterAll(async () => {
  for (const r of repos) await r.cleanup();
});

function unit(id: string, tip: string): PRUnit {
  return { type: "single", id, title: undefined, commitIds: [id], commits: [tip], subjects: ["x"] };
}

const config: SpryConfig = {
  trunk: "main",
  remote: "origin",
  branchPrefix: "spry/dondenton",
  owner: undefined,
  repo: undefined,
  autoDeleteOnLand: false,
};

describe("resolveRemoteTrackingTip", () => {
  test("returns undefined when the tracking ref is absent", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const git = createRealGitRunner();
    const tip = await resolveRemoteTrackingTip(git, unit("aaa11111", "deadbeef"), config, {
      cwd: repo.path,
    });
    expect(tip).toBeUndefined();
  });

  test("returns the SHA when the tracking ref exists", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const git = createRealGitRunner();
    // Push a spry branch, then fetch so refs/remotes/origin/spry/dondenton/aaa11111 exists.
    await repo.branch("feature");
    await $`git -C ${repo.path} commit --allow-empty -m ${"c\n\nSpry-Commit-Id: aaa11111"}`.quiet();
    const sha = (await $`git -C ${repo.path} rev-parse HEAD`.quiet()).stdout.toString().trim();
    await $`git -C ${repo.path} push origin HEAD:refs/heads/spry/dondenton/aaa11111`.quiet();
    await $`git -C ${repo.path} fetch origin`.quiet();
    const tip = await resolveRemoteTrackingTip(git, unit("aaa11111", sha), config, {
      cwd: repo.path,
    });
    expect(tip).toBe(sha);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/git/branch.test.ts`
Expected: FAIL — `resolveRemoteTrackingTip` is not exported.

- [ ] **Step 3: Implement**

Append to `src/git/branch.ts`:

```ts
import type { GitRunner } from "../lib/context.ts";

interface GitOpts {
  cwd?: string;
}

/**
 * Resolve a unit's remote-tracking tip (`refs/remotes/<remote>/<prefix>/<id>`)
 * to a SHA, offline. Returns undefined when the tracking ref is absent (e.g. the
 * unit was never pushed, or never fetched). Never throws on a missing ref.
 */
export async function resolveRemoteTrackingTip(
  git: GitRunner,
  unit: PRUnit,
  config: SpryConfig,
  opts?: GitOpts,
): Promise<string | undefined> {
  const ref = `refs/remotes/${config.remote}/${config.branchPrefix}/${unit.id}`;
  const res = await git.run(["rev-parse", "--verify", "--quiet", ref], opts);
  if (res.exitCode !== 0) return undefined;
  const sha = res.stdout.trim();
  return sha === "" ? undefined : sha;
}
```

(The existing `import type { PRUnit }` and `import type { SpryConfig }` are already at the top of the file; only add the `GitRunner` import if not present.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/git/branch.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/git/branch.ts tests/git/branch.test.ts
git commit -m "feat(view): offline remote-tracking-tip resolver (spry-ywa8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Thread drift through formatter and JSON

This task wires the classifier output into both outputs. Because `formatStackView` and `buildStackTree` gain a new param, update their signatures, callers, and the JSON types together, then verify with existing unit tests before the doc tests in Task 6.

**Files:**

- Modify: `src/parse/types.ts:69-86` (`StackTreeCommit`, `StackTreeGroup`)
- Modify: `src/parse/stack-tree.ts` (`buildStackTree` signature + emit booleans)
- Modify: `src/ui/format.ts` (`formatStackView` signature + glyphs + legend)
- Modify: `src/commands/view.ts` (compute drift, pass to both)
- Test: `tests/parse/stack-tree.test.ts` (append), `tests/ui/format.test.ts` (append if present)

> **Backward compatibility:** `tests/ui/format.test.ts` and
> `tests/parse/stack-tree.test.ts` already exist and call `formatStackView(...)`
> / `buildStackTree(enriched)` with the OLD arity (~25 call sites). The new
> `drift` parameter is therefore **optional with a default of `[]`** on both
> functions — existing callers compile unchanged and render no markers (empty
> array → every `drift[i]` is `undefined` → no glyphs, no legend). Only `view.ts`
> passes a real array.

- [ ] **Step 1: Extend the JSON output types**

In `src/parse/types.ts`, add both booleans to the two output node types (output-only, so keep them required-on-output but the input path in `sp group --apply` ignores them — matching how `sha`/`subject` are already output-only):

```ts
export interface StackTreeCommit {
  type: "commit";
  id: string;
  sha?: string; // output only
  subject?: string; // output only
  localAhead?: boolean; // output only
  remoteAhead?: boolean; // output only
  pr?: PrStateInfo | null | "CLOSE" | "ADOPT";
  reissueId?: boolean; // input only
}

export interface StackTreeGroup {
  type: "group";
  id: string | null;
  title?: string | null;
  localAhead?: boolean; // output only
  remoteAhead?: boolean; // output only
  pr?: PrStateInfo | null | "CLOSE" | "ADOPT";
  reissueId?: boolean; // input only
  commits: StackTreeCommit[];
}
```

- [ ] **Step 2: Write failing test for `buildStackTree`**

Append to `tests/parse/stack-tree.test.ts` (create the file with the imports below if it does not exist):

```ts
import { test, expect, describe } from "bun:test";
import { buildStackTree } from "../../src/parse/stack-tree.ts";
import type { EnrichedUnit } from "../../src/gh/enrich.ts";
import type { Drift } from "../../src/git/drift.ts";
import type { PRUnit } from "../../src/parse/types.ts";

function single(id: string): PRUnit {
  return { type: "single", id, title: "T", commitIds: [id], commits: ["sha1"], subjects: ["S"] };
}

describe("buildStackTree drift", () => {
  test("emits localAhead/remoteAhead per unit", () => {
    const enriched: EnrichedUnit[] = [{ unit: single("aaa"), pr: null }];
    const drift: Drift[] = [{ localAhead: true, remoteAhead: false }];
    const tree = buildStackTree(enriched, drift);
    expect(tree.stack[0]).toMatchObject({ localAhead: true, remoteAhead: false });
  });

  test("defaults to false when drift missing for an index", () => {
    const enriched: EnrichedUnit[] = [{ unit: single("aaa"), pr: null }];
    const tree = buildStackTree(enriched, []);
    expect(tree.stack[0]).toMatchObject({ localAhead: false, remoteAhead: false });
  });
});
```

Run: `bun test tests/parse/stack-tree.test.ts`
Expected: FAIL — `buildStackTree` takes one arg.

- [ ] **Step 3: Implement `buildStackTree` change**

In `src/parse/stack-tree.ts`, change the signature and emit the booleans (default `false` when an index has no drift entry):

```ts
import type { Drift } from "../git/drift.ts";

/** Pure: serializes enriched, parsed units into the nested output tree for `sp view --json`. */
export function buildStackTree(enriched: EnrichedUnit[], drift: Drift[] = []): StackTree {
  const stack: StackTreeNode[] = enriched.map(({ unit, pr }, i) => {
    const d = drift[i] ?? { localAhead: false, remoteAhead: false };
    if (unit.type === "group") {
      return {
        type: "group",
        id: unit.id,
        title: unit.title ?? null,
        localAhead: d.localAhead,
        remoteAhead: d.remoteAhead,
        pr: prState(pr),
        commits: memberCommits(unit.commitIds, unit.commits, unit.subjects),
      };
    }
    return {
      type: "commit",
      id: unit.id,
      sha: unit.commits[0] ?? "",
      subject: unit.subjects[0] ?? "",
      localAhead: d.localAhead,
      remoteAhead: d.remoteAhead,
      pr: prState(pr),
    };
  });
  return { stack };
}
```

Run: `bun test tests/parse/stack-tree.test.ts`
Expected: PASS.

- [ ] **Step 4: Write failing test for `formatStackView` glyphs + legend**

Append to `tests/ui/format.test.ts` (create with these imports if absent). Strip ANSI so assertions are color-independent:

```ts
import { test, expect, describe } from "bun:test";
import { formatStackView } from "../../src/ui/format.ts";
import type { EnrichedUnit } from "../../src/gh/enrich.ts";
import type { Drift } from "../../src/git/drift.ts";
import type { PRUnit } from "../../src/parse/types.ts";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function single(id: string, title: string): PRUnit {
  return { type: "single", id, title, commitIds: [id], commits: ["sha1"], subjects: [title] };
}

describe("formatStackView drift markers", () => {
  test("no markers and no legend on a clean stack", () => {
    const enriched: EnrichedUnit[] = [{ unit: single("aaa", "Clean"), pr: null }];
    const drift: Drift[] = [{ localAhead: false, remoteAhead: false }];
    const out = strip(formatStackView(enriched, "feature", 1, "main", drift));
    expect(out).toContain("Clean");
    expect(out).not.toContain("✎");
    expect(out).not.toContain("↓");
    expect(out).not.toContain("local edits");
  });

  test("local-ahead shows ✎ and legend", () => {
    const enriched: EnrichedUnit[] = [{ unit: single("aaa", "Edited"), pr: null }];
    const drift: Drift[] = [{ localAhead: true, remoteAhead: false }];
    const out = strip(formatStackView(enriched, "feature", 1, "main", drift));
    expect(out).toContain("✎ Edited");
    expect(out).toContain("local edits, run sp sync");
  });

  test("diverged shows ✎↓", () => {
    const enriched: EnrichedUnit[] = [{ unit: single("aaa", "Both"), pr: null }];
    const drift: Drift[] = [{ localAhead: true, remoteAhead: true }];
    const out = strip(formatStackView(enriched, "feature", 1, "main", drift));
    expect(out).toContain("✎↓ Both");
    expect(out).toContain("remote moved since your push");
  });
});
```

Run: `bun test tests/ui/format.test.ts`
Expected: FAIL — `formatStackView` takes four args.

- [ ] **Step 5: Implement `formatStackView` change**

In `src/ui/format.ts`:

1. Import the type at the top:

```ts
import type { Drift } from "../git/drift.ts";
```

2. Add a helper above `formatStackView`:

```ts
function driftGlyphs(d: Drift | undefined): string {
  if (!d) return "";
  let g = "";
  if (d.localAhead) g += kleur.yellow("✎");
  if (d.remoteAhead) g += kleur.cyan("↓");
  return g;
}
```

3. Change the signature to accept `drift: Drift[]`:

```ts
export function formatStackView(
  enriched: EnrichedUnit[],
  branch: string,
  commitCount: number,
  trunkRef: string,
  drift: Drift[] = [],
): string {
```

4. In the loop over `enriched`, track the index and prefix the title with glyphs + a space when present. Replace the `for (const entry of enriched)` loop header with an indexed loop:

```ts
  for (let idx = 0; idx < enriched.length; idx++) {
    const entry = enriched[idx]!;
    lines.push(SEPARATOR);
    const unit = entry.unit;
    const pr = entry.pr;
    const showPRLine = !fallback && pr !== null;
    const icon = showPRLine ? stateIcon(pr.state) : stateIcon(null);
    const glyphs = driftGlyphs(drift[idx]);
    const marker = glyphs ? `${glyphs} ` : "";

    if (unit.type === "single") {
      const idDisplay = getCommitIdDisplay(unit.commitIds, 0);
      lines.push(`  ${icon} ${marker}${unit.title ?? unit.subjects[0] ?? "Untitled"} ${idDisplay}`);
      if (showPRLine) lines.push(prMetaLine(pr));
    } else {
      let groupTitle: string;
      if (unit.title) {
        groupTitle = unit.title;
      } else {
        const letter = String.fromCharCode(65 + letterIndex);
        letterIndex++;
        groupTitle = `${letter} (${unit.commits.length} commits)`;
      }
      lines.push(`  ${icon} ${marker}${groupTitle}`);
      if (showPRLine) lines.push(prMetaLine(pr));
      for (let i = 0; i < unit.commits.length; i++) {
        const isLast = i === unit.commits.length - 1;
        const prefix = isLast ? "└─" : "├─";
        const subject = unit.subjects[i] ?? "Unknown commit";
        const idDisplay = getCommitIdDisplay(unit.commitIds, i);
        lines.push(`    ${prefix} ${subject} ${idDisplay}`);
      }
    }
  }
```

5. Add the conditional legend. After the existing legend block (`approval:` line), before `lines.push("")`, insert:

```ts
  const showDriftLegend = drift.some((d) => d && (d.localAhead || d.remoteAhead));
  if (showDriftLegend) {
    lines.push(
      kleur.dim("✎ local edits, run sp sync   ↓ remote moved since your push (as of last fetch)"),
    );
  }
```

Run: `bun test tests/ui/format.test.ts`
Expected: PASS.

- [ ] **Step 6: Update `view.ts` to compute and pass drift**

In `src/commands/view.ts`, after `const enriched = enrichFromCache(...)` (line 36) and before the `opts.json` branch, compute per-unit drift. Add imports at the top:

```ts
import { classifyDrift } from "../git/drift.ts";
import type { Drift } from "../git/drift.ts";
import { resolveRemoteTrackingTip } from "../git/branch.ts";
```

Then build the `Drift[]` aligned to `result.units` (same order as `enriched`):

```ts
  const drift: Drift[] = [];
  for (const unit of result.units) {
    const localTip = unit.commits[unit.commits.length - 1] ?? "";
    const syncedHeadSha = prCache[unit.id]?.syncedHeadSha;
    const remoteTrackingTip = await resolveRemoteTrackingTip(ctx.git, unit, config, { cwd });
    drift.push(classifyDrift({ localTip, syncedHeadSha, remoteTrackingTip }));
  }
```

Pass it into both output paths:

```ts
  if (opts.json) {
    console.log(JSON.stringify(buildStackTree(enriched, drift), null, 2));
    return;
  }

  console.log(formatStackView(enriched, branch, commits.length, ref, drift));
```

- [ ] **Step 7: Run the full unit-level suites for touched modules**

Run: `bun test tests/git/ tests/parse/ tests/ui/`
Expected: PASS. If any other caller of `buildStackTree`/`formatStackView` exists, the type checker/tests will flag it — search and fix:

Run: `grep -rn "buildStackTree\|formatStackView" src tests`
Because `drift` defaults to `[]`, existing callers already compile and render
no markers — no edits required to the ~25 legacy call sites in
`tests/ui/format.test.ts` / `tests/parse/stack-tree.test.ts`. Confirm the only
production caller passing a real `drift` array is `view.ts` (Task 5 step 6).

- [ ] **Step 8: Commit**

```bash
git add src/parse/types.ts src/parse/stack-tree.ts src/ui/format.ts src/commands/view.ts tests/parse/stack-tree.test.ts tests/ui/format.test.ts
git commit -m "feat(view): render drift glyphs, legend, and JSON booleans (spry-ywa8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Doc test — one narrative fragment + mechanical cases

**Files:**

- Modify: `tests/commands/view.doc.test.ts`

This is offline: the fixture's local bare origin lets us create real remote-tracking refs by pushing a spry branch and fetching. We seed the PR cache with `syncedHeadSha` directly (as sync would write it) and amend commits to force divergence.

- [ ] **Step 1: Add the narrative doc test**

Append inside the `describe("sp view docs", ...)` block. This emits ONE fragment covering clean → local-ahead → remote-ahead → diverged → unknown. It reuses the `savePRCache`/`PRCacheEntry` imports already at the top of the file; add `$` from `bun` and `createRealGitRunner` is already imported.

```ts
  docTest(
    "Drift markers: what changed since your last sync",
    { section: "commands/view", order: 40 },
    async (doc) => {
      const { $ } = await import("bun");
      const repo = await createRepo();
      repos.push(repo);
      doc.scrub(repo);
      const git = createRealGitRunner();

      await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
      await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
      await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });

      await repo.branch("feature");
      // Unit A — will stay clean. Unit B — will be locally amended.
      await git.run(["commit", "--allow-empty", "-m", "Add login page\n\nSpry-Commit-Id: aaa11111"], {
        cwd: repo.path,
      });
      await git.run(["commit", "--allow-empty", "-m", "Add signup form\n\nSpry-Commit-Id: bbb22222"], {
        cwd: repo.path,
      });

      // Push both unit branches to the local origin and fetch, so remote-tracking
      // refs (refs/remotes/origin/spry/dondenton/<id>) exist — the offline
      // reference point for the ↓ (remote-ahead) signal.
      const shaA = (await $`git -C ${repo.path} rev-parse HEAD~1`.quiet()).stdout.toString().trim();
      const shaB = (await $`git -C ${repo.path} rev-parse HEAD`.quiet()).stdout.toString().trim();
      await $`git -C ${repo.path} push origin ${shaA}:refs/heads/spry/dondenton/aaa11111`.quiet();
      await $`git -C ${repo.path} push origin ${shaB}:refs/heads/spry/dondenton/bbb22222`.quiet();
      await $`git -C ${repo.path} fetch origin`.quiet();

      // Seed the PR cache as sp sync would: syncedHeadSha = the pushed tips.
      const base = {
        url: "https://github.com/owner/repo/pull/1",
        baseRefName: "main",
        checksStatus: "passing" as const,
        reviewDecision: "none" as const,
        reviewThreads: { resolved: 0, total: 0 },
        cachedAt: "2026-06-07T00:00:00.000Z",
      };
      const cache: Record<string, PRCacheEntry> = {
        aaa11111: { ...base, branch: "spry/dondenton/aaa11111", number: 1, state: "OPEN", title: "Add login page", url: "https://github.com/owner/repo/pull/1", syncedHeadSha: shaA },
        bbb22222: { ...base, branch: "spry/dondenton/bbb22222", number: 2, state: "OPEN", title: "Add signup form", url: "https://github.com/owner/repo/pull/2", syncedHeadSha: shaB },
      };
      await savePRCache(git, cache, { cwd: repo.path });

      doc.prose(
        "`sp view` marks how each unit has drifted since your last sync, entirely offline. " +
          "Right after a sync, nothing is marked:",
      );
      doc.scrub("https://github.com/owner/repo/pull/1", "https://github.com/<owner>/<repo>/pull/1");
      doc.scrub("https://github.com/owner/repo/pull/2", "https://github.com/<owner>/<repo>/pull/2");

      let out = await runSp(repo.path, "view");
      doc.command(out.command);
      doc.output(out.result.stdout);

      const { expect } = await import("bun:test");
      expect(out.result.stdout).not.toContain("✎");
      expect(out.result.stdout).not.toContain("↓");

      // Amend unit B locally -> its local tip diverges from syncedHeadSha (✎).
      doc.prose(
        "Amend the second commit. Its local tip no longer matches what you pushed, " +
          "so it is flagged with ✎ — a signal to run `sp sync`:",
      );
      await git.run(["commit", "--amend", "-m", "Add signup form (revised)\n\nSpry-Commit-Id: bbb22222"], {
        cwd: repo.path,
      });

      out = await runSp(repo.path, "view");
      doc.command(out.command);
      doc.output(out.result.stdout);
      expect(out.result.stdout).toContain("✎");
      expect(out.result.stdout).toContain("local edits, run sp sync");

      doc.prose(
        "The ↓ marker means the remote moved since your push (as of your last fetch), and " +
          "✎↓ together means both. Units with no recorded sync show no marker at all.",
      );
    },
  );
```

- [ ] **Step 2: Add mechanical (non-doc) assertions**

Add `test` and `expect` to the top-of-file `bun:test` import
(`import { describe, afterAll, test, expect } from "bun:test";`), and `$` from
`bun` (`import { $ } from "bun";`). Then add a second top-level
`describe("sp view drift (json)", ...)` block (a sibling of the existing
`describe("sp view docs", ...)`, NOT nested) containing this `test()`. It pins
the `--json` booleans and diverged behavior without emitting a fragment:

```ts
describe("sp view drift (json)", () => {
  test("view --json exposes localAhead/remoteAhead", async () => {
    const repo = await createRepo();
    repos.push(repo);
    const git = createRealGitRunner();
    await git.run(["config", "spry.trunk", "main"], { cwd: repo.path });
    await git.run(["config", "spry.remote", "origin"], { cwd: repo.path });
    await git.run(["config", "spry.branchPrefix", "spry/dondenton"], { cwd: repo.path });
    await repo.branch("feature");
    await git.run(["commit", "--allow-empty", "-m", "C\n\nSpry-Commit-Id: aaa11111"], { cwd: repo.path });
    const sha = (await $`git -C ${repo.path} rev-parse HEAD`.quiet()).stdout.toString().trim();
    await $`git -C ${repo.path} push origin ${sha}:refs/heads/spry/dondenton/aaa11111`.quiet();
    await $`git -C ${repo.path} fetch origin`.quiet();
    await savePRCache(
      git,
      {
        aaa11111: {
          branch: "spry/dondenton/aaa11111",
          number: 1,
          url: "u",
          state: "OPEN",
          title: "C",
          baseRefName: "main",
          checksStatus: "none",
          reviewDecision: "none",
          reviewThreads: { resolved: 0, total: 0 },
          cachedAt: "2026-06-07T00:00:00.000Z",
          syncedHeadSha: sha,
        },
      },
      { cwd: repo.path },
    );
    // Amend to force localAhead=true, remoteAhead=true (remote tracking still at old sha).
    await git.run(["commit", "--amend", "-m", "C revised\n\nSpry-Commit-Id: aaa11111"], { cwd: repo.path });
    const { result } = await runSp(repo.path, "view --json");
    const tree = JSON.parse(result.stdout);
    expect(tree.stack[0].localAhead).toBe(true);
    expect(tree.stack[0].remoteAhead).toBe(true);
  });
});
```

- [ ] **Step 3: Run the view doc test in playback**

Run: `bun test tests/commands/view.doc.test.ts`
Expected: PASS. New fragment generated.

- [ ] **Step 4: Rebuild docs and inspect churn**

Run:

```bash
bun run docs:build
git status --short docs/generated
git diff docs/generated/commands/view.*
```

Expected: a NEW fragment for order-40 drift markers; the three existing view fragments (order 10/20/30) should be **byte-identical** (clean stacks render no marker/legend). If any of 10/20/30 changed, inspect — the only acceptable change is none. Investigate anything else before proceeding.

- [ ] **Step 5: Commit**

```bash
git add tests/commands/view.doc.test.ts docs/generated
git commit -m "test(view): doc + mechanical tests for drift markers (spry-ywa8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full-suite verification + changelog

**Files:**

- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run the whole suite (playback / offline)**

Run: `bun run test:concurrent`
Expected: PASS. Fix any caller the type system flags (esp. other `formatStackView`/`buildStackTree` consumers).

- [ ] **Step 2: Rebuild docs and confirm stability**

Run:

```bash
bun run docs:build && git status --short docs/generated
```

Expected: no unexpected churn beyond the order-40 fragment already committed.

- [ ] **Step 3: Update the changelog**

Add under the appropriate unreleased section in `CHANGELOG.md`:

```markdown
- `sp view` now marks units that have drifted since your last sync: `✎` when you have local edits not yet pushed (run `sp sync`), and `↓` when the remote-tracking ref moved since your push (as of your last fetch). Both appear in `--json` as `localAhead` / `remoteAhead`. Fully offline; clean stacks are unchanged.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): sp view drift markers (spry-ywa8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Pre-merge record + playback gate

Per AGENTS.md, prove record mode + doc stability before merge. This mutates the real `spry-check` repo; requires `gh auth status` to be logged in.

- [ ] **Step 1: Record the suite once, docs from scratch**

Run:

```bash
bun run docs:clean
bun run record
bun run docs:build
```

Expected: record mode completes. Cassette churn should be only GitHub Actions check-run state (`statusCheckRollup`) — drop it with `git checkout -- tests/fixtures/cassettes/`. Any other cassette or `docs/generated` diff is a real failure — investigate.

- [ ] **Step 2: Play back twice**

Run:

```bash
bun test && bun run docs:build && bun test && bun run docs:build
```

Expected: PASS both times; `docs/generated` stable (no diff).

- [ ] **Step 3: Commit any legitimate regenerated docs**

```bash
git add docs/generated
git commit -m "docs(generated): regenerate after drift-marker feature (spry-ywa8)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** two signals (Tasks 1,5), unknown→no-marker (Task 1 tests + view.ts guards), offline/no-fetch (Task 4 resolver reads tracking refs only; no fetch added), `syncedHeadSha` field + write + migration (Tasks 2,3; missing field → `undefined` → `localAhead:false`), glyphs + conditional legend (Task 5), JSON booleans (Task 5), one narrative fragment + mechanical cases (Task 6), existing-doc churn discipline (Task 6 step 4, Task 8). All covered.
- **Type consistency:** `Drift`/`DriftInputs` (drift.ts) used identically in stack-tree, format, view; `classifyDrift` name stable; `resolveRemoteTrackingTip` signature stable across Task 4 and Task 5 step 6; `buildStackTree(enriched, drift)` and `formatStackView(..., drift)` signatures consistent between definition and callers.
- **No placeholders:** every code step shows full code; every run step names the command and expected result.
