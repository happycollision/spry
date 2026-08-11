import { describe, expect, test } from "bun:test";
import {
  applyEvent,
  createInitialState,
  extractResult,
  validateMergeGroups,
} from "../../src/tui/group-state.ts";
import type { GroupEditorState } from "../../src/tui/group-state.ts";
import { renderGroupEditor } from "../../src/tui/group-render.ts";
import {
  seedMergeMessage,
  parseMergeMessage,
  placeholderMergeMessage,
  resolveEditor,
} from "../../src/tui/external-editor.ts";
import { collectMergeMessages } from "../../src/tui/group-editor.ts";
import type { CommitWithTrailers } from "../../src/parse/stack.ts";

// Unit tests for the merge axis of the `sp group` editor: the pure state
// machine (src/tui/group-state.ts), its rendering, and the merge-message
// seed/parse contract. The interactive spawn itself is thin and manually
// verified — everything it decides lives in the pure code exercised here.
//
// The interaction model these pin down:
//   ⇧→ / ⇧←   toggle a SINGLE-commit merge group on the cursor's row; on the
//             merge commit, ⇧← collapses the whole group.
//   ⇧↑ / ⇧↓   move the commit (implicit grab); Space+↑↓ does the same.
//             Membership follows where the commit lands — that is the only way
//             to grow a group.
//   ↑ / ↓     move the cursor; the merge commit is its own stop.
//   Enter     refuses to save while any group is invalid (never auto-corrects).

function commit(n: number, id: string): CommitWithTrailers {
  return {
    hash: String(n).repeat(40),
    subject: `Commit ${n}`,
    body: "",
    trailers: { "Spry-Commit-Id": id },
  };
}

/** Four commits; the first three share PR group A, the fourth is ungrouped. */
function stack(): CommitWithTrailers[] {
  return [commit(1, "aaa"), commit(2, "bbb"), commit(3, "ccc"), commit(4, "ddd")];
}

function grouped(): GroupEditorState {
  return createInitialState(stack(), {
    g1: { title: "Group one", members: ["aaa", "bbb", "ccc"] },
  });
}

function at(state: GroupEditorState, cursor: number): GroupEditorState {
  return { ...state, cursor };
}

/** ⇧→ on the cursor's row: always a NEW single-commit group, never a join. */
function toggleMerge(state: GroupEditorState): GroupEditorState {
  return applyEvent(state, { type: "shift-arrow-right" });
}

/** Grab the cursor's row and walk it `steps` rows in `dir`, then drop. */
function grabMove(state: GroupEditorState, dir: "up" | "down", steps = 1): GroupEditorState {
  let s = applyEvent(state, { type: "space" });
  for (let i = 0; i < steps; i++) {
    s = applyEvent(s, { type: dir === "up" ? "arrow-up" : "arrow-down" });
  }
  return applyEvent(s, { type: "space" });
}

/** Put the cursor on `letter`'s merge commit (drawn against its last member). */
function onMergeCommit(state: GroupEditorState, letter: string): GroupEditorState {
  const lastMemberIdx = state.rows.map((r) => r.mergeLetter).lastIndexOf(letter);
  return { ...state, cursor: lastMemberIdx, onMergeCommit: letter };
}

/** Compact "subject(mergeLetter)" view of the stack, for order+membership asserts. */
function shape(state: GroupEditorState): string {
  return state.rows
    .map((r) => `${r.subject}${r.mergeLetter ? `(${r.mergeLetter})` : ""}`)
    .join(" ");
}

describe("⇧→ / ⇧← toggle", () => {
  test("⇧→ creates a single-commit merge group and does not absorb neighbours", () => {
    const s = toggleMerge(at(grouped(), 1));

    expect(shape(s)).toBe("Commit 1 Commit 2(a) Commit 3 Commit 4");
    expect(extractResult(s).mergeGroups[0]?.memberIds).toEqual(["bbb"]);
  });

  test("⇧→ on adjacent rows makes two SEPARATE groups, never one", () => {
    let s = toggleMerge(at(grouped(), 0));
    s = toggleMerge(at(s, 1));

    const groups = extractResult(s).mergeGroups;
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.memberIds)).toEqual([["aaa"], ["bbb"]]);
  });

  test("⇧→ is a no-op on a row already in a merge group", () => {
    const s = toggleMerge(at(grouped(), 1));
    const again = toggleMerge(at(s, 1));

    expect(again.merges.size).toBe(1);
    expect(shape(again)).toBe(shape(s));
  });

  test("⇧← removes a member; the last one dissolves the group", () => {
    let s = toggleMerge(at(grouped(), 1));
    s = grabMove(at(s, 2), "up"); // Commit 3 joins group "a"
    expect(extractResult(s).mergeGroups[0]?.memberIds).toHaveLength(2);

    s = applyEvent(at(s, 1), { type: "shift-arrow-left" });
    expect(extractResult(s).mergeGroups[0]?.memberIds).toHaveLength(1);

    s = applyEvent(at(s, 2), { type: "shift-arrow-left" });
    expect(extractResult(s).mergeGroups).toEqual([]);
    expect(s.merges.size).toBe(0);
  });

  test("⇧← from the middle is allowed and leaves the group non-contiguous", () => {
    // Invalid intermediate states are legal while editing — the user resolves
    // them (validateMergeGroups is what refuses to save).
    let s = toggleMerge(at(grouped(), 0));
    s = grabMove(at(s, 1), "up");
    s = grabMove(at(s, 2), "up", 1);
    const threeMembers = s.rows.filter((r) => r.mergeLetter === "a").length;
    expect(threeMembers).toBe(3);

    const split = applyEvent(at(s, 1), { type: "shift-arrow-left" });

    expect(split.rows[1]?.mergeLetter).toBeNull();
    expect(validateMergeGroups(split)[0]?.reason).toBe("non-contiguous");
  });

  test("⇧← on the merge commit collapses the entire group at once", () => {
    let s = toggleMerge(at(grouped(), 0));
    s = grabMove(at(s, 1), "up"); // two members
    // The merge commit is drawn against the group's LAST member.
    const collapsed = applyEvent(onMergeCommit(s, "a"), { type: "shift-arrow-left" });

    expect(collapsed.rows.every((r) => r.mergeLetter === null)).toBe(true);
    expect(collapsed.merges.size).toBe(0);
    expect(collapsed.onMergeCommit).toBeNull();
    expect(extractResult(collapsed).mergeGroups).toEqual([]);
  });
});

describe("movement — membership follows where the commit lands", () => {
  test("moving a commit against a group's edge joins it (this is how groups grow)", () => {
    let s = toggleMerge(at(grouped(), 0)); // group "a" on Commit 1
    s = grabMove(at(s, 1), "up"); // Commit 2 moves up into it

    // Entering is a track change, not a reorder, so stack order is untouched.
    expect(shape(s)).toBe("Commit 1(a) Commit 2(a) Commit 3 Commit 4");
    expect(extractResult(s).mergeGroups[0]?.memberIds).toEqual(["aaa", "bbb"]);
  });

  test("a commit can travel all the way THROUGH a group and out the far side", () => {
    let s = toggleMerge(at(grouped(), 1));
    s = grabMove(at(s, 2), "up"); // Commit 3 joins -> group is rows 2..3

    // Commit 4 walks up: swap, enter, traverse, traverse, exit.
    let t = applyEvent(at(s, 3), { type: "space" });
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      t = applyEvent(t, { type: "arrow-up" });
      seen.push(shape(t));
    }

    // It ends up above the group, back on the trunk (no merge letter).
    expect(t.rows[0]?.subject).toBe("Commit 4");
    expect(t.rows[0]?.mergeLetter).toBeNull();
    // …and it really did pass through the group on the way (joined mid-journey).
    expect(seen.some((f) => /Commit 4\(a\)/.test(f))).toBe(true);
  });

  test("a group at the TOP of the stack can still be escaped upward", () => {
    // Regression: leaving a group is a track change, not a reorder, so it must
    // not require a row to swap with. A group at the stack edge used to trap
    // any commit that entered it.
    let s = toggleMerge(at(grouped(), 0));
    s = grabMove(at(s, 1), "up"); // group "a" = rows 1..2, at the very top

    let t = applyEvent(at(s, 2), { type: "space" }); // grab Commit 3
    for (let i = 0; i < 4; i++) t = applyEvent(t, { type: "arrow-up" });

    expect(t.rows[0]?.subject).toBe("Commit 3");
    expect(t.rows[0]?.mergeLetter).toBeNull();
  });

  test("a group at the BOTTOM of the stack can still be escaped downward", () => {
    let s = toggleMerge(at(grouped(), 2));
    s = grabMove(at(s, 3), "up"); // group "a" = rows 3..4, at the very bottom

    let t = applyEvent(at(s, 1), { type: "space" }); // grab Commit 2
    for (let i = 0; i < 4; i++) t = applyEvent(t, { type: "arrow-down" });

    expect(t.rows[t.rows.length - 1]?.subject).toBe("Commit 2");
    expect(t.rows[t.rows.length - 1]?.mergeLetter).toBeNull();
  });

  test("a SOLE member moves its whole group instead of dissolving it", () => {
    const s = toggleMerge(at(grouped(), 2)); // single-commit group on Commit 3
    const moved = grabMove(at(s, 2), "up");

    expect(shape(moved)).toBe("Commit 1 Commit 3(a) Commit 2 Commit 4");
    expect(moved.merges.size).toBe(1); // survived the move
  });

  test("grabbing the merge commit moves the whole group as one block", () => {
    let s = toggleMerge(at(grouped(), 0));
    s = grabMove(at(s, 1), "up"); // group "a" = rows 1..2 (Commit 2, Commit 1)
    let t = onMergeCommit(s, "a");
    t = applyEvent(t, { type: "space" });
    t = applyEvent(t, { type: "arrow-down" });

    // Commit 3 hopped above the intact block, which kept its order + identity.
    expect(shape(t)).toBe("Commit 3 Commit 1(a) Commit 2(a) Commit 4");
    expect(t.onMergeCommit).toBe("a"); // cursor rides the merge commit
  });

  test("⇧↑/⇧↓ moves the commit identically to Space-grab (one movement model)", () => {
    const base = () => {
      let s = toggleMerge(at(grouped(), 1));
      return grabMove(at(s, 2), "up"); // group "a" = rows 2..3
    };

    const viaGrab = grabMove(at(base(), 3), "up", 3);
    let viaShift = at(base(), 3);
    for (let i = 0; i < 3; i++) viaShift = applyEvent(viaShift, { type: "shift-arrow-up" });

    expect(shape(viaShift)).toBe(shape(viaGrab));
    expect(viaShift.mode).toBe("normal"); // shift-move is not a mode
  });

  test("⇧↑/⇧↓ is refused when reordering is disabled", () => {
    const s = createInitialState(stack(), {}, { canReorder: false });

    expect(applyEvent(s, { type: "shift-arrow-down" })).toBe(s);
  });
});

describe("cursor — the merge commit is its own stop", () => {
  function twoMemberGroup(): GroupEditorState {
    let s = toggleMerge(at(grouped(), 1));
    s = grabMove(at(s, 2), "up"); // group "a" = rows 2..3
    return { ...s, cursor: 0, onMergeCommit: null };
  }

  function position(s: GroupEditorState): string {
    return s.onMergeCommit ? `MERGE(${s.onMergeCommit})` : `row${s.cursor + 1}`;
  }

  test("↓ visits every member, then the merge commit below them", () => {
    let s = twoMemberGroup();
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = applyEvent(s, { type: "arrow-down" });
      seen.push(position(s));
    }

    // The merge commit is NEWER than its members, so it comes after them.
    expect(seen).toEqual(["row2", "row3", "MERGE(a)", "row4"]);
  });

  test("↑ is the exact mirror of ↓ — no row is ever skipped", () => {
    let s = twoMemberGroup();
    const down: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = applyEvent(s, { type: "arrow-down" });
      down.push(position(s));
    }
    const up: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = applyEvent(s, { type: "arrow-up" });
      up.push(position(s));
    }

    expect(up).toEqual([...down].reverse().slice(1).concat("row1"));
  });

  test("⌃↑/⌃↓ jumps to the next group boundary", () => {
    const s = twoMemberGroup();
    const jumped = applyEvent({ ...s, cursor: 3 }, { type: "ctrl-arrow-up" });

    expect(jumped.cursor).toBeLessThan(3);
  });
});

describe("save-time validation (no silent auto-correction)", () => {
  test("a contiguous group inside one PR unit is valid", () => {
    let s = toggleMerge(at(grouped(), 0));
    s = grabMove(at(s, 1), "up");

    expect(validateMergeGroups(s)).toEqual([]);
  });

  test("a non-contiguous group is reported, not repaired", () => {
    let s = toggleMerge(at(grouped(), 0));
    s = grabMove(at(s, 1), "up");
    s = grabMove(at(s, 2), "up", 1);
    const split = applyEvent(at(s, 1), { type: "shift-arrow-left" });

    const problems = validateMergeGroups(split);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toBe("non-contiguous");
    // The rows keep the user's edit — nothing was rewritten underneath them.
    expect(split.rows.filter((r) => r.mergeLetter === "a")).toHaveLength(2);
  });

  test("a group straddling two PR groups is reported", () => {
    // Commit 3 is in PR group A, Commit 4 is ungrouped (its own PR unit).
    let s = toggleMerge(at(grouped(), 2));
    s = grabMove(at(s, 3), "up"); // Commit 4 joins the merge across the boundary

    const problems = validateMergeGroups(s);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toBe("straddles-pr-groups");
  });

  test("a multi-member group of ungrouped commits straddles PR units", () => {
    // Each ungrouped commit is its own single-commit PR unit.
    let s = createInitialState(stack(), {});
    s = toggleMerge(at(s, 0));
    s = grabMove(at(s, 1), "up");

    expect(validateMergeGroups(s)[0]?.reason).toBe("straddles-pr-groups");
  });

  test("changing a PR group does not silently rewrite the merge axis", () => {
    let s = toggleMerge(at(grouped(), 0));
    s = grabMove(at(s, 1), "up");
    const before = s.rows.map((r) => r.mergeLetter);

    // Pull a member out of PR group A -> now straddling, but untouched.
    const after = applyEvent(at(s, 0), { type: "arrow-left" });

    expect(after.rows.map((r) => r.mergeLetter)).toEqual(before);
    expect(validateMergeGroups(after)).not.toEqual([]);
  });

  test("problems render as a blocking message naming the offending rows", () => {
    let s = toggleMerge(at(grouped(), 2));
    s = grabMove(at(s, 3), "up");
    const problems = validateMergeGroups(s);

    const frame = renderGroupEditor({ ...s, problems }, "feature");

    expect(frame).toContain("Can't save");
    expect(frame).toContain("more than one PR group");
  });
});

describe("axis independence", () => {
  test("creating a merge group leaves PR-group records identical", () => {
    const before = grouped();
    const after = toggleMerge(at(before, 0));

    expect(extractResult(after).updatedRecords).toEqual(extractResult(before).updatedRecords);
  });

  test("a row can be in a PR group, a merge group, both, or neither", () => {
    const s = toggleMerge(at(grouped(), 0));

    expect(s.rows[0]).toMatchObject({ groupLetter: "A", mergeLetter: "a" }); // both
    expect(s.rows[1]).toMatchObject({ groupLetter: "A", mergeLetter: null }); // PR only
    expect(s.rows[3]).toMatchObject({ groupLetter: null, mergeLetter: null }); // neither
  });

  test("an untouched merge axis reports no change (no needless history rewrite)", () => {
    const result = extractResult(applyEvent(grouped(), { type: "arrow-down" }));

    expect(result.mergeChanged).toBe(false);
    expect(result.mergeGroups).toEqual([]);
  });

  test("any merge-axis edit marks the result as needing a rewrite", () => {
    expect(extractResult(toggleMerge(at(grouped(), 0))).mergeChanged).toBe(true);
  });
});

describe("loading existing merge groups", () => {
  test("records round-trip through the editor unchanged", () => {
    const s = createInitialState(
      stack(),
      { g1: { title: "G", members: ["aaa", "bbb", "ccc"] } },
      { mergeGroups: { aaa: "m1", bbb: "m1" }, mergeMessages: { m1: "Existing merge" } },
    );

    expect(s.rows.map((r) => r.mergeLetter)).toEqual(["a", "a", null, null]);
    expect(extractResult(s).mergeGroups).toEqual([
      {
        id: "m1",
        memberIds: ["aaa", "bbb"],
        message: "Existing merge",
        firstSubject: "Commit 1",
        needsMessage: false, // already has a message — no editor pass on save
      },
    ]);
  });

  test("an existing group keeps its id (so its PR identity is stable)", () => {
    let s = createInitialState(stack(), {}, { mergeGroups: { aaa: "m1" } });
    s = grabMove(at(s, 1), "up"); // grow it

    expect(extractResult(s).mergeGroups[0]?.id).toBe("m1");
  });
});

describe("merge message: seed, parse, placeholder", () => {
  test("seeds with the first member's subject and git-style help comments", () => {
    const seed = seedMergeMessage("Add auth");

    expect(seed.split("\n")[0]).toBe("Add auth");
    expect(seed).toContain("# Lines starting with # are ignored.");
  });

  test("splits subject from body and strips comment lines", () => {
    expect(parseMergeMessage("Ship auth\n\nThe body.\n# a comment\n")).toBe(
      "Ship auth\n\nThe body.",
    );
  });

  test("an empty or comments-only message parses as nothing written", () => {
    expect(parseMergeMessage("")).toBeNull();
    expect(parseMergeMessage("# only comments\n\n")).toBeNull();
  });

  test("the placeholder matches what --apply synthesizes", () => {
    // Keeping these identical means the interactive and non-interactive paths
    // produce the same commit (src/commands/group.ts builds `Merge: <subject>`).
    expect(placeholderMergeMessage("Add auth")).toBe("Merge: Add auth");
    expect(placeholderMergeMessage("")).toBe("Merge: changes");
  });

  test("$EDITOR precedence matches git's", () => {
    expect(resolveEditor({ EDITOR: "a", GIT_EDITOR: "b" })).toBe("a");
    expect(resolveEditor({ GIT_EDITOR: "b" })).toBe("b");
    expect(resolveEditor({})).toBe("vi");
  });

  test("creating a group defers its message to save (never prompts mid-edit)", () => {
    const [group] = extractResult(toggleMerge(at(grouped(), 0))).mergeGroups;

    expect(group?.message).toBe("");
    expect(group?.needsMessage).toBe(true);
    expect(group?.firstSubject).toBe("Commit 1");
  });

  test("groups that already have a message need no editor pass", async () => {
    const s = createInitialState(
      stack(),
      {},
      { mergeGroups: { aaa: "m1" }, mergeMessages: { m1: "Existing merge" } },
    );

    // No editor is configured here; if collection tried to spawn one this would
    // hang. It must pass such groups straight through.
    const collected = await collectMergeMessages(extractResult(s).mergeGroups, {
      stdin: process.stdin,
      stdout: process.stdout,
    });

    expect(collected.placeheld).toBe(0);
    expect(collected.mergeGroups[0]?.message).toBe("Existing merge");
  });

  test("closing the editor without writing uses the placeholder, not an abort", async () => {
    // `true` exits 0 without touching the file — an unmodified exit.
    const groups = [
      {
        id: "m1",
        memberIds: ["aaa"],
        message: "",
        firstSubject: "Add auth",
        needsMessage: true,
      },
    ];

    const collected = await collectMergeMessages(
      groups,
      { stdin: process.stdin, stdout: process.stdout },
      { EDITOR: "true" },
    );

    expect(collected.placeheld).toBe(1);
    expect(collected.mergeGroups[0]?.message).toBe("Merge: Add auth");
  });
});

describe("rendering", () => {
  function twoMemberGroup(): GroupEditorState {
    let s = toggleMerge(at(grouped(), 1));
    s = grabMove(at(s, 2), "up");
    return { ...s, cursor: 0, onMergeCommit: null };
  }

  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

  test("the merge commit is drawn BELOW its members (it is the newest of them)", () => {
    const frame = strip(renderGroupEditor(twoMemberGroup(), "feature"))
      .split("\n")
      .filter((l) => l.trim());

    const branch = frame.findIndex((l) => l.includes("├─┐"));
    const firstMember = frame.findIndex((l) => l.includes("Commit 2"));
    const mergeCommit = frame.findIndex((l) => l.includes("●─┘"));

    // Rows print oldest-first, so: branch point, members, then the merge.
    expect(branch).toBeLessThan(firstMember);
    expect(firstMember).toBeLessThan(mergeCommit);
  });

  test("every commit is a node on the graph, merged ones on a second track", () => {
    const frame = strip(renderGroupEditor(twoMemberGroup(), "feature"));

    expect(frame).toMatch(/●\s+Commit 1/); // trunk
    expect(frame).toMatch(/│ ●\s+Commit 2/); // side track
  });

  test("the merge commit inherits its members' PR-group letter", () => {
    const frame = strip(renderGroupEditor(twoMemberGroup(), "feature"));
    const mergeLine = frame.split("\n").find((l) => l.includes("●─┘")) ?? "";

    expect(mergeLine).toContain("[A]");
  });

  test("grabbing the merge commit puts the whole group in the grabbed state", () => {
    // The frame is asserted structurally rather than by ANSI codes: kleur
    // disables colour when stdout is not a TTY, which it never is under the
    // test runner.
    const grabbed = applyEvent(onMergeCommit(twoMemberGroup(), "a"), { type: "space" });

    expect(grabbed.mode).toBe("move");
    expect(grabbed.onMergeCommit).toBe("a");
    // The grab marker sits on the merge-commit line, not on any member row.
    const frame = strip(renderGroupEditor(grabbed, "feature"));
    const mergeLine = frame.split("\n").find((l) => l.includes("●─┘")) ?? "";
    expect(mergeLine.startsWith("●")).toBe(true);
  });
});
