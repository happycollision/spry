export class GhNotInstalledError extends Error {
  constructor() {
    super(
      "gh CLI not found. Install it:\n" +
        "  brew install gh         # macOS\n" +
        "  apt install gh          # Ubuntu\n" +
        "  https://cli.github.com  # Other",
    );
    this.name = "GhNotInstalledError";
  }
}

export class GhAuthError extends Error {
  constructor(detail: string) {
    super(`GitHub authentication failed: ${detail}\nRun: gh auth login`);
    this.name = "GhAuthError";
  }
}

export type EnrichmentError = "no-gh" | "auth" | "network" | "no-remote";

// Classifies an unknown error thrown by a gh CLI call into an EnrichmentError
// category. The no-remote branch matches gh's stderr when the cwd has no
// GitHub remote; the case-insensitive pattern also covers minor wording
// variations. If gh ever rewords the message we fall through to "network",
// which is an acceptable graceful degradation.
export function classifyGhInfraError(err: unknown): EnrichmentError {
  if (err instanceof GhNotInstalledError) return "no-gh";
  if (err instanceof GhAuthError) return "auth";
  if (err instanceof Error && /no github remotes|not a github/i.test(err.message)) {
    return "no-remote";
  }
  return "network";
}
