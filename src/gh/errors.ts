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
