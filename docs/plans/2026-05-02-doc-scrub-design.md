# Doc-fragment scrub: prevent churn from dynamic values

## Problem

Doc tests run real `sp` commands against a temp git repo and capture stdout into doc fragments. The temp repo's branch name (`feature-pure-goat-vx6`), path (`/tmp/spry-test-pure-goat-vx6`), and origin path are all derived from a per-test random unique ID. Those values land verbatim in `docs/generated/commands/view.md`, so the file changes on every run and shows up as a no-op diff in `git status`.

Today the only affected file is [docs/generated/commands/view.md:10](../generated/commands/view.md#L10), but every future doc test that captures dynamic data (paths, PR numbers, timestamps) will reproduce the bug.

## Approach

Add a `scrub` method to `DocContext` that registers substitutions applied at capture time to `command`, `output`, and `screen` entries. `prose` is hand-authored and exempt.

### API

```ts
interface DocContext {
  prose(text: string): void;
  command(input: string): void;
  output(text: string): void;
  screen(text: string): void;

  // new
  scrub(repo: { uniqueId: string; path: string; originPath: string }): void;
  scrub(pattern: string | RegExp, replacement: string): void;
}
```

### Behavior

- `scrub(repo)` registers three substitutions in this order: `repo.path → /tmp/repo`, `repo.originPath → /tmp/repo-origin`, `repo.uniqueId → ""`. Path substitutions run before the bare `uniqueId` so a path is replaced as a unit rather than leaving `/tmp/spry-test-` after the ID is stripped.
- `scrub(pattern, replacement)` registers an ad-hoc substitution. `pattern` may be a string (literal `replaceAll`) or a `RegExp` (single `replace`).
- Substitutions apply in registration order at capture time, inside `command`, `output`, and `screen`. The in-memory `entries` and the on-disk JSON fragment are both clean.
- `prose` is unaffected.

### Use site

```ts
docTest("Viewing a simple stack", { section: "commands/view", order: 10 }, async (doc) => {
  const repo = await createRepo();
  doc.scrub(repo);
  await repo.branch("feature");
  // ...
  doc.output(result.stdout);   // "feature-pure-goat-vx6" → "feature-"
});
```

The output settles to `Stack: feature- (2 commits)` — a trailing dash, but deterministic. A test author who wants `feature-branch` instead can add `doc.scrub("feature-", "feature-branch")` themselves. No magic dash trimming.

## Files touched

- [tests/lib/doc-types.ts](../../tests/lib/doc-types.ts) — extend `DocContext` with `scrub` overloads.
- [tests/lib/doc.ts](../../tests/lib/doc.ts) — implement `scrub`, apply substitutions in `command`/`output`/`screen`.
- [tests/commands/view.doc.test.ts](../../tests/commands/view.doc.test.ts) — call `doc.scrub(repo)` in both tests.
- [docs/generated/commands/view.md](../generated/commands/view.md) — regenerated.

## Tests

- `tests/lib/doc.test.ts`: add cases that
  - register `doc.scrub(pattern, replacement)` and assert the captured output contains the replacement.
  - register `doc.scrub(repo)` against a fake repo-shaped object and assert `uniqueId` and paths are scrubbed in `output`.
  - confirm `prose` is not affected by scrub.
- Re-run `view.doc.test.ts` twice and confirm `git diff docs/generated/commands/view.md` is empty after the second run.

## Non-goals

- No automatic detection / no warning when un-scrubbed dynamics leak through. The user reads `git diff`; that's the safety net.
- No retroactive scrubbing of entries captured before `scrub` was called. Register subs at the top of the test.
