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
