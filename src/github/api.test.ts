import { describe, test, expect } from "bun:test";
import { isGitHubUrl } from "./api.ts";

describe("isGitHubUrl", () => {
  describe("GitHub URLs", () => {
    test("detects HTTPS GitHub URL", () => {
      expect(isGitHubUrl("https://github.com/owner/repo.git")).toBe(true);
    });

    test("detects HTTPS GitHub URL without .git suffix", () => {
      expect(isGitHubUrl("https://github.com/owner/repo")).toBe(true);
    });

    test("detects SSH GitHub URL", () => {
      expect(isGitHubUrl("git@github.com:owner/repo.git")).toBe(true);
    });

    test("detects SSH GitHub URL without .git suffix", () => {
      expect(isGitHubUrl("git@github.com:owner/repo")).toBe(true);
    });
  });

  describe("non-GitHub URLs", () => {
    test("rejects local path", () => {
      expect(isGitHubUrl("/tmp/spry-test-origin-abc123")).toBe(false);
    });

    test("rejects file:// URL", () => {
      expect(isGitHubUrl("file:///tmp/spry-test-origin-abc123")).toBe(false);
    });

    test("rejects GitLab URL", () => {
      expect(isGitHubUrl("git@gitlab.com:owner/repo.git")).toBe(false);
    });

    test("rejects Bitbucket URL", () => {
      expect(isGitHubUrl("git@bitbucket.org:owner/repo.git")).toBe(false);
    });

    test("rejects self-hosted git server", () => {
      expect(isGitHubUrl("git@git.company.com:team/project.git")).toBe(false);
    });
  });
});
