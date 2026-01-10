import { test, expect, describe } from "bun:test";
import {
  MARKERS,
  ALPHA_WARNING,
  stripTrailersFromBody,
  generateBodyContent,
  generateStackLinksContent,
  generateFooterContent,
  generateInitialPRBody,
  generateUpdatedPRBody,
  parsePRBody,
  calculateContentHash,
  type StackPRInfo,
} from "./pr-body.ts";
import type { PRUnit, CommitInfo } from "../types.ts";

describe("github/pr-body", () => {
  describe("stripTrailersFromBody", () => {
    test("returns empty string for empty input", () => {
      expect(stripTrailersFromBody("")).toBe("");
    });

    test("returns body without trailers unchanged", () => {
      const body = "This is a description.\n\nWith multiple paragraphs.";
      expect(stripTrailersFromBody(body)).toBe(body);
    });

    test("removes single trailer", () => {
      const body = `Description here.

Spry-Commit-Id: abc123`;
      expect(stripTrailersFromBody(body)).toBe("Description here.");
    });

    test("removes multiple trailers", () => {
      const body = `Description here.

Spry-Commit-Id: abc123
Spry-Group: group-456
Co-authored-by: Alice <alice@example.com>`;
      expect(stripTrailersFromBody(body)).toBe("Description here.");
    });

    test("preserves body content before trailers", () => {
      const body = `First paragraph.

Second paragraph with details.

Spry-Commit-Id: abc123`;
      expect(stripTrailersFromBody(body)).toBe(
        "First paragraph.\n\nSecond paragraph with details.",
      );
    });

    test("handles body with only trailers", () => {
      const body = `Spry-Commit-Id: abc123`;
      // When body is only trailers (no preceding blank line), trailers are stripped
      expect(stripTrailersFromBody(body)).toBe("");
    });

    test("handles trailers with colons in values", () => {
      const body = `Description.

Some-Trailer: value:with:colons`;
      expect(stripTrailersFromBody(body)).toBe("Description.");
    });
  });

  describe("generateBodyContent", () => {
    test("generates content for single commit", () => {
      const unit: PRUnit = {
        type: "single",
        id: "unit-123",
        title: "Add feature",
        commitIds: ["commit-abc"],
        commits: ["abc123"],
        subjects: ["Add feature"],
      };

      const commits: CommitInfo[] = [
        {
          hash: "abc123",
          subject: "Add feature",
          body: "Add feature\n\nThis adds a great new feature.\n\nSpry-Commit-Id: commit-abc",
          trailers: { "Spry-Commit-Id": "commit-abc" },
        },
      ];

      const content = generateBodyContent(unit, commits);
      expect(content).toBe("This adds a great new feature.");
    });

    test("generates content for single commit with no extended body", () => {
      const unit: PRUnit = {
        type: "single",
        id: "unit-123",
        title: "Quick fix",
        commitIds: ["commit-abc"],
        commits: ["abc123"],
        subjects: ["Quick fix"],
      };

      const commits: CommitInfo[] = [
        {
          hash: "abc123",
          subject: "Quick fix",
          body: "Quick fix\n\nSpry-Commit-Id: commit-abc",
          trailers: { "Spry-Commit-Id": "commit-abc" },
        },
      ];

      const content = generateBodyContent(unit, commits);
      expect(content).toBe("");
    });

    test("generates list for group commits", () => {
      const unit: PRUnit = {
        type: "group",
        id: "group-456",
        title: "Auth feature",
        commitIds: ["a1", "b2", "c3"],
        commits: ["aaa111", "bbb222", "ccc333"],
        subjects: ["Start auth feature", "Add login endpoint", "Add 2FA support"],
      };

      const commits: CommitInfo[] = []; // Not used for groups

      const content = generateBodyContent(unit, commits);
      expect(content).toBe("- Start auth feature\n- Add login endpoint\n- Add 2FA support");
    });

    test("handles empty group", () => {
      const unit: PRUnit = {
        type: "group",
        id: "group-empty",
        title: "Empty group",
        commitIds: [],
        commits: [],
        subjects: [],
      };

      const content = generateBodyContent(unit, []);
      expect(content).toBe("");
    });
  });

  describe("generateStackLinksContent", () => {
    test("generates stack links with multiple PRs", () => {
      const stackPRs: StackPRInfo[] = [
        { prNumber: 123, index: 0 },
        { prNumber: 124, index: 1 },
        { prNumber: 125, index: 2 },
      ];

      const content = generateStackLinksContent(stackPRs, 1, "main");

      expect(content).toContain("**Stack** (oldest → newest, targeting `main`):");
      expect(content).toContain("- #123");
      expect(content).toContain("- #124 ← this PR");
      expect(content).toContain("- #125");
    });

    test("marks first PR as current", () => {
      const stackPRs: StackPRInfo[] = [
        { prNumber: 100, index: 0 },
        { prNumber: 101, index: 1 },
      ];

      const content = generateStackLinksContent(stackPRs, 0, "develop");

      expect(content).toContain("- #100 ← this PR");
      expect(content).toContain("- #101");
      expect(content).not.toContain("#101 ← this PR");
    });

    test("marks last PR as current", () => {
      const stackPRs: StackPRInfo[] = [
        { prNumber: 200, index: 0 },
        { prNumber: 201, index: 1 },
      ];

      const content = generateStackLinksContent(stackPRs, 1, "main");

      expect(content).toContain("- #200");
      expect(content).toContain("- #201 ← this PR");
    });

    test("returns empty string for empty stack", () => {
      const content = generateStackLinksContent([], 0, "main");
      expect(content).toBe("");
    });

    test("sorts PRs by index", () => {
      const stackPRs: StackPRInfo[] = [
        { prNumber: 303, index: 2 },
        { prNumber: 301, index: 0 },
        { prNumber: 302, index: 1 },
      ];

      const content = generateStackLinksContent(stackPRs, 1, "main");
      const lines = content.split("\n");

      expect(lines[1]).toContain("#301");
      expect(lines[2]).toContain("#302");
      expect(lines[3]).toContain("#303");
    });
  });

  describe("generateFooterContent", () => {
    test("returns alpha warning", () => {
      const content = generateFooterContent();
      expect(content).toBe(ALPHA_WARNING);
      expect(content).toContain("Spry");
      expect(content).toContain("alpha");
    });
  });

  describe("generateInitialPRBody", () => {
    const singleUnit: PRUnit = {
      type: "single",
      id: "unit-abc",
      title: "Add feature",
      commitIds: ["commit-1"],
      commits: ["abc123"],
      subjects: ["Add feature"],
    };

    const commits: CommitInfo[] = [
      {
        hash: "abc123",
        subject: "Add feature",
        body: "Add feature\n\nThis is the description.",
        trailers: {},
      },
    ];

    test("includes info marker", () => {
      const body = generateInitialPRBody({
        unit: singleUnit,
        commits,
        prTemplateLocation: "afterBody",
        showStackLinks: false,
      });

      expect(body).toContain(MARKERS.INFO);
    });

    test("includes body markers", () => {
      const body = generateInitialPRBody({
        unit: singleUnit,
        commits,
        prTemplateLocation: "afterBody",
        showStackLinks: false,
      });

      expect(body).toContain(MARKERS.BODY_BEGIN);
      expect(body).toContain(MARKERS.BODY_END);
    });

    test("includes footer markers", () => {
      const body = generateInitialPRBody({
        unit: singleUnit,
        commits,
        prTemplateLocation: "afterBody",
        showStackLinks: false,
      });

      expect(body).toContain(MARKERS.FOOTER_BEGIN);
      expect(body).toContain(MARKERS.FOOTER_END);
      expect(body).toContain(ALPHA_WARNING);
    });

    test("includes PR template at afterBody location", () => {
      const body = generateInitialPRBody({
        unit: singleUnit,
        commits,
        prTemplate: "## Checklist\n- [ ] Tests",
        prTemplateLocation: "afterBody",
        showStackLinks: false,
      });

      const bodyEndIndex = body.indexOf(MARKERS.BODY_END);
      const templateIndex = body.indexOf("## Checklist");
      const footerIndex = body.indexOf(MARKERS.FOOTER_BEGIN);

      expect(templateIndex).toBeGreaterThan(bodyEndIndex);
      expect(templateIndex).toBeLessThan(footerIndex);
    });

    test("includes PR template at prepend location", () => {
      const body = generateInitialPRBody({
        unit: singleUnit,
        commits,
        prTemplate: "## Checklist\n- [ ] Tests",
        prTemplateLocation: "prepend",
        showStackLinks: false,
      });

      const templateIndex = body.indexOf("## Checklist");
      const bodyBeginIndex = body.indexOf(MARKERS.BODY_BEGIN);

      expect(templateIndex).toBeLessThan(bodyBeginIndex);
    });

    test("includes PR template at append location", () => {
      const body = generateInitialPRBody({
        unit: singleUnit,
        commits,
        prTemplate: "## Checklist",
        prTemplateLocation: "append",
        showStackLinks: false,
      });

      const footerEndIndex = body.indexOf(MARKERS.FOOTER_END);
      const templateIndex = body.indexOf("## Checklist");

      expect(templateIndex).toBeGreaterThan(footerEndIndex);
    });

    test("includes stack links when enabled", () => {
      const stackPRs: StackPRInfo[] = [
        { prNumber: 10, index: 0 },
        { prNumber: 11, index: 1 },
      ];

      const body = generateInitialPRBody({
        unit: singleUnit,
        commits,
        prTemplateLocation: "afterBody",
        showStackLinks: true,
        stackPRs,
        currentIndex: 0,
        targetBranch: "main",
      });

      expect(body).toContain(MARKERS.STACK_LINKS_BEGIN);
      expect(body).toContain(MARKERS.STACK_LINKS_END);
      expect(body).toContain("#10 ← this PR");
      expect(body).toContain("#11");
    });

    test("excludes stack links when disabled", () => {
      const body = generateInitialPRBody({
        unit: singleUnit,
        commits,
        prTemplateLocation: "afterBody",
        showStackLinks: false,
      });

      expect(body).not.toContain(MARKERS.STACK_LINKS_BEGIN);
      expect(body).not.toContain(MARKERS.STACK_LINKS_END);
    });
  });

  describe("parsePRBody", () => {
    test("parses empty body", () => {
      const parts = parsePRBody("");

      expect(parts.hasInfoMarker).toBe(false);
      expect(parts.bodyContent).toBe("");
      expect(parts.stackLinksContent).toBe("");
      expect(parts.footerContent).toBe("");
    });

    test("detects info marker", () => {
      const body = `${MARKERS.INFO}\n\nSome content`;
      const parts = parsePRBody(body);

      expect(parts.hasInfoMarker).toBe(true);
    });

    test("extracts body content", () => {
      const body = `${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
This is the body content.
${MARKERS.BODY_END}

${MARKERS.FOOTER_BEGIN}
${ALPHA_WARNING}
${MARKERS.FOOTER_END}`;

      const parts = parsePRBody(body);

      expect(parts.bodyContent).toBe("This is the body content.");
    });

    test("extracts stack links content", () => {
      const body = `${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
Body
${MARKERS.BODY_END}

${MARKERS.STACK_LINKS_BEGIN}
**Stack** (oldest → newest, targeting \`main\`):
- #123
- #124 ← this PR
${MARKERS.STACK_LINKS_END}

${MARKERS.FOOTER_BEGIN}
${ALPHA_WARNING}
${MARKERS.FOOTER_END}`;

      const parts = parsePRBody(body);

      expect(parts.stackLinksContent).toContain("#123");
      expect(parts.stackLinksContent).toContain("#124 ← this PR");
    });

    test("extracts user content before info marker", () => {
      const body = `User prepended content here

${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
Body
${MARKERS.BODY_END}`;

      const parts = parsePRBody(body);

      expect(parts.prePreamble).toBe("User prepended content here");
    });

    test("extracts user content after footer", () => {
      const body = `${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
Body
${MARKERS.BODY_END}

${MARKERS.FOOTER_BEGIN}
${ALPHA_WARNING}
${MARKERS.FOOTER_END}

User appended content here`;

      const parts = parsePRBody(body);

      expect(parts.postFooter).toBe("User appended content here");
    });

    test("extracts content between body and stack links", () => {
      const body = `${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
Body content
${MARKERS.BODY_END}

User added template content here

${MARKERS.STACK_LINKS_BEGIN}
Stack links
${MARKERS.STACK_LINKS_END}

${MARKERS.FOOTER_BEGIN}
Footer
${MARKERS.FOOTER_END}`;

      const parts = parsePRBody(body);

      expect(parts.postBody).toBe("User added template content here");
    });
  });

  describe("generateUpdatedPRBody", () => {
    test("preserves user prepended content", () => {
      const existingBody = `My custom header

${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
Old body
${MARKERS.BODY_END}

${MARKERS.FOOTER_BEGIN}
${ALPHA_WARNING}
${MARKERS.FOOTER_END}`;

      const updated = generateUpdatedPRBody({
        existingBody,
        bodyContent: "New body content",
        showStackLinks: false,
      });

      expect(updated).toContain("My custom header");
      expect(updated).toContain("New body content");
    });

    test("preserves user appended content", () => {
      const existingBody = `${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
Old body
${MARKERS.BODY_END}

${MARKERS.FOOTER_BEGIN}
${ALPHA_WARNING}
${MARKERS.FOOTER_END}

My footer notes`;

      const updated = generateUpdatedPRBody({
        existingBody,
        bodyContent: "New body",
        showStackLinks: false,
      });

      expect(updated).toContain("My footer notes");
    });

    test("preserves post-body content (template)", () => {
      const existingBody = `${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
Old body
${MARKERS.BODY_END}

## Checklist
- [x] Tests added

${MARKERS.FOOTER_BEGIN}
${ALPHA_WARNING}
${MARKERS.FOOTER_END}`;

      const updated = generateUpdatedPRBody({
        existingBody,
        bodyContent: "New body",
        showStackLinks: false,
      });

      expect(updated).toContain("## Checklist");
      expect(updated).toContain("- [x] Tests added");
    });

    test("updates stack links content", () => {
      const existingBody = `${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
Body
${MARKERS.BODY_END}

${MARKERS.STACK_LINKS_BEGIN}
Old stack links
${MARKERS.STACK_LINKS_END}

${MARKERS.FOOTER_BEGIN}
${ALPHA_WARNING}
${MARKERS.FOOTER_END}`;

      const updated = generateUpdatedPRBody({
        existingBody,
        bodyContent: "Body",
        stackLinksContent: "New stack links with #123",
        showStackLinks: true,
      });

      expect(updated).toContain("New stack links with #123");
      expect(updated).not.toContain("Old stack links");
    });

    test("adds stack links when previously absent", () => {
      const existingBody = `${MARKERS.INFO}

${MARKERS.BODY_BEGIN}
Body
${MARKERS.BODY_END}

${MARKERS.FOOTER_BEGIN}
${ALPHA_WARNING}
${MARKERS.FOOTER_END}`;

      const updated = generateUpdatedPRBody({
        existingBody,
        bodyContent: "Body",
        stackLinksContent: "Stack: #100, #101",
        showStackLinks: true,
      });

      expect(updated).toContain(MARKERS.STACK_LINKS_BEGIN);
      expect(updated).toContain("Stack: #100, #101");
      expect(updated).toContain(MARKERS.STACK_LINKS_END);
    });
  });

  describe("calculateContentHash", () => {
    test("returns consistent hash for same input", () => {
      const hash1 = calculateContentHash("body content", "stack links");
      const hash2 = calculateContentHash("body content", "stack links");

      expect(hash1).toBe(hash2);
    });

    test("returns different hash for different body", () => {
      const hash1 = calculateContentHash("body A", "stack");
      const hash2 = calculateContentHash("body B", "stack");

      expect(hash1).not.toBe(hash2);
    });

    test("returns different hash for different stack links", () => {
      const hash1 = calculateContentHash("body", "stack A");
      const hash2 = calculateContentHash("body", "stack B");

      expect(hash1).not.toBe(hash2);
    });

    test("returns 16 character hex string", () => {
      const hash = calculateContentHash("test", "content");

      expect(hash).toHaveLength(16);
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });
  });
});
