import { test, expect } from "bun:test";
import { assembleMarkdown } from "./build-docs.ts";
import type { DocFragment } from "../tests/lib/doc.ts";

test("assembles fragments into markdown grouped by section", () => {
  const fragments: DocFragment[] = [
    {
      title: "Basic sync",
      section: "commands/sync",
      order: 10,
      entries: [
        { type: "prose", content: "Sync your stack:" },
        { type: "command", content: "sp sync" },
        { type: "output", content: "✓ Synced 3 commits" },
      ],
    },
    {
      title: "Sync with open",
      section: "commands/sync",
      order: 20,
      entries: [
        { type: "prose", content: "Open PRs during sync:" },
        { type: "command", content: "sp sync --open" },
      ],
    },
  ];

  const result = assembleMarkdown(fragments);
  const syncDoc = result.get("commands/sync");

  expect(syncDoc).toBeDefined();
  expect(syncDoc).toContain("# sync");
  expect(syncDoc).toContain("Sync your stack:");
  expect(syncDoc).toContain("```\nsp sync\n```");
  expect(syncDoc).toContain("```\n✓ Synced 3 commits\n```");
  expect(syncDoc).toContain("Open PRs during sync:");
  // Order matters: "Basic sync" before "Sync with open"
  expect(syncDoc!.indexOf("Sync your stack:")).toBeLessThan(
    syncDoc!.indexOf("Open PRs during sync:"),
  );
});

test("screen entries render as code blocks", () => {
  const fragments: DocFragment[] = [
    {
      title: "Group editor",
      section: "commands/group",
      order: 10,
      entries: [
        { type: "prose", content: "The group editor:" },
        { type: "screen", content: "Group Editor - 3 commits\n→ [A] abc123 First commit" },
      ],
    },
  ];

  const result = assembleMarkdown(fragments);
  const groupDoc = result.get("commands/group");

  expect(groupDoc).toContain("```\nGroup Editor - 3 commits");
});
